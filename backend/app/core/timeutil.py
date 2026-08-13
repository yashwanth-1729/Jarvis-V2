"""Time helpers.

JARVIS is a single-user, single-timezone assistant, so every timestamp in the
database is stored as a **local-time, naive ISO-8601 string** in the form
``YYYY-MM-DDTHH:MM:SS``. That keeps "is this due today?" logic trivial and makes
the values lexicographically sortable, which is what the SQLite indices rely on.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

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
