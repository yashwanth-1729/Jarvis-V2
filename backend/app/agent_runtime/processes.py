"""Fixture-safe managed subprocess ownership for the durable runtime.

This is deliberately internal. It accepts an argv supplied by host code, never
model text, and it is not registered as a chat tool or HTTP endpoint. P15 proves
the durable lifetime/accounting boundary before an installer or shell adapter is
allowed to call it.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

import psutil

from app.agent_runtime.database import RuntimeDatabase
from app.agent_runtime.repository import RuntimeRepository, _now


class ResourceBusy(RuntimeError):
    """A named resource is leased by another still-valid managed process."""


class ProcessOwnershipError(RuntimeError):
    """A PID no longer proves it is the process recorded by this handle."""


def _expiry(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")


def _creation_identity(pid: int) -> str:
    """Return a PID-reuse-resistant identity for a process we just created."""
    return f"{pid}:{psutil.Process(pid).create_time():.6f}"


class ManagedProcessService:
    """Own selected harmless subprocesses with durable handle and resource facts."""

    def __init__(self, database: RuntimeDatabase, *, output_root: Path, output_cap_bytes: int = 1_000_000) -> None:
        if output_cap_bytes < 1024:
            raise ValueError("output_cap_bytes must be at least 1024")
        self.database = database
        self.repository = RuntimeRepository(database)
        self.output_root = output_root
        self.output_cap_bytes = output_cap_bytes
        self._live: dict[str, asyncio.subprocess.Process] = {}
        self._windows_jobs: dict[str, int] = {}

    async def start(
        self,
        *,
        run_id: str,
        owner_generation: int,
        operation_id: str,
        argv: Sequence[str],
        working_directory: Path,
        resource_key: str | None = None,
        lease_seconds: int = 300,
    ) -> dict[str, object]:
        """Reserve durable ownership, then start one explicit argv process.

        The RESERVERD record makes a failed spawn observable rather than silently
        disappearing. The resource lease is taken before spawn so conflicting
        package-cache style operations cannot both start.
        """
        if not argv or any(not isinstance(part, str) or not part for part in argv):
            raise ValueError("argv must be a non-empty sequence of non-empty strings")
        if lease_seconds < 1 or lease_seconds > 3600:
            raise ValueError("lease_seconds must be between 1 and 3600")
        process_id, stamp = f"process_{uuid.uuid4().hex}", _now()
        process_dir = self.output_root / process_id
        process_dir.mkdir(parents=True, exist_ok=False)
        stdout_path, stderr_path = process_dir / "stdout.log", process_dir / "stderr.log"
        async with self.database.transaction() as conn:
            run = await (await conn.execute(
                "SELECT owner_generation, status FROM agent_runs WHERE id = ?", (run_id,)
            )).fetchone()
            if run is None or run["owner_generation"] != owner_generation or run["status"] != "RUNNING":
                raise ProcessOwnershipError("Run generation is not an active owner")
            if resource_key is not None:
                existing = await (await conn.execute(
                    "SELECT resource_key FROM resource_leases WHERE resource_key = ? AND expires_at > ?",
                    (resource_key, stamp),
                )).fetchone()
                if existing is not None:
                    raise ResourceBusy(f"Resource is already leased: {resource_key}")
                await conn.execute("DELETE FROM resource_leases WHERE resource_key = ?", (resource_key,))
            await conn.execute(
                """INSERT INTO managed_processes
                   (id, run_id, operation_id, owner_generation, executable_json, working_directory,
                    resource_key, status, stdout_path, stderr_path, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)""",
                (process_id, run_id, operation_id, owner_generation, json.dumps(list(argv)),
                 str(working_directory), resource_key, str(stdout_path), str(stderr_path), stamp),
            )
            if resource_key is not None:
                await conn.execute(
                    """INSERT INTO resource_leases
                       (resource_key, process_id, run_id, owner_generation, expires_at, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (resource_key, process_id, run_id, owner_generation, _expiry(lease_seconds), stamp),
                )
            await self.repository._append_event(  # noqa: SLF001 - atomic control-plane fact
                conn, run_id, "process.reserved", {"process_id": process_id, "operation_id": operation_id}, stamp
            )
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(working_directory),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=os.name != "nt",
            )
            identity = _creation_identity(process.pid)
            if os.name == "nt":
                # P05 already contains the audited ctypes Job Object setup.
                # Reuse it until platform ownership helpers are factored into
                # a neutral module; this manager still owns its handle and
                # closes it at every terminal transition.
                from app.llm.tools_system import _windows_kill_on_close_job

                job = _windows_kill_on_close_job(process.pid)
                if job is not None:
                    self._windows_jobs[process_id] = job
        except BaseException as exc:
            await self._mark_start_failed(process_id, str(exc))
            raise
        self._live[process_id] = process
        async with self.database.transaction() as conn:
            await conn.execute(
                """UPDATE managed_processes SET status = 'RUNNING', pid = ?, creation_identity = ?, started_at = ?
                   WHERE id = ? AND status = 'RESERVED'""",
                (process.pid, identity, _now(), process_id),
            )
            await self.repository._append_event(
                conn, run_id, "process.started", {"process_id": process_id, "pid": process.pid}, _now()
            )
        asyncio.create_task(self._capture(process_id, process))
        return await self.get(process_id)

    async def _capture(self, process_id: str, process: asyncio.subprocess.Process) -> None:
        row = await self.get(process_id)
        stdout_path, stderr_path = Path(str(row["stdout_path"])), Path(str(row["stderr_path"]))
        written, truncated = 0, False

        async def drain(stream: asyncio.StreamReader | None, path: Path) -> None:
            nonlocal written, truncated
            with path.open("wb") as handle:
                while stream is not None:
                    chunk = await stream.read(8192)
                    if not chunk:
                        return
                    remaining = self.output_cap_bytes - written
                    if remaining > 0:
                        part = chunk[:remaining]
                        handle.write(part)
                        written += len(part)
                    if len(chunk) > remaining:
                        truncated = True

        await asyncio.gather(drain(process.stdout, stdout_path), drain(process.stderr, stderr_path), process.wait())
        self._live.pop(process_id, None)
        status = "CANCELLED" if (await self.get(process_id))["status"] == "CANCEL_REQUESTED" else "EXITED"
        await self._finish(process_id, status=status, exit_code=process.returncode, output_bytes=written, truncated=truncated)

    async def cancel(self, process_id: str) -> dict[str, object]:
        row = await self.get(process_id)
        if row["status"] not in {"RESERVED", "RUNNING", "CANCEL_REQUESTED"}:
            return row
        process = self._live.get(process_id)
        if process is None:
            await self._finish(process_id, status="UNKNOWN", exit_code=None, output_bytes=int(row["output_bytes"]), truncated=bool(row["output_truncated"]))
            return await self.get(process_id)
        if row["creation_identity"] != _creation_identity(process.pid):
            raise ProcessOwnershipError("PID creation identity changed; refusing to signal unrelated process")
        async with self.database.transaction() as conn:
            await conn.execute("UPDATE managed_processes SET status = 'CANCEL_REQUESTED' WHERE id = ?", (process_id,))
            await self.repository._append_event(conn, row["run_id"], "process.cancel_requested", {"process_id": process_id}, _now())
        if os.name == "nt":
            job = self._windows_jobs.pop(process_id, None)
            if job is not None:
                from app.llm.tools_system import _close_windows_job

                _close_windows_job(job)
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(process.pid),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
            # Sandboxed/packaged Windows hosts can deny taskkill's broad tree
            # query even for our direct child. The direct asyncio handle is
            # still an owned, creation-identity-checked fallback; never use a
            # stale database PID for this fallback.
            if killer.returncode != 0 and process.returncode is None:
                process.kill()
        else:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        return await self.get(process_id)

    async def _mark_start_failed(self, process_id: str, error: str) -> None:
        async with self.database.transaction() as conn:
            row = await (await conn.execute("SELECT run_id, resource_key FROM managed_processes WHERE id = ?", (process_id,))).fetchone()
            if row is None:
                return
            await conn.execute("UPDATE managed_processes SET status = 'FAILED_TO_START', finished_at = ? WHERE id = ?", (_now(), process_id))
            await conn.execute("DELETE FROM resource_leases WHERE process_id = ?", (process_id,))
            await self.repository._append_event(conn, row["run_id"], "process.failed_to_start", {"process_id": process_id, "error": error[:500]}, _now())

    async def _finish(self, process_id: str, *, status: str, exit_code: int | None, output_bytes: int, truncated: bool) -> None:
        if os.name == "nt":
            job = self._windows_jobs.pop(process_id, None)
            if job is not None:
                from app.llm.tools_system import _close_windows_job

                _close_windows_job(job)
        async with self.database.transaction() as conn:
            row = await (await conn.execute("SELECT run_id FROM managed_processes WHERE id = ?", (process_id,))).fetchone()
            if row is None:
                return
            await conn.execute(
                """UPDATE managed_processes SET status = ?, exit_code = ?, output_bytes = ?, output_truncated = ?, finished_at = ?
                   WHERE id = ?""", (status, exit_code, output_bytes, int(truncated), _now(), process_id)
            )
            await conn.execute("DELETE FROM resource_leases WHERE process_id = ?", (process_id,))
            await self.repository._append_event(conn, row["run_id"], "process.finished", {"process_id": process_id, "status": status, "exit_code": exit_code}, _now())

    async def get(self, process_id: str) -> dict[str, object]:
        conn = self.database._connection  # noqa: SLF001
        if conn is None:
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        row = await (await conn.execute("SELECT * FROM managed_processes WHERE id = ?", (process_id,))).fetchone()
        if row is None:
            raise KeyError(process_id)
        return dict(row)
