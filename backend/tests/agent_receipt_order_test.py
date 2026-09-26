"""A delivered tool-result event must already have a durable receipt.

The SSE consumer may disconnect immediately after receiving ``tool_result``.
This fixture closes the real async generator at precisely that boundary and
asserts the completed action is still in the transcript. It uses a throwaway
SQLite database and a fake provider/tool, so it makes no live request and does
not mutate user data.

    .venv/Scripts/python.exe tests/agent_receipt_order_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_agent_receipt_order_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()

os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
os.environ["JARVIS_SYNC_ENABLED"] = "false"
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ.setdefault("SARVAM_API_KEY", "sarvam-receipt-order-test-not-real")

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


class _EmptyStream:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _ToolProvider:
    name = "receipt-order-fixture"
    model = "receipt-order-fixture"

    def stream(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        return _EmptyStream()

    def last_result(self):  # noqa: ANN201
        from app.providers.base import ChatResult, ToolCall

        return ChatResult(
            tool_calls=[ToolCall(id="fixture-call-1", name="fixture_tool", arguments="{}")],
            finish_reason="tool_calls",
        )


async def main() -> int:
    from app.db import crud
    from app.db.database import db
    from app.llm.tools import ToolOutcome

    await db.connect()

    import app.llm.agent as agent

    async def fake_execute_tool(name, arguments, *, source_turn_ref=None, turn_ref=None):  # noqa: ANN001
        assert (name, arguments, source_turn_ref) == ("fixture_tool", {}, "fixture-call-1")
        return ToolOutcome(content="fixture action completed")

    async def no_candidate(_text: str):
        return None

    agent.get_chat_provider = lambda: _ToolProvider()  # type: ignore[assignment]
    agent.get_english_chat_provider = lambda: _ToolProvider()  # type: ignore[assignment]
    agent.execute_tool = fake_execute_tool  # type: ignore[assignment]
    agent.openai_tools = lambda *a, **k: []  # type: ignore[assignment]
    agent.memory_service.capture_inferred_candidate = no_candidate  # type: ignore[assignment]

    stream = agent.run_turn("Run the receipt-order fixture.")
    event_types: list[str] = []
    async for event in stream:
        event_types.append(event["type"])
        if event["type"] == "tool_result":
            check("tool result reports the completed fixture", event["data"]["ok"] is True)
            break

    # Simulate the client leaving immediately after it sees the result event.
    await stream.aclose()

    rows = await crud.recent_chat_messages(limit=10)
    receipts = [
        row["blocks"]
        for row in rows
        if isinstance(row.get("blocks"), dict) and row["blocks"].get("role") == "tool"
    ]
    check("the result event was reached before generator closure", "tool_result" in event_types)
    check("exactly one tool receipt survived the interruption", len(receipts) == 1, str(receipts))
    if receipts:
        check("receipt keeps the declared call ID", receipts[0].get("tool_call_id") == "fixture-call-1")
        check("receipt keeps the completed outcome", receipts[0].get("content") == "fixture action completed")

    await db.disconnect()
    if TMP_DB.exists():
        TMP_DB.unlink()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
