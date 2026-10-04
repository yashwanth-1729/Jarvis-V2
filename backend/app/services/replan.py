"""Catch-up: fit missed Lock-in blocks back into the rest of the week.

Added 2026-10-04 when the owner agreed to "a plan that bends". The usual way
a week dies is one missed block on Tuesday that makes the whole plan feel
broken. Instead, JARVIS offers to fit what slipped into the free time left.

- `missed()` lists serious block occurrences whose time passed with no Done
  that nobody has dealt with yet. It looks at this week, plus yesterday on a
  Monday. A skip stays a skip in the stats: catching up is a new session, not
  an edit of history.
- `propose()` asks GPT-6 Luna for catch-up sessions, then checks every one
  here:
  - inside waking hours, and after now;
  - clear of everything already scheduled and of each other;
  - one per activity per day, at most `DAY_CAP_MINUTES` of catch-up a day;
  - never more time than was missed.

  When the model can't be used (no key, not signed in, out of credit, a bad
  answer), `_greedy` does the same job without it.
- `settle()` records each missed occurrence as `moved` (a catch-up covers it)
  or `dropped` (let go), as focus events, so it stops being offered.

Schedule records are owned by the client (IndexedDB on the phone), so the
client sends what is already booked (`busy`); serious marks and their events
live here.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from app.core.timeutil import clock_to_minutes, now, now_iso, parse_datetime
from app.db import database
from app.providers import openrouter
from app.providers.base import ProviderError
from app.services import focus
from app.services import profile as user_profile

logger = logging.getLogger("jarvis.replan")

#: The planning model, the one the onboarding's week planner uses too.
MODEL = "openai/gpt-6-luna"
#: Catch-up is offered for the rest of this week, but never fewer days than this.
MIN_HORIZON_DAYS = 3
MIN_SESSION = 15
MAX_SESSION = 180
#: At most this much catch-up in one day: a plan that bends, not one that breaks.
DAY_CAP_MINUTES = 180
#: How soon a session may start today, and the gap kept around booked time.
LEAD_MINUTES = 10
BUFFER_MINUTES = 10
DEFAULT_WAKE = "07:00"
DEFAULT_SLEEP = "23:00"
#: Statuses that take an occurrence off the missed list (besides done/running).
SETTLED = ("moved", "dropped")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

SYSTEM = """You are JARVIS, planning catch-up sessions for someone who missed Lock-in sessions they had committed to.

You get the current time, their waking hours, the days left to plan (each with what is already scheduled, and on today the earliest start), and the sessions they missed.

Plan catch-up sessions:
- Only for the missed activities, using their exact names.
- Only on the given days, inside waking hours; on today, not before "earliest".
- Never overlapping anything already scheduled or each other. Leave about 15 minutes between back-to-back things.
- At most one catch-up per activity per day, and no more than about 2 hours of catch-up in any one day.
- Prefer the activity's usual time of day. Prefer sooner over later.
- Per activity, never more minutes in total than were missed. Shorter is fine: 45 focused minutes beat a 2-hour slot that won't happen.
- If the days are packed, fit what matters and leave the rest. Don't cram.

Then write "message": one or two short sentences to them, in their vibe if one is given. Say what moved where, honestly, with no guilt trip and at most one emoji. Under 220 characters. Times as they'd say them (e.g. "Thu 7 PM")."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["message", "sessions"],
    "properties": {
        "message": {"type": "string"},
        "sessions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["activity", "date", "start", "end"],
                "properties": {
                    "activity": {"type": "string"},
                    "date": {"type": "string", "description": "YYYY-MM-DD, one of the given days"},
                    "start": {"type": "string", "description": "HH:MM, 24-hour"},
                    "end": {"type": "string", "description": "HH:MM, 24-hour"},
                },
            },
        },
    },
}


# ------------------------------------------------------------------ helpers

def _clock(minutes: int) -> str:
    minutes = max(0, min(24 * 60, minutes))
    if minutes == 24 * 60:
        return "24:00"
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _minutes(value: Any) -> int | None:
    """'18:30' -> 1110, with '24:00' as the end of the day."""
    text = str(value or "").strip()
    if text in ("24:00", "24:00:00"):
        return 24 * 60
    return clock_to_minutes(text)


