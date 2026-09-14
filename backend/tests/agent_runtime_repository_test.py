"""P10 idempotency, transaction and restart-persistence checks."""

from __future__ import annotations

import asyncio
import io
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


async def main() -> int:
    from app.agent_runtime.contracts import RunRequest
    from app.agent_runtime.database import RuntimeDatabase
    from app.agent_runtime.repository import RequestConflict, RuntimeRepository, TransitionConflict

    path = Path(tempfile.mkdtemp(prefix="jarvis_runtime_repository_test_")) / "runtime.db"
    database = RuntimeDatabase(path)
    await database.connect()
    repo = RuntimeRepository(database)
    await repo.create_session(session_id="session-fixture-0001", principal_id="owner", device_id="device")
    request = RunRequest.model_validate({
        "schema_version": 1, "client_request_id": "request-fixture-0001",
        "session_id": "session-fixture-0001", "input": {"text": "inspect fixture"},
    })
    first, created = await repo.submit_run(request, policy_snapshot={}, budget_snapshot={"steps": 3})
    duplicate, created_again = await repo.submit_run(request, policy_snapshot={}, budget_snapshot={"steps": 3})
    conflict = False
    changed = request.model_copy(update={"input": request.input.model_copy(update={"text": "different"})})
    try:
        await repo.submit_run(changed, policy_snapshot={}, budget_snapshot={})
    except RequestConflict:
        conflict = True
    failed_transition = False
    try:
        await repo.transition_with_event(first["id"], expected_status="RUNNING", new_status="FAILED", event_type="run.failed", payload={})
    except TransitionConflict:
        failed_transition = True
    events_before = await repo.list_events(first["id"])
    running = await repo.transition_with_event(first["id"], expected_status="QUEUED", new_status="RUNNING", event_type="run.running", payload={"status": "RUNNING"})
    await database.disconnect()

    reopened = RuntimeDatabase(path)
    await reopened.connect()
    replay = RuntimeRepository(reopened)
    persisted = await replay.get_run(first["id"])
    events = await replay.list_events(first["id"])
    await reopened.disconnect()

    checks = [
        ("first submission creates one run", created and first["status"] == "QUEUED"),
        ("duplicate submission returns same run", not created_again and duplicate["id"] == first["id"]),
        ("same client id with changed content conflicts", conflict),
        ("failed expected-state transition rolls back", failed_transition and len(events_before) == 1),
        ("state and event transition commit together", running["status"] == "RUNNING" and [e["seq"] for e in events] == [1, 2]),
        ("run and events survive database restart", persisted["status"] == "RUNNING" and len(events) == 2),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
