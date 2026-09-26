"""Tool-budget exhaustion gets one final answer pass without more actions.

The fake provider asks for a tool on every permitted round, then supplies a
normal final answer only when it sees an empty tool list. This proves the agent
executes exactly the bounded work, requests one tool-free finalization, and
persists a replay-safe final assistant turn. It uses a throwaway DB only.

    .venv/Scripts/python.exe tests/agent_tool_budget_finalization_test.py
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

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_agent_tool_budget_finalization_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()
os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
os.environ["JARVIS_SYNC_ENABLED"] = "false"
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ.setdefault("SARVAM_API_KEY", "sarvam-tool-budget-test-not-real")


class _EmptyStream:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _BudgetProvider:
    name = "tool-budget-fixture"
    model = "tool-budget-fixture"

    def __init__(self) -> None:
        self.tool_lists: list[list[dict]] = []
        self._result = None
        self._round = 0

    def stream(self, _messages, tools, **_kwargs):  # noqa: ANN001
        from app.providers.base import ChatResult, ToolCall

        self.tool_lists.append(list(tools or []))
        self._round += 1
        if tools:
            self._result = ChatResult(
                tool_calls=[
                    ToolCall(
                        id=f"fixture-call-{self._round}",
                        name="fixture_tool",
                        arguments="{}",
                    )
                ],
                finish_reason="tool_calls",
            )
        else:
            self._result = ChatResult(content="All bounded work is complete.", finish_reason="stop")
        return _EmptyStream()

    def last_result(self):  # noqa: ANN201
        return self._result


async def main() -> int:
    from app.core.config import settings
    from app.db import crud
    from app.db.database import db
    from app.llm.tools import ToolOutcome

    await db.connect()
    import app.llm.agent as agent

    provider = _BudgetProvider()
    original_limit = settings.jarvis_max_tool_iterations
    settings.jarvis_max_tool_iterations = 2

    async def fake_execute(name, arguments, *, source_turn_ref=None, turn_ref=None):  # noqa: ANN001
        return ToolOutcome(content=f"{name} completed for {source_turn_ref}")

    async def no_candidate(_text: str):
        return None

    agent.get_chat_provider = lambda: provider  # type: ignore[assignment]
    agent.get_english_chat_provider = lambda: provider  # type: ignore[assignment]
    agent.execute_tool = fake_execute  # type: ignore[assignment]
    agent.openai_tools = lambda *a, **k: [{"type": "function", "function": {"name": "fixture_tool"}}]  # type: ignore[assignment]
    agent.memory_service.capture_inferred_candidate = no_candidate  # type: ignore[assignment]

    try:
        events = [event async for event in agent.run_turn("Finish bounded fixture work.")]
    finally:
        settings.jarvis_max_tool_iterations = original_limit

    kinds = [event["type"] for event in events]
    rows = await crud.recent_chat_messages(limit=20)
    assistants = [row for row in rows if row["role"] == "assistant"]
    final_blocks = assistants[-1]["blocks"] if assistants else {}
    checks = [
        ("exactly two bounded tool results ran", kinds.count("tool_result") == 2, str(kinds)),
        ("one extra provider call finalizes with no tools", len(provider.tool_lists) == 3 and provider.tool_lists[-1] == [], str(provider.tool_lists)),
        ("final answer reaches the user", any(e.get("data", {}).get("text") == "All bounded work is complete." for e in events), str(events)),
        ("turn terminates normally", kinds[-1:] == ["done"], str(kinds)),
        ("final transcript turn has no dangling tool call", isinstance(final_blocks, dict) and not final_blocks.get("tool_calls"), str(final_blocks)),
    ]

    await db.disconnect()
    for suffix in ("", "-wal", "-shm"):
        stale = Path(str(TMP_DB) + suffix)
        if stale.exists():
            stale.unlink()
    for label, passed, detail in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    print("\n" + "=" * 60)
    print(f"{sum(passed for _, passed, _ in checks)}/{len(checks)} checks passed")
    return 0 if all(passed for _, passed, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
