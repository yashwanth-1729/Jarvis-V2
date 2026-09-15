"""Transactional repository for durable agent runs and committed events."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from app.agent_runtime.contracts import RunRequest
from app.agent_runtime.database import RuntimeDatabase


class RequestConflict(ValueError):
    """A client idempotency key was reused with different request content."""


class TransitionConflict(RuntimeError):
    """The durable run state no longer matches the caller's expectation.

    Raised for an ordinary expected-status mismatch AND for a lease/generation
    mismatch (see `expected_generation` on the transition methods, and
    `claim_run`/`reclaim_stale_run`). Callers must treat both the same way:
    stop, make no further writes, and re-read the durable state -- never
    retry with a forced status (playbook 10.3, 10.5).
    """


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _expires_at(lease_seconds: int) -> str:
    stamp = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


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

    async def claim_run(
        self, run_id: str, *, worker_id: str, lease_seconds: int
    ) -> dict[str, Any]:
        """Atomically admit a QUEUED run, fencing every later write to this generation.

        Exactly one caller wins a concurrent admission race: the UPDATE's
        `WHERE status = 'QUEUED'` predicate only ever matches once, and SQLite
        serializes writers through `RuntimeDatabase.transaction()`. The loser
        gets `TransitionConflict` and must not retry with a forced status.
        """
        stamp = _now()
        lease_expires_at = _expires_at(lease_seconds)
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """UPDATE agent_runs
                   SET status = 'RUNNING', owner_generation = owner_generation + 1,
                       lease_owner = ?, lease_expires_at = ?, updated_at = ?,
                       started_at = COALESCE(started_at, ?)
                   WHERE id = ? AND status = 'QUEUED'""",
                (worker_id, lease_expires_at, stamp, stamp, run_id),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(f"run {run_id} is missing or no longer QUEUED")
            row = await self._fetch_run(conn, run_id)
            await self._append_event(
                conn, run_id, "run.running",
                {"status": "RUNNING", "lease_owner": worker_id, "owner_generation": row["owner_generation"]},
                stamp,
            )
        return row

    async def reclaim_stale_run(
        self, run_id: str, *, worker_id: str, lease_seconds: int
    ) -> dict[str, Any]:
        """Take over a RUNNING run whose lease has already expired.

        The only legal takeover path (playbook 10.3): a lease that has not
        expired refuses the reclaim with `TransitionConflict` even for a
        different `worker_id` -- an active owner is never interrupted just
        because a second worker asks.
        """
        stamp = _now()
        lease_expires_at = _expires_at(lease_seconds)
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """UPDATE agent_runs
                   SET owner_generation = owner_generation + 1, lease_owner = ?,
                       lease_expires_at = ?, updated_at = ?
                   WHERE id = ? AND status = 'RUNNING'
                     AND lease_expires_at IS NOT NULL AND lease_expires_at < ?""",
                (worker_id, lease_expires_at, stamp, run_id, stamp),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(f"run {run_id} is not RUNNING with an expired lease")
            row = await self._fetch_run(conn, run_id)
            await self._append_event(
                conn, run_id, "run.recovered",
                {"status": "RUNNING", "lease_owner": worker_id, "owner_generation": row["owner_generation"]},
                stamp,
            )
        return row

    async def renew_lease(
        self, run_id: str, *, worker_id: str, owner_generation: int, lease_seconds: int
    ) -> dict[str, Any]:
        """Extend a held lease. Only the current owner's exact generation may renew."""
        stamp = _now()
        lease_expires_at = _expires_at(lease_seconds)
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """UPDATE agent_runs SET lease_expires_at = ?, updated_at = ?
                   WHERE id = ? AND status = 'RUNNING' AND lease_owner = ? AND owner_generation = ?""",
                (lease_expires_at, stamp, run_id, worker_id, owner_generation),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(f"run {run_id} lease is no longer held at generation {owner_generation}")
            return await self._fetch_run(conn, run_id)

    async def request_cancel(self, run_id: str, *, reason: str = "") -> dict[str, Any]:
        """Ask a run to stop, without needing to hold its lease.

        Cancellation does not require ownership by design (playbook 10.6):
        the owning worker never polls a shared flag, it just discovers this
        the next time one of its own generation-fenced writes fails, because
        this flips `status` away from what that write expects. There is no
        window where the worker can observe RUNNING and write anyway.
        """
        stamp = _now()
        async with self.database.transaction() as conn:
            cursor = await conn.execute(
                """UPDATE agent_runs SET status = 'CANCEL_REQUESTED', updated_at = ?
                   WHERE id = ? AND status IN (
                       'QUEUED', 'RUNNING', 'WAITING_USER', 'WAITING_APPROVAL',
                       'WAITING_RESOURCE', 'PAUSED'
                   )""",
                (stamp, run_id),
            )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(f"run {run_id} cannot be cancelled from its current state")
            await self._append_event(conn, run_id, "run.cancel_requested", {"reason": reason[:500]}, stamp)
        return await self.get_run(run_id)

    async def transition_with_event(
        self,
        run_id: str,
        *,
        expected_status: str,
        new_status: str,
        event_type: str,
        payload: dict[str, Any],
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        """Commit state and its observable event in one serialized transaction.

        `expected_generation`, when given, fences the write to a specific
        lease holder: a worker that lost its lease (reclaimed as stale, or
        never held it) gets `TransitionConflict` here instead of silently
        overwriting a newer generation's outcome.
        """
        stamp = _now()
        async with self.database.transaction() as conn:
            if expected_generation is None:
                cursor = await conn.execute(
                    "UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
                    (new_status, stamp, run_id, expected_status),
                )
            else:
                cursor = await conn.execute(
                    """UPDATE agent_runs SET status = ?, updated_at = ?
                       WHERE id = ? AND status = ? AND owner_generation = ?""",
                    (new_status, stamp, run_id, expected_status, expected_generation),
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
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        """Insert the run's next step.

        `expected_generation`, when given, makes the insert itself
        generation-fenced (via `INSERT ... SELECT ... WHERE`): a worker that
        lost its lease between claiming the run and creating this step cannot
        insert a step a newer owner does not know about. Without it, the
        `UNIQUE(run_id, ordinal)` constraint still stops an exact duplicate,
        but as an `IntegrityError`, not the same `TransitionConflict` every
        other lease failure raises -- callers that pass a generation get one
        uniform exception to handle.
        """
        stamp = _now()
        step_id = f"step_{uuid.uuid4().hex}"
        async with self.database.transaction() as conn:
            if expected_generation is None:
                cursor = await conn.execute(
                    """INSERT INTO agent_steps
                       (id, run_id, ordinal, step_type, status, acceptance_json,
                        dependencies_json, workflow_version, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'READY', ?, '[]', ?, ?, ?)""",
                    (
                        step_id, run_id, ordinal, step_type,
                        _canonical_json(acceptance), workflow_version, stamp, stamp,
                    ),
                )
            else:
                cursor = await conn.execute(
                    """INSERT INTO agent_steps
                       (id, run_id, ordinal, step_type, status, acceptance_json,
                        dependencies_json, workflow_version, created_at, updated_at)
                       SELECT ?, ?, ?, ?, 'READY', ?, '[]', ?, ?, ?
                       WHERE EXISTS (
                           SELECT 1 FROM agent_runs WHERE id = ? AND owner_generation = ?
                       )""",
                    (
                        step_id, run_id, ordinal, step_type,
                        _canonical_json(acceptance), workflow_version, stamp, stamp,
                        run_id, expected_generation,
                    ),
                )
                if cursor.rowcount != 1:
                    await cursor.close()
                    raise TransitionConflict(
                        f"run {run_id} is no longer at generation {expected_generation}"
                    )
            await cursor.close()
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
        expected_generation: int | None = None,
        require_run_status: str = "RUNNING",
    ) -> dict[str, Any]:
        """Commit a step transition, optionally fenced to the run's owning generation.

        The fence checks the PARENT run is still at `require_run_status`
        (default `RUNNING`) at that exact generation -- not just the
        generation number -- so a `request_cancel` (which changes `status`,
        never `owner_generation`) also blocks this write. That is the entire
        cancellation mechanism for ordinary forward progress: no shared flag
        is polled anywhere, a cancelled run's next step write just fails here.

        `require_run_status="CANCEL_REQUESTED"` is the one deliberate
        exception: cancellation's own finalizer (see `ReadOnlyWorker.
        _finalize_cancelled`) must be able to mark an in-flight step
        UNCERTAIN precisely while the run sits in CANCEL_REQUESTED, which the
        default predicate would otherwise itself block.
        """
        stamp = _now()
        async with self.database.transaction() as conn:
            if expected_generation is None:
                cursor = await conn.execute(
                    """UPDATE agent_steps SET status = ?, updated_at = ?
                       WHERE id = ? AND run_id = ? AND status = ?""",
                    (new_status, stamp, step_id, run_id, expected_status),
                )
            else:
                cursor = await conn.execute(
                    """UPDATE agent_steps SET status = ?, updated_at = ?
                       WHERE id = ? AND run_id = ? AND status = ?
                         AND EXISTS (
                             SELECT 1 FROM agent_runs
                             WHERE id = ? AND status = ? AND owner_generation = ?
                         )""",
                    (new_status, stamp, step_id, run_id, expected_status, run_id, require_run_status, expected_generation),
                )
            changed = cursor.rowcount
            await cursor.close()
            if changed != 1:
                raise TransitionConflict(
                    f"step {step_id} is missing, no longer {expected_status}, or the run lost its lease"
                )
            await self._append_event(conn, run_id, event_type, payload, stamp)
        return next(step for step in await self.list_steps(run_id) if step["id"] == step_id)

    @staticmethod
    async def _fetch_run(conn, run_id: str) -> dict[str, Any]:  # noqa: ANN001
        """Read a run inside an already-open transaction (same connection, no new lock)."""
        cursor = await conn.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,))
        row = await cursor.fetchone()
        await cursor.close()
        if row is None:
            raise KeyError(run_id)
        return dict(row)

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

    async def list_runs_by_status(self, status: str) -> list[dict[str, Any]]:
        """Recovery entry point: every run a restarting worker must reconcile."""
        if self.database._connection is None:  # noqa: SLF001
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        cursor = await self.database._connection.execute(  # noqa: SLF001
            "SELECT * FROM agent_runs WHERE status = ? ORDER BY updated_at", (status,)
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        await cursor.close()
        return rows
