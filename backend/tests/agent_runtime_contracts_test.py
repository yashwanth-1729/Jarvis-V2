"""Offline boundary tests for P09 durable-runtime contracts.

No worker, provider, filesystem artifact, or personal database is involved.
Run with `.venv/Scripts/python.exe tests/agent_runtime_contracts_test.py`.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from app.agent_runtime.contracts import ActionProposal, RunRequest, ToolReceipt  # noqa: E402


def rejects(label: str, factory) -> bool:  # noqa: ANN001
    try:
        factory()
    except ValidationError:
        print(f"  [PASS] {label}")
        return True
    print(f"  [FAIL] {label}")
    return False


def main() -> int:
    valid = {
        "schema_version": 1,
        "client_request_id": "client-request-0001",
        "session_id": "session-issued-0001",
        "input": {"text": "Create a fixture draft", "language": "en-IN"},
        "requested_mode": "draft_only",
        "execution_policy": "continue_without_ui",
        "budget_profile": "standard",
    }
    request = RunRequest.model_validate(valid)
    adapter = TypeAdapter(ActionProposal)
    proposal = adapter.validate_python({
        "kind": "tool", "step_id": "step-issued-0001", "tool_name": "browser.inspect",
        "arguments": {}, "purpose": "Inspect fixture", "expected_observation": "A page is visible",
    })
    receipt = ToolReceipt.model_validate({
        "schema_version": 1, "operation_id": "operation-0001", "attempt_id": "attempt-0001",
        "status": "succeeded", "effect_state": "none", "started_at": "2026-09-14T00:00:00Z",
        "finished_at": "2026-09-14T00:00:01Z",
    })
    checks = [
        ("valid client request retains host-neutral preferences", request.requested_mode.value == "draft_only"),
        ("tool proposal is discriminated by kind", proposal.kind == "tool"),
        ("receipt separates execution from effect state", receipt.effect_state.value == "none"),
        ("unknown client authority fields are rejected", rejects("unknown client authority fields are rejected", lambda: RunRequest.model_validate({**valid, "approved": True}))),
        ("string schema version cannot coerce into authority", rejects("string schema version cannot coerce into authority", lambda: RunRequest.model_validate({**valid, "schema_version": "1"}))),
        ("proposal cannot claim approval", rejects("proposal cannot claim approval", lambda: adapter.validate_python({"kind": "tool", "step_id": "step-issued-0001", "tool_name": "x", "arguments": {}, "purpose": "x", "expected_observation": "x", "approved": True}))),
    ]
    for label, passed in checks[:3]:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print("\n" + "=" * 60)
    print(f"{sum(passed for _, passed in checks)}/{len(checks)} checks passed")
    return 0 if all(passed for _, passed in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
