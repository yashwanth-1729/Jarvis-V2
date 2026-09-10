"""Regression checks for human 12-hour reminder interpretation."""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.llm.tools import _resolve_reminder_moment


def check(label: str, actual: datetime | None, expected: datetime) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")
    print(f"PASS {label}")


current = datetime(2026, 9, 9, 16, 39)

check(
    "bare 5:15 after 4:39 PM becomes the upcoming 5:15 PM",
    _resolve_reminder_moment("2026-09-09T05:15:00", "5:15", current),
    datetime(2026, 9, 9, 17, 15),
)
check(
    "explicit PM repairs a contradictory model timestamp",
    _resolve_reminder_moment("2026-09-09T05:15:00", "5:15 PM", current),
    datetime(2026, 9, 9, 17, 15),
)
check(
    "explicit AM is preserved and remains eligible for the past-time refusal",
    _resolve_reminder_moment("2026-09-09T05:15:00", "5:15 AM", current),
    datetime(2026, 9, 9, 5, 15),
)
check(
    "an already-correct 24-hour PM timestamp stays unchanged",
    _resolve_reminder_moment("2026-09-09T17:15:00", "5:15", current),
    datetime(2026, 9, 9, 17, 15),
)
check(
    "a bare time is not pushed twelve hours if that is also past",
    _resolve_reminder_moment(
        "2026-09-09T05:15:00",
        "5:15",
        datetime(2026, 9, 9, 18, 0),
    ),
    datetime(2026, 9, 9, 5, 15),
)

print("5 passed")
