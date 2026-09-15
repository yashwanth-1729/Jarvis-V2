"""Transactional repository for durable agent runs and committed events."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from app.agent_runtime.contracts import RunRequest
from app.agent_runtime.database import RuntimeDatabase


class RequestConflict(ValueError):
    """A client idempotency key was reused with different request content."""


class TransitionConflict(RuntimeError):
    """The durable run state no longer matches the caller's expectation."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class RuntimeRepository:
    def __init__(self, database: RuntimeDatabase) -> None:
        self.database = database

    async def create_session(
        self, *, session_id: str, principal_id: str, device_id: str, title: str = ""
    ) -> None:
        async with self.database.transaction() as conn:
            await conn.execute(
                """INSERT OR IGNORE INTO runtime_sessions
                   (id, principal_id, device_id, title, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (session_id, principal_id, device_id, title, _now()),
            )

    async def submit_run(
        self,
        request: RunRequest,
        *,
        policy_snapshot: dict[str, Any],
        budget_snapshot: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        request_json = _canonical_json(request.model_dump(mode="json"))
        request_hash = hashlib.sha256(request_json.encode("utf-8")).hexdigest()
        stamp = _now()
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """SELECT * FROM agent_runs
                   WHERE session_id = ? AND client_request_id = ?""",
                (request.session_id, request.client_request_id),
            )
            existing = await cursor.fetchone()
            await cursor.close()
            if existing is not None:
                row = dict(existing)
                if row["request_hash"] != request_hash:
                    raise RequestConflict(
                        "client_request_id already belongs to different request content"
                    )
                return row, False

            run_id = f"run_{uuid.uuid4().hex}"
            await conn.execute(
                """INSERT INTO agent_runs
                   (id, session_id, client_request_id, request_hash, schema_version,
                    status, input_json, policy_snapshot, budget_snapshot,
                    created_at, updated_at)
                   VALUES (?, ?, ?, ?, 1, 'QUEUED', ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    request.session_id,
                    request.client_request_id,
                    request_hash,
                    request_json,
                    _canonical_json(policy_snapshot),
                    _canonical_json(budget_snapshot),
                    stamp,
                    stamp,
                ),
            )
            await conn.execute(
                """INSERT INTO agent_events
                   (event_id, run_id, seq, event_type, payload_json, created_at)
                   VALUES (?, ?, 1, 'run.queued', ?, ?)""",
                (
                    f"event_{uuid.uuid4().hex}",
                    run_id,
                    _canonical_json({"status": "QUEUED"}),
                    stamp,
                ),
            )
            cursor = await conn.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,))
            created = dict(await cursor.fetchone())
            await cursor.close()
            return created, True

    async def transition_with_event(
        self,
        run_id: str,
        *,
        expected_status: str,
        new_status: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Commit state and its observable event in one serialized transaction."""
        stamp = _now()
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                "UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
                (new_status, stamp, run_id, expected_status),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(
                    f"run {run_id} is missing or no longer {expected_status}"
                )
            await self._append_event(conn, run_id, event_type, payload, stamp)
        return await self.get_run(run_id)

    async def create_step(
        self,
        run_id: str,
        *,
        ordinal: int,
        step_type: str,
        acceptance: dict[str, Any],
        workflow_version: str,
    ) -> dict[str, Any]:
        stamp = _now()
        step_id = f"step_{uuid.uuid4().hex}"
        async with self.database.transaction() as conn:
            await conn.execute(
                """INSERT INTO agent_steps
                   (id, run_id, ordinal, step_type, status, acceptance_json,
                    dependencies_json, workflow_version, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'READY', ?, '[]', ?, ?, ?)""",
                (
                    step_id, run_id, ordinal, step_type,
                    _canonical_json(acceptance), workflow_version, stamp, stamp,
                ),
            )
            await self._append_event(
                conn, run_id, "step.ready", {"step_id": step_id, "ordinal": ordinal}, stamp
            )
        return (await self.list_steps(run_id))[-1]

    async def transition_step_with_event(
        self,
        run_id: str,
        step_id: str,
        *,
        expected_status: str,
        new_status: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        stamp = _now()
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """UPDATE agent_steps SET status = ?, updated_at = ?
                   WHERE id = ? AND run_id = ? AND status = ?""",
                (new_status, stamp, step_id, run_id, expected_status),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(
                    f"step {step_id} is missing or no longer {expected_status}"
                )
            await self._append_event(conn, run_id, event_type, payload, stamp)
        return next(step for step in await self.list_steps(run_id) if step["id"] == step_id)

    @staticmethod
    async def _append_event(conn, run_id: str, event_type: str, payload: dict[str, Any], stamp: str) -> None:  # noqa: ANN001
        cursor = await conn.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id = ?",
            (run_id,),
        )
        seq = int((await cursor.fetchone())[0])
        await cursor.close()
        await conn.execute(
            """INSERT INTO agent_events
               (event_id, run_id, seq, event_type, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (f"event_{uuid.uuid4().hex}", run_id, seq, event_type, _canonical_json(payload), stamp),
        )

    async def get_run(self, run_id: str) -> dict[str, Any]:
        if self.database._connection is None:  # noqa: SLF001 - same package owner
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        cursor = await self.database._connection.execute(  # noqa: SLF001
            "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        if row is None:
            raise KeyError(run_id)
        return dict(row)

    async def list_events(self, run_id: str, *, after: int = 0) -> list[dict[str, Any]]:
        if self.database._connection is None:  # noqa: SLF001
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        cursor = await self.database._connection.execute(  # noqa: SLF001
            "SELECT * FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq",
            (run_id, after),
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        await cursor.close()
        return rows

    async def list_steps(self, run_id: str) -> list[dict[str, Any]]:
        if self.database._connection is None:  # noqa: SLF001
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        cursor = await self.database._connection.execute(  # noqa: SLF001
            "SELECT * FROM agent_steps WHERE run_id = ? ORDER BY ordinal", (run_id,)
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        await cursor.close()
        return rows
