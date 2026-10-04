"""The honest number (focus.week, GET /api/focus/week), on an isolated database.

No provider calls, no user data. Fixed clock: Thursday 1 Oct 2026, 15:00.

    .venv/Scripts/python.exe tests/focus_week_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-week-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "week.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
from app.services import focus  # noqa: E402

crud.db = dbmod.db

NOW = datetime(2026, 10, 1, 15, 0)
failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


async def item(uid: str, title: str, kind: str, mode: str, **timing: object) -> None:
    columns = {"block_kind": None, "day_of_week": None, "start_time": None, "end_time": None,
               "time_start": None, "time_end": None, "due_date": None, **timing}
    await dbmod.db.execute(
        "INSERT INTO focus_items (uid, kind, mode, title, block_kind, day_of_week, start_time, end_time, "
        "time_start, time_end, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uid, kind, mode, title, columns["block_kind"], columns["day_of_week"], columns["start_time"],
         columns["end_time"], columns["time_start"], columns["time_end"], columns["due_date"],
         "2026-09-10T09:00:00", "2026-09-10T09:00:00"),
    )


async def done(uid: str, title: str, occurrence: str, finished: str, minutes: float | None) -> None:
    await dbmod.db.execute(
        "INSERT INTO focus_events (item_uid, title, occurrence, status, finished_at, minutes) VALUES (?, ?, ?, 'done', ?, ?)",
        (uid, title, occurrence, finished, minutes),
    )


async def main() -> None:
    await dbmod.db.connect()
    try:
        await item("dsa", "DSA", "block", "session", block_kind="ROUTINE", day_of_week=1, start_time="19:00", end_time="20:30")
        await item("gym", "Gym", "block", "quick", block_kind="ROUTINE", day_of_week=0, start_time="07:00", end_time="08:00")
        await item("read", "Reading", "block", "session", block_kind="ROUTINE", day_of_week=2, start_time="21:00", end_time="21:30")
        await item("mock", "Mock test", "block", "session", block_kind="SESSION",
                   time_start="2026-09-26T10:00:00", time_end="2026-09-26T10:50:00")
        await item("essay", "Essay", "task", "quick", due_date="2026-09-30T18:00:00")

        # This week (from Mon 28 Sep): a timed DSA, a one-tap Gym, a one-tap task.
        await done("dsa", "DSA", "2026-09-29", "2026-09-29T20:30:00", 85)
        await done("gym", "Gym", "2026-09-28", "2026-09-28T08:05:00", None)
        await done("essay", "Essay", "once", "2026-09-30T17:00:00", None)
        # Last week: DSA and Gym before this point last week, the mock test after it.
        await done("dsa", "DSA", "2026-09-22", "2026-09-22T20:35:00", 90)
        await done("gym", "Gym", "2026-09-21", "2026-09-21T08:00:00", None)
        await done("mock", "Mock test", "2026-09-26", "2026-09-26T10:50:00", 50)
        # Something "finished" after now does not count yet.
        await done("dsa", "DSA", "2026-10-06", "2026-10-06T20:00:00", 60)

        result = await focus.week(NOW)
        this, last = result["this"], result["last"]
        print("week")
        check("this week starts on Monday", result["week_of"] == "2026-09-28", result["week_of"])
        check("time: measured session plus the one-tap block's planned hour; tasks add none",
              this["minutes"] == 145, this)
        check("last week in full", last["minutes"] == 200, last)
        check("last week up to this same moment (fair on a Thursday)", last["to_date"] == 150, last)
        check("kept counts: Reading skipped each Wednesday",
              (this["done"], this["skipped"], this["kept"]) == (3, 1, 0.75)
              and (last["done"], last["skipped"], last["kept"]) == (3, 1, 0.75), (this, last))
        check("today and streak come along", "pending" in result["today"] and isinstance(result["streak"], int), result)
        check("item count", result["items"] == 5, result["items"])

        empty_week = await focus.week(datetime(2026, 8, 3, 9, 0))
        check("a week with nothing done: zeros, no kept rate",
              empty_week["this"]["minutes"] == 0 and empty_week["this"]["kept"] is None, empty_week["this"])

        from app.api import focus as focus_api
        check("GET /focus/week is mounted", "/focus/week" in {route.path for route in focus_api.router.routes})
    finally:
        await dbmod.db.disconnect()

    print(f"\n{passed} passed, {len(failures)} failed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
