"""Serious mode (services/focus.py) and the ping purge, on an isolated database.

No provider calls, no user data.

    .venv/Scripts/python.exe tests/serious_mode_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-serious-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "serious.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
from app.core.timeutil import now  # noqa: E402
from app.services import focus  # noqa: E402

crud.db = dbmod.db

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


def iso(moment) -> str:
    return moment.isoformat(timespec="seconds")


async def main() -> None:
    await dbmod.db.connect()
    try:
        current = now()
        today = current.date()
        yesterday = today - timedelta(days=1)
        long_ago = iso(current - timedelta(days=10))

        print("marking and finishing")
        # A weekly block on yesterday's weekday that ended long before now, marked
        # serious ten days ago and never done: yesterday's occurrence is a skip.
        await focus.upsert_item("block-y", {"kind": "block", "mode": "session", "title": "DSA", "block_kind": "ROUTINE",
                                            "day_of_week": yesterday.weekday(), "start_time": "06:00", "end_time": "07:00"})
        await dbmod.db.execute("UPDATE focus_items SET created_at = ? WHERE uid = 'block-y'", (iso(current - timedelta(days=3)),))
        # A one-tap task due an hour ago, never done: a skip.
        await focus.upsert_item("task-late", {"kind": "task", "mode": "quick", "title": "Submit form", "due_date": iso(current - timedelta(hours=1))})
        await dbmod.db.execute("UPDATE focus_items SET created_at = ? WHERE uid = 'task-late'", (long_ago,))
        # A session task: start, then done, records minutes.
        await focus.upsert_item("task-s", {"kind": "task", "mode": "session", "title": "Read chapter"})
        started = await focus.start("task-s")
        check("start opens a running session", started and started["status"] == "running", started)
        again = await focus.start("task-s")
        check("start is idempotent", again and again["id"] == started["id"])
        await dbmod.db.execute("UPDATE focus_events SET started_at = ? WHERE id = ?", (iso(current - timedelta(minutes=25)), started["id"]))
        finished = await focus.finish("task-s")
        check("done closes it with minutes", finished["status"] == "done" and 24 <= (finished["minutes"] or 0) <= 26, finished)
        quick = await focus.upsert_item("task-q", {"kind": "task", "mode": "quick", "title": "Pay fees"})
        tapped = await focus.finish(quick["uid"])
        check("a one-tap item completes directly", tapped["status"] == "done" and tapped["started_at"] is None, tapped)

        print("stats")
        stats = await focus.stats(14)
        yesterday_row = next(row for row in stats["series"] if row["date"] == yesterday.isoformat())
        check("missed block counts as skipped yesterday", yesterday_row["skipped"] == 1, yesterday_row)
        check("overdue serious task counts as skipped", stats["today"]["skipped"] >= 1 or any(r["skipped"] for r in stats["series"][-1:]), stats["today"])
        check("two completions today", stats["series"][-1]["done"] == 2, stats["series"][-1])
        check("focus minutes add up", 24 <= stats["minutes"] <= 26, stats["minutes"])
        check("rate is done / (done + skipped)", stats["rate"] == round(2 / 4, 3), stats["rate"])
        check("a day with a skip ends the streak", stats["streak"] == 0, stats["streak"])

        await focus.finish("block-y", yesterday.isoformat())
        await focus.finish("task-late")
        stats = await focus.stats(14)
        check("finishing late clears the skips", stats["skipped"] == 0, stats["skipped"])
        check("then today is a clean day: streak 1", stats["streak"] >= 1, stats["streak"])
        check("per-item results list the block", any(item["title"] == "DSA" and item["done"] == 1 for item in stats["items"]), stats["items"])
        await focus.upsert_item("task-fresh", {"kind": "task", "mode": "quick", "title": "Fresh pick"})
        check("an item with no record yet is not a scoreboard row", all(item["uid"] != "task-fresh" for item in (await focus.stats(14))["items"]))
        await focus.remove_item("task-fresh")

        await focus.reset("task-q")
        check("reset takes a Done back", not any(e["item_uid"] == "task-q" for e in await focus.recent_events()))
        check("unmarking keeps history", await focus.remove_item("task-s") and (await focus.stats(14))["done"] >= 1)

        print("pings: only upcoming survive")
        future = await crud.create_reminder("Call the bank", iso(current + timedelta(hours=2)))
        fired = await crud.create_reminder("Spoken already", iso(current + timedelta(minutes=30)))
        await crud.mark_reminder_fired(fired["id"])
        stale = await crud.create_reminder("Passed unheard", iso(current - timedelta(hours=26)))
        fresh = await crud.create_reminder("Missed while asleep", iso(current - timedelta(minutes=40)))
        listed = await crud.list_reminders()
        ids = {row["id"] for row in listed}
        check("upcoming reminder is listed", future["id"] in ids)
        check("fired reminder is deleted", await crud.get_reminder(fired["id"]) is None)
        check("a day-late unfired reminder is deleted", await crud.get_reminder(stale["id"]) is None)
        check("a missed one is kept for the scheduler to announce late", fresh["id"] in ids)
    finally:
        await dbmod.db.disconnect()

    print(f"\n{passed} passed, {len(failures)} failed")
    if failures:
        sys.exit(1)


asyncio.run(main())