def _round5(minutes: int, up: bool = False) -> int:
    return -(-minutes // 5) * 5 if up else round(minutes / 5) * 5


def _since(today: date) -> date:
    """This Monday, or yesterday when today is Monday (Sunday night counts)."""
    monday = today - timedelta(days=today.weekday())
    return min(monday, today - timedelta(days=1))


def horizon(current: datetime) -> list[date]:
    """Days a catch-up may land on: the rest of this week, at least 3 days."""
    today = current.date()
    days = [today + timedelta(days=i) for i in range(7 - today.weekday())]
    while len(days) < MIN_HORIZON_DAYS:
        days.append(days[-1] + timedelta(days=1))
    return days


def _rhythm(profile: dict[str, Any] | None) -> tuple[int, int]:
    """Waking minutes (wake, sleep) from their setup, or a plain default.
    A sleep time at or before waking means after midnight: the day runs to 24:00."""
    profile = profile or {}
    wake = clock_to_minutes(str(profile.get("wake") or "")) or clock_to_minutes(DEFAULT_WAKE) or 7 * 60
    sleep = clock_to_minutes(str(profile.get("sleep") or ""))
    if sleep is None:
        sleep = clock_to_minutes(DEFAULT_SLEEP) or 23 * 60
    if sleep <= wake:
        sleep = 24 * 60
    return wake, sleep


class _Calendar:
    """Free time on each horizon day: the waking window minus booked time."""

    def __init__(self, days: list[date], busy: list[dict[str, Any]], wake: int, sleep: int, current: datetime) -> None:
        self.days = days
        self.window: dict[date, tuple[int, int]] = {}
        self.booked: dict[date, list[tuple[int, int]]] = {day: [] for day in days}
        today = current.date()
        for day in days:
            start = wake
            if day == today:
                start = max(start, _round5(current.hour * 60 + current.minute + LEAD_MINUTES, up=True))
            self.window[day] = (start, sleep)
        for entry in busy:
            day = _date(entry.get("date"))
            begin = _minutes(entry.get("start"))
            end = _minutes(entry.get("end"))
            if day not in self.booked or begin is None:
                continue
            if end is None or end <= begin:
                end = min(24 * 60, begin + 60) if end is None else 24 * 60
            self.booked[day].append((begin, end))

    def open(self, day: date) -> bool:
        start, end = self.window[day]
        return end - start >= MIN_SESSION

    def fits(self, day: date, start: int, end: int, buffer: int = 0) -> bool:
        low, high = self.window.get(day, (0, -1))
        if start < low or end > high or end <= start:
            return False
        return all(end + buffer <= b or start >= e + buffer for b, e in self.booked[day])

    def book(self, day: date, start: int, end: int) -> None:
        self.booked[day].append((start, end))

    def best_slot(self, day: date, length: int, prefer: int, buffer: int) -> tuple[int, int] | None:
        """The free slot of `length` minutes whose start is closest to `prefer`."""
        low, high = self.window[day]
        edges = sorted(self.booked[day])
        gaps: list[tuple[int, int]] = []
        cursor = low
        for begin, end in edges:
            if begin - buffer > cursor:
                gaps.append((cursor, begin - buffer))
            cursor = max(cursor, end + buffer)
        if high > cursor:
            gaps.append((cursor, high))
        best: tuple[int, int] | None = None
        for gap_start, gap_end in gaps:
            first = _round5(gap_start, up=True)
            last = gap_end - length
            if last < first:
                continue
            start = min(max(_round5(prefer), first), last)
            start = start - start % 5 if start % 5 else start
            if start < first:
                start = first
            if start + length > gap_end:
                continue
            if best is None or abs(start - prefer) < abs(best[0] - prefer):
                best = (start, start + length)
        return best


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ missed

async def missed(current: datetime | None = None) -> list[dict[str, Any]]:
    """Serious block occurrences that ended with no Done and were not settled."""
    current = current or now()
    today = current.date()
    first = _since(today)
    items = [item for item in await focus.list_items() if item["kind"] == "block"]
    if not items:
        return []
    rows = await database.db.fetch_all(
        "SELECT item_uid, occurrence FROM focus_events WHERE occurrence >= ?", (first.isoformat(),)
    )
    handled = {(row["item_uid"], row["occurrence"]) for row in rows}
    out: list[dict[str, Any]] = []
    for item in items:
        created = parse_datetime(item["created_at"]) or current
        day = max(first, created.date())
        while day <= today:
            window = focus.block_window(item, day)
            key = (item["uid"], day.isoformat())
            if window and window[0] >= created and window[1] <= current and key not in handled:
                start, end = window
                minutes = round((end - start).total_seconds() / 60)
                timed = item.get("start_time") or (item.get("block_kind") or "").upper() == "SESSION"
                if not timed or minutes > MAX_SESSION * 2:
                    minutes = focus.ASSUMED_MINUTES
                out.append({
                    "uid": item["uid"],
                    "title": item["title"],
                    "mode": item["mode"],
                    "occurrence": day.isoformat(),
                    "weekday": day.weekday(),
                    "start": start.strftime("%H:%M") if timed else None,
                    "end": end.strftime("%H:%M") if timed else None,
                    "minutes": max(MIN_SESSION, min(MAX_SESSION, minutes)),
                })
            day += timedelta(days=1)
    out.sort(key=lambda m: (m["occurrence"], m["start"] or "", m["title"]))
    return out


# ------------------------------------------------------------------ proposals

def _check(proposals: Any, misses: list[dict[str, Any]], calendar: _Calendar) -> list[dict[str, Any]]:
    """Keep only proposals that obey every rule; trim lengths to what was missed."""
    names = {miss["title"].strip().lower(): miss["title"] for miss in misses}
    budget: dict[str, int] = defaultdict(int)
    for miss in misses:
        budget[miss["title"].strip().lower()] += int(miss["minutes"])
    per_day: dict[date, int] = defaultdict(int)
    seen: set[tuple[str, date]] = set()
    accepted: list[dict[str, Any]] = []
    for raw in (proposals if isinstance(proposals, list) else [])[:16]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("activity") or "").strip().lower()
        day = _date(raw.get("date"))
        begin = _minutes(raw.get("start"))
        end = _minutes(raw.get("end"))
        if name not in names or day not in calendar.window or begin is None or end is None:
            continue
        if end == 0 and begin > 0:
            end = 24 * 60
        begin, end = _round5(begin), _round5(end)
        low, high = calendar.window[day]
        begin, end = max(begin, low), min(end, high)
        end = min(end, begin + MAX_SESSION, begin + budget[name])
        end -= (end - begin) % 5
        length = end - begin
        if length < MIN_SESSION or (name, day) in seen or per_day[day] + length > DAY_CAP_MINUTES:
            continue
        if not calendar.fits(day, begin, end):
            continue
        calendar.book(day, begin, end)
        seen.add((name, day))
        per_day[day] += length
        budget[name] -= length
        accepted.append({"title": names[name], "date": day.isoformat(), "start": _clock(begin), "end": _clock(end), "minutes": length})
    return accepted


