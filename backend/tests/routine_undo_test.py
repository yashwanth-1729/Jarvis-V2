"""set_routine, undo_last_change and the conversation-only history window.

Isolated database in the system temp directory; no provider calls, no user
data. Built from the 2026-09-26 phone failure: a pasted 27-block routine that
was deleted but never added, and "undo what you did" with nothing behind it.

    .venv/Scripts/python.exe tests/routine_undo_test.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-routine-undo-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "routine.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
import app.llm.agent as agent  # noqa: E402
from app.llm.tools import execute_tool  # noqa: E402
from app.services import memory  # noqa: E402

crud.db = dbmod.db
memory.db = dbmod.db

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


# The user's timetable, in the mixed shapes a model actually sends.
TIMETABLE = [
    ("Monday", "6:30 PM", "8:00 PM", "DSA"), (0, "20:30", "21:45", "Japanese"), (0, "21:45", "22:30", "Story writing"),
    (1, "18:30", "20:00", "Japanese"), (1, "20:30", "21:45", "Python"), (1, "21:45", "22:30", "Personal project"),
    (2, "18:30", "20:00", "DSA"), (2, "20:30", "22:30", "Movie night"),
    ("thu", "09:30", "11:30", "Japanese"), (3, "11:45", "13:15", "Operating Systems"), (3, "14:30", "15:30", "Drawing"),
    (3, "15:45", "16:45", "Math"), (3, "18:30", "20:00", "Python"), (3, "20:30", "21:45", "DSA"),
    (3, "21:45", "22:30", "Personal project"),
    (4, "18:30", "20:00", "Japanese"), (4, "20:30", "21:45", "Operating Systems"), (4, "21:45", "22:30", "Java"),
    (5, "18:30", "20:00", "DSA"), (5, "20:30", "22:30", "Movie night"),
    (6, "09:30", "11:30", "DSA"), (6, "11:45", "13:15", "Japanese"), (6, "14:30", "16:00", "Python"),
    (6, "16:15", "17:15", "IoT"), (6, "18:30", "20:00", "Operating Systems"),
    (6, "20:30", "21:15", "Story writing / drawing"), (6, "21:15", "22:00", "Personal project"),
]
BLOCKS = [{"day_of_week": d, "start_time": s, "end_time": e, "name": n} for d, s, e, n in TIMETABLE]


async def routine() -> list[dict]:
    return await crud.list_schedules("ROUTINE")


async def main() -> None:
    await dbmod.db.connect()
    try:
        print("undo with nothing on record")
        empty = await execute_tool("undo_last_change", {})
        check("says there is nothing to undo", "Nothing to undo" in empty.content, empty.content)

        # A college timetable and an old routine the new one replaces.
        college = [
            await crud.create_schedule_event("DSA lecture", "COLLEGE", day_of_week=0, start_time="09:30", end_time="11:00"),
            await crud.create_schedule_event("Lab", "COLLEGE", day_of_week=3, start_time="10:00", end_time="11:00"),
        ]
        old = [
            await crud.create_schedule_event("Gym", "ROUTINE", day_of_week=0, start_time="06:00", end_time="07:00"),
            await crud.create_schedule_event("Study", "ROUTINE", day_of_week=1, start_time="18:30", end_time="20:00"),
        ]
        college_before = {row["uid"]: row["updated_at"] for row in await crud.list_schedules("COLLEGE")}

        print("set_routine: replace needs one confirmation")
        ask = await execute_tool("set_routine", {"blocks": BLOCKS}, turn_ref="turn-1")
        check("first call asks, with both numbers", ask.content.startswith("CONFIRMATION REQUIRED")
              and "all 2 current" in ask.content and "these 27" in ask.content, ask.content)
        check("nothing changed before the yes", len(await routine()) == 2)
        wrong = await execute_tool("set_routine", {"blocks": BLOCKS, "confirmed": True, "expect_count": 5}, turn_ref="turn-1")
        check("a wrong count is refused", wrong.is_error and len(await routine()) == 2, wrong.content)
        done = await execute_tool("set_routine", {"blocks": BLOCKS, "confirmed": True, "expect_count": 2}, turn_ref="turn-1")
        rows = await routine()
        check("confirmed call replaces the routine in one go", not done.is_error and len(rows) == 27, done.content)
        per_day = [sum(1 for row in rows if row["day_of_week"] == day) for day in range(7)]
        check("blocks land on the right days", per_day == [3, 3, 2, 7, 3, 2, 7], per_day)
        check("'6:30 PM' and 'Monday' were understood",
              any(row["event_name"] == "DSA" and row["day_of_week"] == 0 and row["start_time"] == "18:30" for row in rows))
        check("college classes untouched",
              {row["uid"]: row["updated_at"] for row in await crud.list_schedules("COLLEGE")} == college_before)
        tombs = {row["uid"] for row in await dbmod.db.fetch_all("SELECT uid FROM sync_tombstones WHERE table_name = 'schedules'")}
        check("old routine rows leave tombstones", {row["uid"] for row in old} <= tombs)
        check("a real clash with college is reported", "Clashes with college" in done.content and "Lab" in done.content, done.content)
        check("back-to-back blocks are not called overlaps", "overlap each other" not in done.content, done.content)

        print("set_routine: bad input saves nothing; add mode needs no confirmation")
        bad = await execute_tool("set_routine", {"blocks": [{"day_of_week": "someday", "start_time": "25:99", "name": "X"}], "replace": False})
        check("an invalid block is refused whole", bad.is_error and len(await routine()) == 27, bad.content)
        added = await execute_tool("set_routine", {"blocks": [{"day_of_week": 5, "start_time": "07:00", "end_time": "08:00", "name": "Run"}], "replace": False}, turn_ref="turn-2")
        check("replace=false just adds", not added.is_error and len(await routine()) == 28, added.content)

        print("undo walks back one turn at a time")
        await execute_tool("add_task", {"title": "Buy milk"}, turn_ref="turn-3")
        first = await execute_tool("undo_last_change", {})
        tasks = await crud.list_tasks()
        check("undo removes the task from the last turn", not any(t["title"] == "Buy milk" for t in tasks), first.content)
        second = await execute_tool("undo_last_change", {})
        check("undo again removes the added block", len(await routine()) == 27, second.content)
        third = await execute_tool("undo_last_change", {})
        rows = await routine()
        check("undo again brings the old routine back", sorted(row["uid"] for row in rows) == sorted(row["uid"] for row in old), third.content)
        check("college still untouched after undo",
              {row["uid"]: row["updated_at"] for row in await crud.list_schedules("COLLEGE")} == college_before)
        tombs = {row["uid"] for row in await dbmod.db.fetch_all("SELECT uid FROM sync_tombstones WHERE table_name = 'schedules'")}
        check("restored rows are no longer tombstoned", not ({row["uid"] for row in old} & tombs))
        pending = {row["uid"] for row in await dbmod.db.fetch_all("SELECT uid FROM sync_pending WHERE table_name = 'schedules'")}
        check("restored rows are queued to sync", {row["uid"] for row in old} <= pending)

        print("undo leaves later hand edits alone")
        await execute_tool("add_task", {"title": "Call bank"}, turn_ref="turn-4")
        task = next(t for t in await crud.list_tasks() if t["title"] == "Call bank")
        await dbmod.db.execute("UPDATE tasks SET title = ?, updated_at = ? WHERE uid = ?", ("Call bank at 5", "2099-01-01T00:00:00", task["uid"]))
        skipped = await execute_tool("undo_last_change", {})
        check("an edited task survives undo", any(t["title"] == "Call bank at 5" for t in await crud.list_tasks()), skipped.content)
        check("and the reply says it was left alone", "Left 1 item" in skipped.content, skipped.content)

        print("a confirmed delete can be undone")
        await execute_tool("add_task", {"title": "Old errand"}, turn_ref="turn-5")
        doomed = next(t for t in await crud.list_tasks() if t["title"] == "Old errand")
        await execute_tool("delete_record", {"record_type": "task", "title": "Old errand"}, turn_ref="turn-6")
        gone = await execute_tool("delete_record", {"record_type": "task", "title": "Old errand", "confirmed": True}, turn_ref="turn-6")
        check("deleted", not any(t["title"] == "Old errand" for t in await crud.list_tasks()), gone.content)
        check("the reply no longer says it cannot be undone", "cannot be undone" not in gone.content, gone.content)
        back = await execute_tool("undo_last_change", {})
        again = next((t for t in await crud.list_tasks() if t["title"] == "Old errand"), None)
        check("undo restores it with its identity", again is not None and again["uid"] == doomed["uid"], back.content)

        print("history: the window holds the conversation, not tool traffic")
        paste = "Monday: 6:30 PM-8:00 PM DSA ... (the whole pasted timetable)"
        call = {"role": "assistant", "content": "", "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": "add_schedule_event", "arguments": "{}"}} for i in range(5)]}
        busy = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hey"},
            {"role": "user", "content": paste},
            call,
            *({"role": "tool", "tool_call_id": f"c{i}", "content": f"Saved to the schedule: #{i} DSA [ROUTINE]"} for i in range(5)),
            {"role": "assistant", "content": "Added them."},
            {"role": "user", "content": "just add these timings"},
        ]
        old_window = agent._trim_to_safe_boundary(busy[-6:])
        new_window = agent._trim_to_safe_boundary(agent._window(agent._conversation_only(busy), 6))
        check("before: the paste had fallen out", paste not in [m.get("content") for m in old_window])
        check("now: the paste is still visible", paste in [m.get("content") for m in new_window], new_window)
        check("no tool traffic from finished turns", not any(m.get("role") == "tool" or m.get("tool_calls") for m in new_window))
        check("still at most 6 messages", len(new_window) <= 6, len(new_window))

        ask_call = {"role": "assistant", "content": "", "tool_calls": [
            {"id": "b1", "type": "function", "function": {"name": "bulk_delete_schedule", "arguments": json.dumps({"kind": "ROUTINE"})}}]}
        confirm = [
            {"role": "user", "content": "clear my routine"},
            ask_call,
            {"role": "tool", "tool_call_id": "b1", "content": "CONFIRMATION REQUIRED. This would delete 18 schedule entries ..."},
            {"role": "assistant", "content": "That clears 18 routine blocks. Go ahead?"},
            {"role": "user", "content": "yes"},
        ]
        kept = agent._window(agent._conversation_only(confirm), 6)
        check("a pending confirmation keeps its tool call for the 'yes'",
              any(m.get("tool_calls") for m in kept) and any(m.get("role") == "tool" for m in kept), kept)

        # Token cost on a tool-heavy chat: three "what's on" turns, each reading
        # the full dashboard (about 2,000 characters of tool output).
        dashboard = "TASKS ... SCHEDULE ... " + "x" * 2000
        heavy: list[dict] = []
        for i in range(3):
            heavy += [
                {"role": "user", "content": f"what's on {i}"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": f"d{i}", "type": "function", "function": {"name": "get_dashboard_summary", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": f"d{i}", "content": dashboard},
                {"role": "assistant", "content": f"You have 3 things on, {i}."},
            ]
        heavy.append({"role": "user", "content": "thanks"})
        size = lambda window: sum(len(json.dumps(m)) for m in window)  # noqa: E731
        before_chars = size(agent._trim_to_safe_boundary(heavy[-6:]))
        after_chars = size(agent._trim_to_safe_boundary(agent._window(agent._conversation_only(heavy), 6)))
        print(f"    history size on a tool-heavy chat: {before_chars} -> {after_chars} characters")
        check("fewer characters on a tool-heavy chat", after_chars < before_chars, (before_chars, after_chars))
    finally:
        await dbmod.db.disconnect()

    print(f"\n{passed} passed, {len(failures)} failed")
    if failures:
        sys.exit(1)


asyncio.run(main())
