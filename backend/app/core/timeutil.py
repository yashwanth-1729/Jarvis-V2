"""Time helpers.

JARVIS is a single-user, single-timezone assistant, so every timestamp in the
database is stored as a **local-time, naive ISO-8601 string** in the form
``YYYY-MM-DDTHH:MM:SS``. That keeps "is this due today?" logic trivial and makes
the values lexicographically sortable, which is what the SQLite indices rely on.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

ISO_FORMAT = "%Y-%m-%dT%H:%M:%S"

# Accepted inbound shapes, most specific first.
_PARSE_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d",
)


def now() -> datetime:
    """Current local time, truncated to whole seconds."""
    return datetime.now().replace(microsecond=0)


def now_iso() -> str:
    return now().strftime(ISO_FORMAT)


def to_iso(value: datetime) -> str:
    return value.replace(microsecond=0).strftime(ISO_FORMAT)


def parse_datetime(value: str | None) -> datetime | None:
    """Best-effort parse of a model- or user-supplied datetime string.

    Returns ``None`` for empty input or anything unparseable, so callers can
    treat "no due date" and "unintelligible due date" the same way instead of
    raising mid tool-call.
    """
    if not value:
        return None

    raw = value.strip()
    if not raw:
        return None

    # Tolerate a trailing Z / explicit UTC offset by dropping it: we treat all
    # stored times as local wall-clock time.
    if raw.endswith("Z"):
        raw = raw[:-1]
    if len(raw) > 6 and (raw[-6] in "+-") and raw[-3] == ":":
        raw = raw[:-6]

    for fmt in _PARSE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).replace(microsecond=0)
        except ValueError:
            continue

    try:  # last resort — handles fractional seconds and other ISO variants
        return datetime.fromisoformat(raw).replace(microsecond=0, tzinfo=None)
    except ValueError:
        return None


def normalize_datetime(value: str | None) -> str | None:
    """Parse then re-emit in the canonical storage format, or ``None``."""
    parsed = parse_datetime(value)
    return to_iso(parsed) if parsed else None


def start_of_day(day: date | None = None) -> str:
    target = day or now().date()
    return datetime(target.year, target.month, target.day).strftime(ISO_FORMAT)


def end_of_day(day: date | None = None) -> str:
    target = day or now().date()
    return datetime(target.year, target.month, target.day, 23, 59, 59).strftime(ISO_FORMAT)


def days_from_now(days: int) -> str:
    return to_iso(now() + timedelta(days=days))


# ---------------------------------------------------------------------------
# Weekly recurrence
#
# Recurring schedule entries (a class, a nightly study block) have no single
# date, so they are stored as a weekday plus a wall-clock 'HH:MM' range.
# Weekday numbering follows ``datetime.weekday()``: 0 = Monday .. 6 = Sunday.
# ---------------------------------------------------------------------------

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

_DAY_ALIASES = {
    "mon": 0, "monday": 0,
    "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "weds": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}

_CLOCK_FORMATS = ("%H:%M", "%H.%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H")


def weekday_name(index: int | None) -> str:
    if index is None or not 0 <= index <= 6:
        return ""
    return WEEKDAYS[index]


def parse_weekday(value: Any) -> int | None:
    """Accept an int, a numeric string, or a day name/abbreviation."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 6 else None

    raw = str(value).strip().lower()
    if not raw:
        return None
    if raw.isdigit():
        index = int(raw)
        return index if 0 <= index <= 6 else None
    return _DAY_ALIASES.get(raw.rstrip("."))


def parse_clock(value: str | None) -> str | None:
    """Normalize a wall-clock time to 'HH:MM'.

    Tolerates the shapes a language model actually emits — '6 PM', '18:00',
    '6:00pm', '09.30' — and returns ``None`` for anything unintelligible so a
    bad time degrades to "no time set" rather than raising mid tool-call.
    """
    if not value:
        return None
    raw = str(value).strip().upper().replace("A.M.", "AM").replace("P.M.", "PM")
    if not raw:
        return None
    # '6:00PM' -> '6:00 PM' so the %p formats match.
    if raw.endswith(("AM", "PM")) and not raw[:-2].endswith(" "):
        raw = f"{raw[:-2].strip()} {raw[-2:]}"

    for fmt in _CLOCK_FORMATS:
        try:
            return datetime.strptime(raw, fmt).strftime("%H:%M")
        except ValueError:
            continue

    # Last resort: a full datetime whose time component is what we want.
    parsed = parse_datetime(value)
    return parsed.strftime("%H:%M") if parsed else None


def clock_to_minutes(value: str | None) -> int | None:
    """'18:30' -> 1110. Used for overlap arithmetic."""
    normalized = parse_clock(value)
    if normalized is None:
        return None
    hours, minutes = normalized.split(":")
    return int(hours) * 60 + int(minutes)


def format_clock(value: str | None) -> str:
    """'18:30' -> '6:30 PM' for display and speech."""
    normalized = parse_clock(value)
    if normalized is None:
        return ""
    hour, minute = (int(part) for part in normalized.split(":"))
    suffix = "AM" if hour < 12 else "PM"
    display_hour = hour % 12 or 12
    return f"{display_hour}:{minute:02d} {suffix}"


def humanize_delta(target: datetime, reference: datetime | None = None) -> str:
    """Short relative description used in proactive briefs ('in 2h', '3d overdue')."""
    ref = reference or now()
    delta = target - ref
    seconds = int(delta.total_seconds())
    overdue = seconds < 0
    seconds = abs(seconds)

    if seconds < 60:
        label = "now"
    elif seconds < 3600:
        label = f"{seconds // 60}m"
    elif seconds < 86_400:
        label = f"{seconds // 3600}h"
    else:
        label = f"{seconds // 86_400}d"

    if label == "now":
        return "right now"
    return f"{label} overdue" if overdue else f"in {label}"
