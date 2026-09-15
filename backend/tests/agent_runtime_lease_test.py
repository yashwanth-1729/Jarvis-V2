"""P13 ownership, recovery and cancellation fault-injection checks.

Isolated fixture database only -- no application/personal data, matching
every other agent_runtime_*_test.py. Run:
    .venv/Scripts/python -B tests/agent_runtime_lease_test.py
"""

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
    from app.agent_runtime.repository import RuntimeRepository, TransitionConflict
    from app.agent_runtime.worker import ReadOnlyFixtureAdapter, ReadOnlyWorker

    path = Path(tempfile.mkdtemp(prefix="jarvis_runtime_lease_test_")) / "runtime.db"
    database = RuntimeDatabase(path)
    await database.connect()
    repo = RuntimeRepository(database)
    await repo.create_session(session_id="session-lease-0001", principal_id="owner", device_id="device")

    async def submit(client_id: str, text: str) -> dict:
        request = RunRequest.model_validate({
            "schema_version": 1, "client_request_id": client_id,
            "session_id": "session-lease-0001", "input": {"text": text},
        })
        return (await repo.submit_run(request, policy_snapshot={"read_only": True}, budget_snapshot={"max_steps": 1}))[0]

    checks: list[tuple[str, bool]] = []

    # -- competing workers: only one admission wins a fresh QUEUED run ------
    contested = await submit("request-contested", "fixture:alpha")
    adapter_a = ReadOnlyFixtureAdapter({"fixture:alpha": "alpha observation"})
    adapter_b = ReadOnlyFixtureAdapter({"fixture:alpha": "alpha observation"})
    worker_a = ReadOnlyWorker(repo, adapter_a, worker_id="worker-a")
    worker_b = ReadOnlyWorker(repo, adapter_b, worker_id="worker-b")
    claim_a, claim_b = None, None
    try:
        claim_a = await repo.claim_run(contested["id"], worker_id="worker-a", lease_seconds=30)
    except TransitionConflict:
        pass
    try:
        claim_b = await repo.claim_run(contested["id"], worker_id="worker-b", lease_seconds=30)
    except TransitionConflict:
        pass
    checks.append((
        "competing admission: exactly one worker wins",
        (claim_a is not None) != (claim_b is not None),
    ))
    winner = claim_a or claim_b
    finished = await (worker_a if claim_a else worker_b)._execute(winner)  # noqa: SLF001 - test drives the won claim directly
    checks.append(("winner completes the run it claimed", finished["status"] == "COMPLETED"))

    # -- stale generation: a lagging worker's write is rejected, not merged -
    stale_generation_run = await submit("request-stale-gen", "fixture:beta")
    live = ReadOnlyWorker(repo, ReadOnlyFixtureAdapter({"fixture:beta": "beta observation"}), worker_id="worker-live")
    claimed = await repo.claim_run(stale_generation_run["id"], worker_id="worker-live", lease_seconds=30)
    stale_generation = claimed["owner_generation"] - 1  # a generation this run already moved past
    stale_write_rejected = False
    try:
        await repo.transition_with_event(
            stale_generation_run["id"], expected_status="RUNNING", new_status="COMPLETED",
            event_type="run.completed", payload={"status": "COMPLETED", "summary": "forged by a stale worker"},
            expected_generation=stale_generation,
        )
    except TransitionConflict:
        stale_write_rejected = True
    real_finish = await live._execute(claimed)
    checks.append(("stale-generation write is rejected, not merged", stale_write_rejected))
    checks.append(("legitimate owner still completes normally", real_finish["status"] == "COMPLETED"))

    # -- expired lease: only a truly expired lease may be reclaimed ---------
    active_lease_run = await submit("request-active-lease", "fixture:gamma")
    active_claim = await repo.claim_run(active_lease_run["id"], worker_id="worker-active", lease_seconds=30)
    active_reclaim_blocked = False
    try:
        await repo.reclaim_stale_run(active_lease_run["id"], worker_id="worker-thief", lease_seconds=30)
    except TransitionConflict:
        active_reclaim_blocked = True
    checks.append(("an active (non-expired) lease cannot be reclaimed", active_reclaim_blocked))

    expired_lease_run = await submit("request-expired-lease", "fixture:delta")
    # A negative lease duration expires immediately -- avoids sleeping in a test.
    expired_claim = await repo.claim_run(expired_lease_run["id"], worker_id="worker-original", lease_seconds=-1)
    reclaimed = await repo.reclaim_stale_run(expired_lease_run["id"], worker_id="worker-recovery", lease_seconds=30)
    checks.append((
        "an expired lease is reclaimed with a bumped generation",
        reclaimed["lease_owner"] == "worker-recovery" and reclaimed["owner_generation"] == expired_claim["owner_generation"] + 1,
    ))
    original_write_after_reclaim_rejected = False
    try:
        await repo.transition_with_event(
            expired_lease_run["id"], expected_status="RUNNING", new_status="COMPLETED",
            event_type="run.completed", payload={"status": "COMPLETED"},
            expected_generation=expired_claim["owner_generation"],
        )
    except TransitionConflict:
        original_write_after_reclaim_rejected = True
    checks.append(("the original (now-stale) owner cannot write after reclaim", original_write_after_reclaim_rejected))

    # -- disconnect / restart recovery: resumes to a correct terminal state -
    interrupted_run = await submit("request-interrupted", "fixture:epsilon")
    crash_adapter = ReadOnlyFixtureAdapter({"fixture:epsilon": "epsilon observation"})
    crash_worker = ReadOnlyWorker(repo, crash_adapter, worker_id="worker-before-crash")
    crash_claim = await repo.claim_run(interrupted_run["id"], worker_id="worker-before-crash", lease_seconds=-1)
    # Simulate a crash after the step reaches RUNNING but before verification:
    # create+advance the step by hand, then abandon it (never call the adapter).
    crash_step = await repo.create_step(
        interrupted_run["id"], ordinal=0, step_type="TOOL",
        acceptance={"kind": "non_empty_observation"}, workflow_version=ReadOnlyWorker.WORKFLOW_VERSION,
        expected_generation=crash_claim["owner_generation"],
    )
    await repo.transition_step_with_event(
        interrupted_run["id"], crash_step["id"], expected_status="READY", new_status="RUNNING",
        event_type="step.running", payload={"step_id": crash_step["id"]},
        expected_generation=crash_claim["owner_generation"],
    )
    recovery_worker = ReadOnlyWorker(repo, crash_adapter, worker_id="worker-after-restart")
    recovered = await recovery_worker.recover_stale_runs()
    recovered_this_run = next((r for r in recovered if r["id"] == interrupted_run["id"]), None)
    checks.append((
        "a run interrupted mid-step is recovered to completion after restart",
        recovered_this_run is not None and recovered_this_run["status"] == "COMPLETED",
    ))
    checks.append((
        "recovery re-ran the fixture exactly once for the interrupted step",
        crash_adapter.calls == 1,
    ))

    # -- cancellation before any action: the adapter is never called --------
    precancel_run = await submit("request-precancel", "fixture:zeta")
    precancel_adapter = ReadOnlyFixtureAdapter({"fixture:zeta": "zeta observation"})
    precancel_worker = ReadOnlyWorker(repo, precancel_adapter, worker_id="worker-precancel")
    await repo.request_cancel(precancel_run["id"], reason="user changed their mind")
    precancel_result = await precancel_worker.run(precancel_run["id"])
    checks.append((
        "cancelling before admission finalizes CANCELLED with no adapter call",
        precancel_result["status"] == "CANCELLED" and precancel_adapter.calls == 0,
    ))

    # -- cancellation racing an in-flight (uncertain) action -----------------
    class CancelMidFlightAdapter:
        """A fixture whose own `observe()` triggers the race it is testing."""

        def __init__(self, repository: RuntimeRepository, run_id: str, value: str) -> None:
            self.repository = repository
            self.run_id = run_id
            self.value = value
            self.calls = 0

        async def observe(self, query: str) -> str:  # noqa: ARG002 - fixture signature match
            self.calls += 1
            # The action "happens" (a real adapter would have produced its
            # effect by now) before the cancellation request is durably
            # recorded -- exactly the ordering that makes the result UNCERTAIN
            # rather than cleanly CANCELLED-before-anything-happened.
            await self.repository.request_cancel(self.run_id, reason="cancelled mid-flight")
            return self.value

    midflight_run = await submit("request-midflight-cancel", "fixture:eta")
    midflight_adapter = CancelMidFlightAdapter(repo, midflight_run["id"], "eta observation, mid-flight")
    midflight_worker = ReadOnlyWorker(repo, midflight_adapter, worker_id="worker-midflight")
    midflight_result = await midflight_worker.run(midflight_run["id"])
    midflight_steps = await repo.list_steps(midflight_run["id"])
    checks.append((
        "a cancel racing an in-flight action lands on CANCELLED, not COMPLETED",
        midflight_result["status"] == "CANCELLED",
    ))
    checks.append((
        "the in-flight step is marked UNCERTAIN, not silently dropped or verified",
        len(midflight_steps) == 1 and midflight_steps[0]["status"] == "UNCERTAIN",
    ))
    midflight_events = [e["event_type"] for e in await repo.list_events(midflight_run["id"])]
    checks.append((
        "the uncertain outcome is recorded as a distinct event, not a plain success",
        "step.uncertain" in midflight_events and "run.cancelled" in midflight_events
        and "run.completed" not in midflight_events,
    ))

    await database.disconnect()

    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
