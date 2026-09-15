"""P14 exact-effect, replay, expiry and local-pairing adversarial checks."""

from __future__ import annotations

import asyncio
import io
import sys
import tempfile
from pathlib import Path

from pydantic import ValidationError

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


async def main() -> int:
    from app.agent_runtime.approvals import (
        ApprovalError, ApprovalService, AuthenticationError, AuthorizationError, LocalAuthenticator,
    )
    from app.agent_runtime.contracts import ApprovalDecision, ApprovalRequest
    from app.agent_runtime.database import RuntimeDatabase
    from app.agent_runtime.repository import RuntimeRepository

    database = RuntimeDatabase(Path(tempfile.mkdtemp(prefix="jarvis_runtime_approval_test_")) / "runtime.db")
    await database.connect()
    repo = RuntimeRepository(database)
    await repo.create_session(session_id="session-approval-0001", principal_id="owner", device_id="device")
    service = ApprovalService(repo)

    async def new_run(run_id: str):
        async with database.transaction() as conn:
            stamp = "2026-09-15T00:00:00Z"
            await conn.execute(
                """INSERT INTO agent_runs (id, session_id, client_request_id, request_hash, schema_version, status,
                   input_json, policy_snapshot, budget_snapshot, created_at, updated_at)
                   VALUES (?, 'session-approval-0001', ?, ?, 1, 'QUEUED', '{}', '{}', '{}', ?, ?)""",
                (run_id, f"client-{run_id}", f"hash-{run_id}", stamp, stamp),
            )
    await new_run("run-approval-0001")
    await new_run("run-approval-0002")
    request = ApprovalRequest.model_validate({
        "schema_version": 1, "operation_id": "operation-approval-1", "tool_name": "browser.submit",
        "tool_version": "1", "effect_class": "EXTERNAL_COMMIT", "scope": {"profile": "fixture"},
        "target": {"recipient": "alice@example.test"}, "content_hash": "a" * 64,
        "preconditions": {"draft": "v1"}, "summary": "Send fixture email to Alice",
    })
    approval = await service.propose(run_id="run-approval-0001", principal_id="owner", request=request)
    granted = await service.decide(approval["id"], principal_id="owner", decision=ApprovalDecision.GRANT)
    consumed = await service.consume_for_dispatch(approval["id"], run_id="run-approval-0001", principal_id="owner", request=request)

    replay_rejected = changed_rejected = cross_run_rejected = forged_rejected = expired_rejected = False
    try:
        await service.consume_for_dispatch(approval["id"], run_id="run-approval-0001", principal_id="owner", request=request)
    except ApprovalError:
        replay_rejected = True
    changed = request.model_copy(update={"target": {"recipient": "bob@example.test"}})
    fresh_request = request.model_copy(update={"operation_id": "operation-approval-2"})
    fresh = await service.propose(run_id="run-approval-0001", principal_id="owner", request=fresh_request)
    await service.decide(fresh["id"], principal_id="owner", decision=ApprovalDecision.GRANT)
    try:
        await service.consume_for_dispatch(fresh["id"], run_id="run-approval-0001", principal_id="owner", request=changed.model_copy(update={"operation_id": "operation-approval-2"}))
    except ApprovalError:
        changed_rejected = True
    try:
        await service.consume_for_dispatch(fresh["id"], run_id="run-approval-0002", principal_id="owner", request=request)
    except AuthorizationError:
        cross_run_rejected = True
    try:
        ApprovalRequest.model_validate({**request.model_dump(mode="json"), "confirmed": True})
    except ValidationError:
        forged_rejected = True

    expiring_request = request.model_copy(update={"operation_id": "operation-approval-3"})
    expiring = await service.propose(
        run_id="run-approval-0001", principal_id="owner", request=expiring_request, expires_in_seconds=1
    )
    await service.decide(expiring["id"], principal_id="owner", decision=ApprovalDecision.GRANT)
    async with database.transaction() as conn:
        await conn.execute("UPDATE agent_approvals SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?", (expiring["id"],))
    try:
        await service.consume_for_dispatch(
            expiring["id"], run_id="run-approval-0001", principal_id="owner", request=expiring_request
        )
    except ApprovalError:
        expired_rejected = True

    auth = LocalAuthenticator("fixture-bootstrap")
    bearer = auth.pair("fixture-bootstrap", principal_id="owner")
    auth_ok = auth.authenticate(bearer) == "owner"
    bad_auth = False
    try:
        auth.pair("wrong", principal_id="owner")
    except AuthenticationError:
        bad_auth = True
    await database.disconnect()
    checks = [
        ("grant is recorded before dispatch", granted["status"] == "GRANTED"),
        ("dispatch consumes exact approval once", consumed["status"] == "CONSUMED"),
        ("replayed approval is rejected", replay_rejected),
        ("changed recipient invalidates approval", changed_rejected),
        ("cross-run approval is rejected", cross_run_rejected),
        ("model confirmed=true is not an approval field", forged_rejected),
        ("expired grant cannot dispatch", expired_rejected),
        ("local pairing token authenticates exact principal", auth_ok and bad_auth),
    ]
    for label, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return 0 if all(ok for _, ok in checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
