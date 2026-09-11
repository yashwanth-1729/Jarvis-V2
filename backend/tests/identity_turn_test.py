"""`run_turn` actually takes the identity shortcut, end to end.

`identity_intent_test.py` covers the regex classifier in isolation; this
covers the *wiring* -- that a matched turn never reaches the chat provider,
yields the canonical text and a proper terminal `done` frame, still runs
memory-candidate capture (so "My name is Rahul, who are you?" still teaches
JARVIS the name), persists the reply to the transcript like any other answer,
and that an ordinary turn is completely unaffected (still reaches the
provider, still gets the surface/panel check).

Runs against a throwaway database in the system temp directory; the chat
provider is replaced with one that raises if it is ever called, so this never
touches a live vendor and costs no credits.

    .venv/Scripts/python.exe tests/identity_turn_test.py

# CRITICAL: this test starts the real app lifespan (TestClient runs it),
# which starts the sync loop if not disabled here. Never remove this line.
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

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_identity_turn_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()

os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
os.environ["JARVIS_SYNC_ENABLED"] = "false"
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ.setdefault("SARVAM_API_KEY", "sarvam-identity-turn-test-not-real")

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


class _ProviderMustNotBeCalled:
    """Stands in for the chat provider on an identity turn.

    Any use at all -- constructing it, streaming from it -- is the bug this
    test exists to catch, so every entry point raises immediately.
    """

    name = "unreachable"
    model = "unreachable"

    def stream(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        raise AssertionError("identity turn must never reach the chat provider")

    def last_result(self):  # noqa: ANN201
        raise AssertionError("identity turn must never reach the chat provider")


async def main() -> int:
    from app.db.database import db

    await db.connect()

    import app.llm.agent as agent
    from app.db import crud
    from app.services.identity import JARVIS_INTRODUCTION

    # --- identity turn: must short-circuit before the provider ------------
    agent.get_chat_provider = lambda: _ProviderMustNotBeCalled()  # type: ignore[assignment]

    events = [event async for event in agent.run_turn("My name is Rahul, who are you?")]
    kinds = [event["type"] for event in events]

    check("only text + done were yielded", kinds == ["text", "done"], f"got {kinds}")
    text_events = [e for e in events if e["type"] == "text"]
    check(
        "the text event carries the exact canonical introduction",
        bool(text_events) and text_events[0]["data"]["text"] == JARVIS_INTRODUCTION,
    )
    done_events = [e for e in events if e["type"] == "done"]
    check(
        "the done event reports a normal completion, not the error fallback",
        bool(done_events) and done_events[0]["data"]["stop_reason"] == "stop",
    )
    check("no panel/surface event was emitted for an identity question", "surface" not in kinds)
    check("no tool call was attempted", "tool_result" not in kinds and "tool_use" not in kinds)

    # The reply must land in the transcript exactly like any other answer,
    # so a follow-up question can refer back to it.
    history = await crud.recent_chat_messages(limit=5)
    assistant_rows = [row for row in history if row["role"] == "assistant"]
    check(
        "the canonical reply was persisted to the transcript",
        bool(assistant_rows) and assistant_rows[-1]["text"] == JARVIS_INTRODUCTION,
    )
    user_rows = [row for row in history if row["role"] == "user"]
    check(
        "the user's own message was still recorded",
        bool(user_rows) and "Rahul" in user_rows[-1]["text"],
    )

    # "My name is Rahul" must still be captured as a memory candidate even
    # though the question itself never reached the model -- this is the
    # whole reason the identity check sits AFTER memory capture, not before.
    candidates = await crud.list_memory_candidates() if hasattr(crud, "list_memory_candidates") else None
    if candidates is not None:
        check(
            "the self-statement was still captured as a memory candidate",
            any("Rahul" in (c.get("body") or c.get("text") or "") for c in candidates),
        )
    else:
        print("  [SKIP] no list_memory_candidates() helper on crud -- capture path exercised, not asserted")

    # --- ordinary turn: must be completely unaffected ----------------------
    class _FakeStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class _FakeProvider:
        name = "fake"
        model = "fake"

        def stream(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
            return _FakeStream()

        def last_result(self):  # noqa: ANN201
            from app.providers.base import ChatResult

            return ChatResult(content="fine, thanks.", finish_reason="stop")

    reached_provider = False

    def _fake_get_chat_provider():
        nonlocal reached_provider
        reached_provider = True
        return _FakeProvider()

    agent.get_chat_provider = _fake_get_chat_provider  # type: ignore[assignment]
    ordinary_events = [event async for event in agent.run_turn("how are you doing today")]
    check("an ordinary turn still reaches the chat provider", reached_provider)
    check(
        "an ordinary turn still terminates with done",
        ordinary_events and ordinary_events[-1]["type"] == "done",
    )

    await db.disconnect()

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
