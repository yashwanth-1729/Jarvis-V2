"""P15 harmless subprocess ownership and resource-lease fixtures only."""

from __future__ import annotations

import asyncio
import io
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


async def _wait_terminal(service, process_id: str) -> dict:  # noqa: ANN001
    for _ in range(100):
        row = await service.get(process_id)
        if row["status"] in {"EXITED", "CANCELLED", "FAILED_TO_START", "UNKNOWN"}:
            return row
        await asyncio.sleep(0.05)
    raise AssertionError(f"Process did not finish: {process_id}")


async def main() -> int:
    from app.agent_runtime.contracts import RunRequest
    from app.agent_runtime.database import RuntimeDatabase
    from app.agent_runtime.processes import ManagedProcessService, ProcessOwnershipError, ResourceBusy
    from app.agent_runtime.repository import RuntimeRepository

    root = Path(tempfile.mkdtemp(prefix="jarvis_runtime_process_test_"))
    database = RuntimeDatabase(root / "runtime.db")
    await database.connect()
    repo = RuntimeRepository(database)
    await repo.create_session(session_id="session-process-0001", principal_id="owner", device_id="device")
    request = RunRequest.model_validate({
        "schema_version": 1, "client_request_id": "process-client-0001", "session_id": "session-process-0001",
        "input": {"text": "fixture process"},
    })
    run, _ = await repo.submit_run(request, policy_snapshot={}, budget_snapshot={})
    claimed = await repo.claim_run(run["id"], worker_id="fixture-worker", lease_seconds=300)
    service = ManagedProcessService(database, output_root=root / "outputs", output_cap_bytes=1024)

    loud = await service.start(
        run_id=run["id"], owner_generation=claimed["owner_generation"], operation_id="process-op-loud",
        argv=[sys.executable, "-c", "import sys; sys.stdout.write('x'*4096)"], working_directory=root,
    )
    loud_done = await _wait_terminal(service, loud["id"])
    stdout = Path(str(loud_done["stdout_path"])).read_bytes()

    sleeper = await service.start(
        run_id=run["id"], owner_generation=claimed["owner_generation"], operation_id="process-op-sleeper",
        argv=[sys.executable, "-c", "import time; time.sleep(30)"], working_directory=root,
        resource_key="package-cache:fixture",
    )
    resource_conflict = False
    try:
        await service.start(
            run_id=run["id"], owner_generation=claimed["owner_generation"], operation_id="process-op-conflict",
            argv=[sys.executable, "-c", "print('never runs')"], working_directory=root,
            resource_key="package-cache:fixture",
        )
    except ResourceBusy:
        resource_conflict = True

    identity_rejected = False
    async with database.transaction() as conn:
        await conn.execute("UPDATE managed_processes SET creation_identity = 'stale:identity' WHERE id = ?", (sleeper["id"],))
    try:
        await service.cancel(sleeper["id"])
    except ProcessOwnershipError:
        identity_rejected = True
    async with database.transaction() as conn:
        row = await (await conn.execute("SELECT pid FROM managed_processes WHERE id = ?", (sleeper["id"],))).fetchone()
        import psutil
        await conn.execute("UPDATE managed_processes SET creation_identity = ? WHERE id = ?", (f"{row['pid']}:{psutil.Process(row['pid']).create_time():.6f}", sleeper["id"]))
    await service.cancel(sleeper["id"])
    cancelled = await _wait_terminal(service, sleeper["id"])
    await database.disconnect()

    checks = [
        ("host-issued process handle records exit", loud_done["status"] == "EXITED" and loud_done["exit_code"] == 0),
        ("output is bounded and marked truncated", len(stdout) == 1024 and loud_done["output_truncated"] == 1),
        ("resource lease blocks conflicting process", resource_conflict),
        ("stale PID creation identity refuses cancellation", identity_rejected),
        ("owned process cancellation is durably reported", cancelled["status"] == "CANCELLED"),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