def _greedy(misses: list[dict[str, Any]], calendar: _Calendar) -> list[dict[str, Any]]:
    """No model: each miss goes to the earliest day with room, as close to its
    usual time as the free time allows, shortened to 45 minutes if it must."""
    per_day: dict[date, int] = defaultdict(int)
    seen: set[tuple[str, date]] = set()
    placed: list[dict[str, Any]] = []
    for miss in misses:
        name = miss["title"].strip().lower()
        need = min(int(miss["minutes"]), MAX_SESSION)
        prefer = clock_to_minutes(miss.get("start") or "") or 18 * 60
        for length in dict.fromkeys((need, max(MIN_SESSION, min(need, 45)))):
            slot = None
            for day in calendar.days:
                if not calendar.open(day) or (name, day) in seen or per_day[day] + length > DAY_CAP_MINUTES:
                    continue
                found = calendar.best_slot(day, length, prefer, BUFFER_MINUTES)
                if found:
                    slot = (day, *found)
                    break
            if slot:
                day, begin, end = slot
                calendar.book(day, begin, end)
                seen.add((name, day))
                per_day[day] += length
                placed.append({"title": miss["title"], "date": day.isoformat(), "start": _clock(begin), "end": _clock(end), "minutes": length})
                break
    return placed


def _cover(sessions: list[dict[str, Any]], misses: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Each session covers the earliest uncovered miss of its activity."""
    queues: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for miss in misses:
        queues[miss["title"].strip().lower()].append(miss)
    out = []
    for session in sorted(sessions, key=lambda s: (s["date"], s["start"])):
        queue = queues.get(session["title"].strip().lower()) or []
        covers = queue.pop(0) if queue else None
        out.append({**session, "covers": {"uid": covers["uid"], "occurrence": covers["occurrence"], "mode": covers["mode"]} if covers else None})
    left = [miss for queue in queues.values() for miss in queue]
    return out, sorted(left, key=lambda m: (m["occurrence"], m["start"] or ""))


def _say_when(session: dict[str, Any]) -> str:
    day = WEEKDAYS[date.fromisoformat(session["date"]).weekday()]
    hour, minute = map(int, session["start"].split(":"))
    suffix = "AM" if hour < 12 else "PM"
    shown = hour % 12 or 12
    return f"{day} {shown}{':%02d' % minute if minute else ''} {suffix}"


def _basic_message(sessions: list[dict[str, Any]], left: list[dict[str, Any]]) -> str:
    if not sessions:
        return "No room left this week. Let it go and hit the next one clean."
    first = sessions[0]
    lead = f"{first['title']} moves to {_say_when(first)}"
    more = f", plus {len(sessions) - 1} more" if len(sessions) > 1 else ""
    tail = f" {len(left)} didn't fit; let {'it' if len(left) == 1 else 'them'} go." if left else " Back on track."
    return f"{lead}{more}.{tail}"


def _prompt(misses: list[dict[str, Any]], calendar: _Calendar, current: datetime, profile: dict[str, Any] | None) -> str:
    today = current.date()
    wake, sleep = _rhythm(profile)
    days = []
    for day in calendar.days:
        start, end = calendar.window[day]
        entry: dict[str, Any] = {
            "date": day.isoformat(),
            "weekday": WEEKDAYS[day.weekday()],
            "scheduled": [{"start": _clock(b), "end": _clock(e)} for b, e in sorted(calendar.booked[day])],
        }
        if day == today:
            entry["earliest"] = _clock(start) if start < end else "none (day is over)"
        days.append(entry)
    return json.dumps({
        "now": f"{current:%Y-%m-%d %H:%M} ({WEEKDAYS[today.weekday()]})",
        "awake": {"from": _clock(wake), "to": _clock(sleep)},
        "days": days,
        "missed": [
            {
                "activity": miss["title"],
                "date": miss["occurrence"],
                "weekday": WEEKDAYS[miss["weekday"]],
                "usual_time": f"{miss['start']}-{miss['end']}" if miss["start"] else "any time",
                "minutes": miss["minutes"],
            }
            for miss in misses
        ],
        "about": user_profile.persona_note(profile) if profile else None,
    }, ensure_ascii=False)


async def propose(busy: list[dict[str, Any]], *, current: datetime | None = None, use_model: bool = True) -> dict[str, Any]:
    """Catch-up sessions for everything missed, and a line to say about it."""
    current = current or now()
    misses = await missed(current)
    if not misses:
        return {"missed": [], "sessions": [], "left": [], "message": "Nothing slipped. Clean week so far.", "source": "none"}
    profile = user_profile.load()
    wake, sleep = _rhythm(profile)
    calendar = _Calendar(horizon(current), busy, wake, sleep, current)

    sessions: list[dict[str, Any]] = []
    message = ""
    source = "basic"
    if use_model:
        try:
            answer, usage = await openrouter.complete_json(
                [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(misses, calendar, current, profile)}],
                name="catch_up", schema=SCHEMA, model=MODEL, max_tokens=1500,
            )
            # Check against a copy, so a rejected answer leaves the calendar
            # untouched for the plain placer.
            trial = _Calendar(calendar.days, [], wake, sleep, current)
            trial.window, trial.booked = dict(calendar.window), {d: list(b) for d, b in calendar.booked.items()}
            sessions = _check(answer.get("sessions"), misses, trial)
            if sessions:
                calendar = trial
                message = " ".join(str(answer.get("message") or "").split())[:240]
                source = "ai"
            logger.info("catch-up: %d proposed, %d kept, usage=%s", len(answer.get("sessions") or []), len(sessions), usage)
        except ProviderError as exc:
            logger.info("catch-up: model unavailable (%s); using the plain placer", exc)
    if not sessions:
        sessions = _greedy(misses, calendar)
    covered, left = _cover(sessions, misses)
    return {
        "missed": misses,
        "sessions": covered,
        "left": left,
        "message": message or _basic_message(covered, left),
        "source": source if covered else "none",
    }


# ------------------------------------------------------------------ settle

async def settle(moved: list[dict[str, Any]], dropped: list[dict[str, Any]]) -> int:
    """Take missed occurrences off the list: `moved` (a catch-up covers it) or
    `dropped` (let go). Already-settled or finished ones are left alone."""
    recorded = 0
    stamp = now_iso()
    for status, entries in (("moved", moved), ("dropped", dropped)):
        for entry in entries:
            uid = str(entry.get("uid") or "")
            occurrence = str(entry.get("occurrence") or "")
            if not uid or _date(occurrence) is None:
                continue
            item = await focus.get_item(uid)
            if item is None:
                continue
            exists = await database.db.fetch_one(
                "SELECT id FROM focus_events WHERE item_uid = ? AND occurrence = ? LIMIT 1", (uid, occurrence)
            )
            if exists:
                continue
            await database.db.execute(
                "INSERT INTO focus_events (item_uid, title, occurrence, status, finished_at) VALUES (?, ?, ?, ?, ?)",
                (uid, item["title"], occurrence, status, stamp),
            )
            recorded += 1
    return recorded
