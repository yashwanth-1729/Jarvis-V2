"""P12 read-only worker vertical-slice checks."""

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
    from app.agent_runtime.repository import RuntimeRepository
    from app.agent_runtime.worker import ReadOnlyFixtureAdapter, ReadOnlyWorker

    path = Path(tempfile.mkdtemp(prefix="jarvis_runtime_worker_test_")) / "runtime.db"
    database = RuntimeDatabase(path)
    await database.connect()
    repo = RuntimeRepository(database)
    await repo.create_session(session_id="session-worker-0001", principal_id="owner", device_id="device")

    async def submit(client_id: str, text: str):
        request = RunRequest.model_validate({
            "schema_version": 1, "client_request_id": client_id,
            "session_id": "session-worker-0001", "input": {"text": text},
        })
        return (await repo.submit_run(request, policy_snapshot={"read_only": True}, budget_snapshot={"max_steps": 1}))[0]

    success = await submit("request-worker-good", "fixture:status")
    adapter = ReadOnlyFixtureAdapter({"fixture:status": "fixture is healthy"})
    worker = ReadOnlyWorker(repo, adapter)
    completed = await worker.run(success["id"])
    repeated = await worker.run(success["id"])
    steps = await repo.list_steps(success["id"])
    events = await repo.list_events(success["id"])

    failure = await submit("request-worker-missing", "fixture:missing")
    failed = await worker.run(failure["id"])
    failed_steps = await repo.list_steps(failure["id"])
    await database.disconnect()

    event_types = [event["event_type"] for event in events]
    checks = [
        ("read-only run reaches verified completion", completed["status"] == "COMPLETED" and steps[0]["status"] == "VERIFIED"),
        ("workflow records ordered lifecycle events", event_types == ["run.queued", "run.running", "step.ready", "step.running", "step.verified", "run.completed"]),
        ("terminal rerun is idempotent", repeated["status"] == "COMPLETED" and adapter.calls == 2),
        ("one bounded step is created", len(steps) == 1 and steps[0]["workflow_version"] == "readonly-fixture-v1"),
        ("missing observation fails honestly", failed["status"] == "FAILED" and failed_steps[0]["status"] == "FAILED"),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
