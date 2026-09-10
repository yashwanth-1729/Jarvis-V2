"""One-time import of schedule data that was captured into long-term memory.

Before the schedule gained its three kinds, JARVIS had nowhere structured to put
"Monday 6:00 PM to 7:45 PM: Django project", so it filed timings as free-text
memories. This script reads those memories and writes real schedule rows, so the
schedule tab starts populated instead of empty.

It is deliberately NOT a `db/migrations.py` migration: it parses prose that only
exists in this one database, and a schema migration must be safe for every
install. Run it once, by hand:

    .venv/Scripts/python.exe tools/import_existing_schedule.py --dry-run
    .venv/Scripts/python.exe tools/import_existing_schedule.py --apply

Idempotent: entries already present (same kind, day, name) are skipped, so a
second run adds nothing.
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402
from app.db import crud  # noqa: E402
from app.db.database import db  # noqa: E402

MON, TUE, WED, THU, FRI, SAT = 0, 1, 2, 3, 4, 5

# --- Routines -------------------------------------------------------------
# Transcribed from the "Monday Wednesday Saturday Schedule" and
# "Tuesday Friday Schedule" memories, which the user dictated block by block.
SET_ONE_DAYS = (MON, WED, SAT)
SET_ONE = (
    ("Django / FastAPI project", "18:00", "19:45"),
    ("Dinner", "19:45", "20:15"),
    ("Japanese", "20:15", "21:15"),
    ("C language / college academics", "21:15", "22:00"),
    ("Self development", "22:00", "22:30"),
    ("Drawing", "22:30", "23:00"),
    ("Diary, planning and reflection", "23:00", "23:20"),
)

SET_TWO_DAYS = (TUE, FRI)
SET_TWO = (
    ("Video editing", "18:00", "20:00"),
    ("Dinner", "20:00", "20:30"),
    ("Japanese", "20:30", "21:30"),
    ("C language / college academics", "21:30", "22:15"),
    ("Self development", "22:15", "22:45"),
    ("Drawing", "22:45", "23:15"),
    # The source memory gives a start only ("11:15 PM: diary"); the 20-minute
    # length mirrors the same block in set one.
    ("Diary", "23:15", "23:35"),
)

# --- College timetable ----------------------------------------------------
# From the "Weekly College Class Schedule" memory. It records subject, code and
# room but no clock times, so these are saved as timed-less weekly entries —
# the day and order are real, the times are simply not known yet.
COLLEGE: dict[int, tuple[tuple[str, str, str], ...]] = {
    MON: (
        ("Data Structures & Algorithms (Lecture)", "25CS2103E-L", "C410"),
        ("Embedded System Design & IoT (Lecture)", "25EC2206E-L", "C406"),
        ("Machine Learning (Skill)", "25SC2107E-S", "C221B2"),
        ("Operating Systems (Skill)", "25CS2104E-S", "C407"),
    ),
    TUE: (
        ("Operating Systems (Lecture)", "25CS2104E-L", "C221B1"),
        ("Machine Learning (Lecture)", "25SC2107E-L", "C211"),
        ("Embedded System Design & IoT (Skill)", "25EC2206E-S", "C221B1"),
        ("Data Structures & Algorithms (Skill)", "25CS2103E-S", "C410"),
    ),
    WED: (
        ("Embedded System Design & IoT (Skill)", "25EC2206E-S", "C406"),
        ("Machine Learning (Practical)", "25SC2107E-P", "C208"),
        ("Japanese Language Proficiency - 2 (Practical)", "25FL2112E-P", "C221B1"),
        ("Operating Systems (Practical)", "25CS2104E-P", "C221B2"),
    ),
    FRI: (
        ("Japanese Language Proficiency - 2 (Practical)", "25FL2112E-P", "C221B1"),
        ("Data Structures & Algorithms (Skill)", "25CS2103E-S", "C407"),
        ("Machine Learning (Skill)", "25SC2107E-S", "C317B"),
        ("Embedded System Design & IoT (Skill)", "25EC2206E-S", "C406"),
        ("Campus Recruitment Training - Coding (Skill)", "CRTCODL1V1-S", "C225"),
    ),
    SAT: (
        ("Operating Systems (Skill)", "25CS2104E-S", "C321B2"),
        ("Data Structures & Algorithms (Practical)", "25CS2103E-P", "C219"),
        ("Embedded System Design & IoT (Skill)", "25EC2206E-S", "R207A"),
        ("Campus Recruitment Training - Coding (Skill)", "CRTCODL1V1-S", "C225"),
    ),
    # Thursday is a holiday per the "Weekly Holidays" memory — no entries.
}


async def _already_there(kind: str, day: int, name: str) -> bool:
    existing = await crud.list_schedules(kind)
    return any(
        row["day_of_week"] == day and row["event_name"].lower() == name.lower()
        for row in existing
    )


async def run(apply: bool) -> int:
    await db.connect()

    planned: list[tuple[str, int, str, str | None, str | None, str | None]] = []

    for days, blocks in ((SET_ONE_DAYS, SET_ONE), (SET_TWO_DAYS, SET_TWO)):
        for day in days:
            for name, start, end in blocks:
                planned.append(("ROUTINE", day, name, start, end, None))

    for day, classes in COLLEGE.items():
        for name, code, room in classes:
            planned.append(("COLLEGE", day, name, None, None, f"{code} | Room {room}"))

    created = skipped = 0
    for kind, day, name, start, end, note in planned:
        if await _already_there(kind, day, name):
            skipped += 1
            continue
        if apply:
            await crud.create_schedule_event(
                event_name=name,
                kind=kind,
                day_of_week=day,
                start_time=start,
                end_time=end,
                location=note.split("Room ")[-1] if note else None,
                notes=note,
            )
        created += 1

    verb = "Imported" if apply else "Would import"
    print(f"{verb} {created} entries; {skipped} already present.")

    if apply:
        groups = await crud.grouped_schedules()
        print(
            f"  college={len(groups['COLLEGE'])} "
            f"routine={len(groups['ROUTINE'])} session={len(groups['SESSION'])}"
        )
        conflicts = await crud.all_schedule_conflicts()
        print(f"  overlaps detected: {len(conflicts)}")

    await db.disconnect()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Actually write the rows.")
    parser.add_argument("--dry-run", action="store_true", help="Report only (default).")
    args = parser.parse_args()

    apply = args.apply and not args.dry_run
    if apply:
        # The whole point of this script is that it edits real, hand-dictated
        # data; take a copy before touching it.
        source = settings.db_file
        backup = source.with_suffix(".db.bak")
        if source.exists():
            shutil.copy2(source, backup)
            print(f"Backup written to {backup}")

    return asyncio.run(run(apply))


if __name__ == "__main__":
    raise SystemExit(main())
