"""Focused regression checks for safe agent-driven schedule edits.

Uses a throwaway database and never calls Sarvam or touches user records.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

DB_PATH = Path(tempfile.gettempdir()) / "jarvis_schedule_update_test.db"
for suffix in ("", "-wal", "-shm"):
    candidate = Path(str(DB_PATH) + suffix)
    if candidate.exists():
        candidate.unlink()
os.environ["JARVIS_DB_PATH"] = str(DB_PATH)

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not condition:
        failures.append(label)


async def main() -> int:
    from app.db import crud
    from app.db.database import db
    from app.llm.tools import execute_tool

    await db.connect()
    monday = await crud.create_schedule_event(
        "Data Structures & Algorithms (Lecture)",
        kind="COLLEGE",
        day_of_week=0,
        notes="25CS2103E-L | Room C410",
    )
    tuesday = await crud.create_schedule_event(
        "Data Structures & Algorithms (Skill)",
        kind="COLLEGE",
        day_of_week=1,
        notes="25CS2103E-S | Room C407",
    )
    assert monday and tuesday

    guessed = await execute_tool(
        "update_schedule_event",
        {"event_id": 1, "start_time": "03:00", "end_time": "04:00"},
    )
    check("blind id update is rejected", guessed.is_error)

    wrong_identity = await execute_tool(
        "update_schedule_event",
        {
            "event_id": monday["id"],
            "matching": "25EC2206E-L",
            "start_time": "03:00",
            "end_time": "04:00",
        },
    )
    check("id must match human-readable identity", wrong_identity.is_error)

    changed = await execute_tool(
        "update_schedule_event",
        {
            "matching": "25CS2103E-L",
            "match_day_of_week": 0,
            "match_kind": "COLLEGE",
            "college_block": 1,
        },
    )
    check("course code and current day resolve safely", not changed.is_error, changed.content)
    monday_after = await crud.get_schedule_event(monday["id"])
    tuesday_after = await crud.get_schedule_event(tuesday["id"])
    check(
        "Block 1 maps to real wall-clock time",
        monday_after is not None
        and monday_after["start_time"] == "09:30"
        and monday_after["end_time"] == "11:00",
    )
    check(
        "another weekday is untouched",
        tuesday_after is not None
        and tuesday_after["day_of_week"] == 1
        and tuesday_after["start_time"] is None,
    )

    invalid_range = await execute_tool(
        "update_schedule_event",
        {
            "matching": "25CS2103E-S",
            "match_day_of_week": 1,
            "start_time": "08:00",
            "end_time": "08:00",
        },
    )
    check("zero-length weekly range is rejected", invalid_range.is_error)

    unsafe_move = await execute_tool(
        "update_schedule_event",
        {
            "event_id": monday["id"],
            "matching": "25CS2103E-L",
            "day_of_week": 5,
        },
    )
    check("weekday move requires current-day proof", unsafe_move.is_error)
    still_monday = await crud.get_schedule_event(monday["id"])
    check("rejected move changes nothing", still_monday is not None and still_monday["day_of_week"] == 0)

    await db.disconnect()
    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
