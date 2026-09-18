"""Guards against the two ways a turn's context can silently balloon back up:

* ``_load_history`` must never hand the model more than
  ``jarvis_llm_history_messages`` messages, regardless of how much is stored.
* ``tool_routing.route`` must cover every "core" tool (a tool missing from
  every group becomes unreachable the moment routing narrows) and must
  return the empty set, not a name that doesn't exist, on no match.

Uses a throwaway SQLite database; makes no live request and does not mutate
user data.

    .venv/Scripts/python.exe tests/agent_context_budget_test.py
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

TMP_DB = Path(tempfile.gettempdir()) / "jarvis_agent_context_budget_test.db"
for suffix in ("", "-wal", "-shm"):
    stale = Path(str(TMP_DB) + suffix)
    if stale.exists():
        stale.unlink()

os.environ["JARVIS_DB_PATH"] = str(TMP_DB)
os.environ["JARVIS_SYNC_ENABLED"] = "false"
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ.setdefault("SARVAM_API_KEY", "sarvam-context-budget-test-not-real")

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


async def main() -> int:
    from app.core.config import settings
    from app.db import crud
    from app.db.database import db

    await db.connect()

    import app.llm.agent as agent
    from app.llm import tool_routing
    from app.llm.tools import TOOL_REGISTRY, openai_tools

    # --- history window --------------------------------------------------
    limit = settings.jarvis_llm_history_messages
    turns = limit + 10
    for i in range(turns):
        await crud.append_chat_message("user", f"message {i}")
        await crud.append_chat_message("assistant", f"reply {i}")

    history = await agent._load_history()
    check(
        f"_load_history never exceeds jarvis_llm_history_messages ({limit})",
        len(history) <= limit,
        f"got {len(history)}",
    )
    if history:
        check(
            "the window holds the MOST RECENT messages, not the oldest",
            history[-1]["content"] == f"reply {turns - 1}",
            history[-1],
        )

    # --- tool router: full coverage --------------------------------------
    core_names = {spec.name for spec in TOOL_REGISTRY if spec.capability == "core"}
    grouped = {name for names in tool_routing.TOOL_GROUPS.values() for name in names}
    check(
        "every core tool belongs to at least one routing group",
        core_names <= grouped,
        f"missing: {sorted(core_names - grouped)}",
    )

    # --- tool router: no-match falls back to every core tool ---------------
    # Reverted 2026-09-16 from a "zero tools" default after it broke a real
    # request live ("remind me..." didn't hit any keyword, router sent zero
    # tools, Qwen just replied in words instead of calling set_reminder).
    # `jarvis_tool_routing_fallback_all` now defaults to True.
    no_match = tool_routing.route("asdkfjaslkdfj nonsense with no keywords")
    check(
        "no keyword match falls back to None (send every core tool)",
        no_match is None,
        repr(no_match),
    )
    offered = openai_tools(no_match)
    core_offered = [t for t in offered if t["function"]["name"] in core_names]
    check(
        "a no-match route offers every core tool (the safe fallback)",
        len(core_offered) == len(core_names),
        f"{len(core_offered)} of {len(core_names)}",
    )

    # --- tool router: a real match offers only real tool names -----------
    routed = tool_routing.route("remind me to call mom tomorrow")
    check("a matched route is non-empty", bool(routed), repr(routed))
    check(
        "every routed name is a real registered tool",
        routed <= {spec.name for spec in TOOL_REGISTRY},
        f"unknown: {routed - {spec.name for spec in TOOL_REGISTRY}}",
    )

    await db.disconnect()
    if TMP_DB.exists():
        TMP_DB.unlink()
    for suffix in ("-wal", "-shm"):
        stray = Path(str(TMP_DB) + suffix)
        if stray.exists():
            stray.unlink()

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
