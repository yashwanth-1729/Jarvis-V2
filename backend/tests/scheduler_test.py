"""The timetable firing — once, and only when it is worth interrupting.

Until this existed, JARVIS knew the user's whole week and did nothing at any
point in it. The two ways that goes wrong once it *does* act are opposites, and
both are worse than silence:

* repeating itself — a polling loop sees the same class as due on every tick,
  so without a durable record it announces the 7:30 class at 7:20, 7:20:30,
  7:21, forever;
* interrupting for nothing — announce everything and the user mutes it, and a
  muted assistant is strictly worse than one that never spoke.

The clock is injected throughout, so a weekly class can be tested on a Tuesday
in March without waiting for one.

    .venv/Scripts/python.exe tests/scheduler_test.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = Path(tempfile.gettempdir()) / "jarvis_scheduler_test.db"
for suffix in ("", "-wal", "-shm"):
    Path(str(SCRATCH) + suffix).unlink(missing_ok=True)
os.environ["JARVIS_DB_PATH"] = str(SCRATCH)

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.core.config as cfg  # noqa: E402

cfg.settings = get_settings()

import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(cfg.settings.db_file, 5)
import app.db.crud as crud  # noqa: E402

crud.db = dbmod.db

import app.services.proactive as proactive  # noqa: E402
import app.services.notification_policy as notification_policy  # noqa: E402
import app.services.scheduler as scheduler  # noqa: E402

proactive.crud = crud
scheduler.crud = crud

from app.core.timeutil import to_iso  # noqa: E402

passed = 0
failed = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


async def pending_texts() -> list[str]:
    return [row["text"] for row in await crud.pending_announcements(limit=50)]


async def main() -> None:
    await dbmod.db.connect()
    try:
        # This suite exercises every collector. Production defaults intentionally
        # enable deadline tasks only; opt all fixture categories in explicitly.
        await notification_policy.save({
            **notification_policy.DEFAULT_POLICY,
            "college": True,
            "routine": True,
            "blocks": True,
            "reminders": True,
        })
        print("== schema ==")
        tables = {
            row["name"]
            for row in await dbmod.db.fetch_all(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        check("reminders table exists", "reminders" in tables)
        check("announcements table exists", "announcements" in tables)
        version = await dbmod.db.fetch_value("PRAGMA user_version")
        check("migrated to v4", int(version) >= 4, version)

        # A Monday at 19:20, ten minutes before a 19:30 class.
        monday = datetime(2026, 8, 24, 19, 20, 0)
        check("fixture really is a Monday", monday.weekday() == 0)

        print("\n== a weekly class fires once, in its lead window ==")
        await crud.create_schedule_event(
            event_name="Java class", kind="COLLEGE",
            day_of_week=0, start_time="19:30", end_time="21:00", location="Room C410",
        )
        queued = await scheduler.tick(monday)
        check("queued the class", queued == 1, queued)
        texts = await pending_texts()
        check("  ...names it", any("Java class" in t for t in texts), texts)
        check("  ...says when", any("10 minutes" in t for t in texts), texts)
        check("  ...includes the room", any("C410" in t for t in texts), texts)

        # The loop runs every 30 seconds. It must not say it again.
        again = await scheduler.tick(monday + timedelta(seconds=30))
        check("SECOND TICK SAYS NOTHING", again == 0, again)
        again = await scheduler.tick(monday + timedelta(minutes=5))
        check("  ...nor five minutes later", again == 0, again)
        check("  ...and only one announcement exists", len(await pending_texts()) == 1)

        print("\n== a weekly row with a leftover one-off date still fires ==")
        # Straight from the real database: rows carry both a weekly slot and a
        # stale `time_start` from whenever they were first created. Reading
        # `time_start` first turned a weekly class into a one-off that had
        # already happened, and it silently never fired again.
        both = await crud.create_schedule_event(
            event_name="Operating Systems", kind="COLLEGE",
            day_of_week=0, start_time="09:00", end_time="10:00",
        )
        await dbmod.db.execute(
            "UPDATE schedules SET time_start = ? WHERE id = ?",
            ("2026-01-05T00:00:00", both["id"]),
        )
        stale_row = await crud.get_schedule_event(both["id"])
        check("fixture has both shapes",
              stale_row["day_of_week"] == 0 and bool(stale_row["time_start"]),
              stale_row)
        queued = await scheduler.tick(datetime(2026, 8, 24, 8, 55, 0))
        check("the weekly slot wins over the stale date", queued == 1, queued)
        check("  ...and names the class",
              any("Operating Systems" in t for t in await pending_texts()))
        await crud.delete_schedule_event(both["id"])

        print("\n== but it fires again next week ==")
        next_week = monday + timedelta(days=7)
        queued = await scheduler.tick(next_week)
        check("next Monday is a new occurrence", queued == 1, queued)

        print("\n== outside the window, nothing happens ==")
        before = datetime(2026, 8, 24, 18, 0, 0)   # 90 minutes early
        check("too early is silent", await scheduler.tick(before) == 0)
        stale = datetime(2026, 8, 24, 20, 30, 0)   # an hour after it started
        check("long past is silent", await scheduler.tick(stale) == 0)
        tuesday = datetime(2026, 8, 25, 19, 20, 0)
        check("wrong day is silent", await scheduler.tick(tuesday) == 0)

        print("\n== a survived restart does not re-announce ==")
        # The realistic repeat: in-memory state is gone, the database is not.
        await dbmod.db.disconnect()
        await dbmod.db.connect()
        check("still silent after reconnect", await scheduler.tick(monday) == 0)

        print("\n== reminders ==")
        due = monday - timedelta(minutes=1)
        await crud.create_reminder("call the dentist", to_iso(due))
        queued = await scheduler.tick(monday)
        check("a due reminder fires", queued == 1, queued)
        check("  ...with the user's own words",
              any("call the dentist" in t for t in await pending_texts()))
        check("repeat tick stays quiet", await scheduler.tick(monday) == 0)

        pending = await crud.list_reminders()
        check("  ...and it is no longer pending", pending == [], pending)

        future = monday + timedelta(hours=3)
        await crud.create_reminder("not yet", to_iso(future))
        check("a future reminder does not fire", await scheduler.tick(monday) == 0)

        print("\n== interruption is earned ==")
        # A low-priority task with no due date scores well under the threshold.
        await crud.create_task(title="tidy the desk", priority="LOW")
        quiet = await scheduler.tick(monday)
        check("a trivial task does not interrupt", quiet == 0, quiet)
        check(
            "  ...and the threshold matches the banner's",
            scheduler.URGENCY_TO_INTERRUPT == proactive.URGENT_THRESHOLD,
        )

        print("\n== delivery is acknowledged, not assumed ==")
        waiting = await crud.pending_announcements()
        check("announcements are waiting", len(waiting) > 0, len(waiting))
        ids = [row["id"] for row in waiting]
        await crud.mark_announcements_delivered(ids)
        check("acknowledged ones disappear", await crud.pending_announcements() == [])
        # Re-acknowledging is a no-op rather than an error.
        check("re-acknowledging is harmless",
              await crud.mark_announcements_delivered(ids) == 0)

        print("\n== the dedupe guard is in the database, not the loop ==")
        first = await crud.record_announcement("schedule", 999, "2026-08-24T19:30:00", "x")
        second = await crud.record_announcement("schedule", 999, "2026-08-24T19:30:00", "x")
        check("first insert reports new", first is True)
        check("duplicate reports already-seen", second is False)
        rows = await dbmod.db.fetch_all(
            "SELECT COUNT(*) AS n FROM announcements WHERE ref_id = 999"
        )
        check("  ...and only one row exists", rows[0]["n"] == 1, rows[0]["n"])

        print("\n== a bad row cannot stop everything else firing ==")
        await crud.create_schedule_event(
            event_name="Broken", kind="ROUTINE", day_of_week=0, start_time="not-a-time",
        )
        await crud.create_reminder("still works", to_iso(monday - timedelta(minutes=1)))
        survived = await scheduler.tick(monday)
        check("the good reminder still fired", survived >= 1, survived)

        print("\n== gating ==")
        check("scheduler runs on desktop", cfg.settings.scheduler_enabled is True)
        cfg.settings.jarvis_client_owned_data = True
        check("forced off on mobile", cfg.settings.scheduler_enabled is False)
        cfg.settings.jarvis_client_owned_data = False
        cfg.settings.jarvis_scheduler_enabled = False
        check("off when the operator disables it", cfg.settings.scheduler_enabled is False)
        cfg.settings.jarvis_scheduler_enabled = True
    finally:
        await dbmod.db.disconnect()


asyncio.run(main())
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
