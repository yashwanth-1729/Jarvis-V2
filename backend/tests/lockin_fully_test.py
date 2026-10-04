"""Lock-in Start/Stop: sessions stop at their block's end, and stats say how
fully each thing gets done. Isolated database, fixed clock, no user data.

    .venv/Scripts/python.exe tests/lockin_fully_test.py
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

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-fully-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "fully.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
from app.services import focus  # noqa: E402

crud.db = dbmod.db

# Thursday 1 Oct 2026, 21:00.
NOW = datetime(2026, 10, 1, 21, 0)
failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


async def block(uid: str, title: str, day: int, start: str, end: str) -> None:
    await dbmod.db.execute(
        "INSERT INTO focus_items (uid, kind, mode, title, block_kind, day_of_week, start_time, end_time, created_at, updated_at) "
        "VALUES (?, 'block', 'session', ?, 'ROUTINE', ?, ?, ?, '2026-09-20T09:00:00', '2026-09-20T09:00:00')",
        (uid, title, day, start, end),
    )


async def event(uid: str, title: str, occurrence: str, status: str, started: str | None, finished: str | None, minutes: float | None) -> int:
    return await dbmod.db.execute(
        "INSERT INTO focus_events (item_uid, title, occurrence, status, started_at, finished_at, minutes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (uid, title, occurrence, status, started, finished, minutes),
    )


async def main() -> None:
    await dbmod.db.connect()
    try:
        # DSA Mon-Thu-ish: 19:00-20:00 on Thursday (day 3); Gym on Wednesday (day 2) 07:00-08:00.
        await block("dsa", "DSA", 3, "19:00", "20:00")
        await block("gym", "Gym", 2, "07:00", "08:00")
        await block("read", "Reading", 1, "21:30", "22:00")

        print("stops at the block's last second")
        await event("dsa", "DSA", "2026-10-01", "running", "2026-10-01T19:10:00", None, None)
        closed = await focus.close_overdue(NOW)
        row = await dbmod.db.fetch_one("SELECT * FROM focus_events WHERE item_uid = 'dsa' AND occurrence = '2026-10-01'")
        check("an overrunning session is closed", closed == 1 and row["status"] == "done", row)
        check("at the block's end, with the minutes up to it",
              row["finished_at"] == "2026-10-01T20:00:00" and row["minutes"] == 50.0, row)
        check("closing again does nothing", await focus.close_overdue(NOW) == 0)

        # A Stop tapped long after the end still counts up to the end.
        await event("gym", "Gym", "2026-09-30", "running", "2026-09-30T07:20:00", None, None)
        stopped = await focus.finish("gym", "2026-09-30")
        check("a late Stop counts as stopped at the end", stopped["finished_at"] == "2026-09-30T08:00:00" and stopped["minutes"] == 40.0, stopped)

        # A session whose block hasn't ended keeps running.
        await event("read", "Reading", "2026-09-29", "done", "2026-09-29T21:30:00", "2026-09-29T21:42:00", 12)
        await dbmod.db.execute("INSERT INTO focus_items (uid, kind, mode, title, due_date, created_at, updated_at) VALUES ('essay', 'task', 'session', 'Essay', NULL, '2026-09-20T09:00:00', '2026-09-20T09:00:00')")
        await event("essay", "Essay", "once", "running", "2026-10-01T18:00:00", None, None)
        await focus.close_overdue(NOW)
        task = await dbmod.db.fetch_one("SELECT * FROM focus_events WHERE item_uid = 'essay'")
        check("a task runs until it's stopped (no end time)", task["status"] == "running", task)

        print("how fully")
        # More history: DSA last Thursday done fully (60/60); Gym last Wednesday skipped.
        await event("dsa", "DSA", "2026-09-24", "done", "2026-09-24T19:00:00", "2026-09-24T20:00:00", 60)
        stats = await focus.stats(14, current=NOW)
        items = {item["uid"]: item for item in stats["items"]}
        dsa, gym, read = items.get("dsa"), items.get("gym"), items.get("read")
        check("DSA: one full (60/60), one partial (50/60)", dsa and (dsa["full"], dsa["partial"], dsa["low"]) == (1, 1, 0), dsa)
        check("DSA average 92%", dsa and dsa["average"] == round((1 + 50 / 60) / 2, 3), dsa)
        check("Gym: 40/60 is partial; last week's skip counts as 0",
              gym and gym["partial"] == 1 and gym["skipped"] >= 1 and gym["average"] is not None and gym["average"] < 0.5, gym)
        check("Reading: 12/30 is under half", read and read["low"] == 1, read)
        check("time kept = minutes put in / minutes planned",
              stats["time_kept"] is not None and 0 < stats["time_kept"] < 1 and stats["planned_minutes"] > 0, (stats["time_kept"], stats["planned_minutes"]))
        day = next(d for d in stats["series"] if d["date"] == "2026-10-01")
        check("the day's series carries planned and done minutes", day["planned"] == 60 and day["minutes"] == 50, day)
    finally:
        await dbmod.db.disconnect()

    print(f"\n{passed} passed, {len(failures)} failed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
