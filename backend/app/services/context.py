"""Context Synthesizer.

Builds the compact state snapshot that gets appended to the system prompt on
every turn, so JARVIS knows roughly what is on the board without having to spend
a tool round-trip calling ``get_dashboard_summary`` first.

It is intentionally terse and hard-capped: this text is regenerated per request
and therefore sits *after* the cached system-prompt breakpoint, so every token
here is paid in full on every turn.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.core.timeutil import WEEKDAYS, now, parse_datetime
from app.db import crud
from app.services import memory as memory_service
from app.services import notification_policy

MAX_TASKS = 12
MAX_EVENTS = 6
MAX_IDEAS = 5

#: How many stored memories reach the model each turn.
#:
#: Raised from 8 after finding the cap firing in real use: there were nine
#: memories, and the one being silently dropped was "Weekly College Class
#: Schedule" -- the actual timetable -- because selection is
#: ``ORDER BY updated_at DESC`` and it had not been rewritten recently. The
#: model was answering timetable questions with the timetable withheld, and
#: nothing anywhere said so.
#:
#: This is a stopgap, not a fix. Recency of last *write* is a poor proxy for
#: relevance, and any fixed cap has the same cliff a bit further out; the real
#: answer is retrieval scored against the turn, which is the memory phase.
#: Until then the ceiling is high enough to clear the whole store, and
#: `build_context_snapshot` says out loud when it is exceeded rather than
#: truncating in silence.
MAX_RELEVANT_MEMORIES = 8


def _fmt_due(value: str | None) -> str:
    parsed = parse_datetime(value)
    if parsed is None:
        return "no due date"
    overdue = " OVERDUE" if parsed < now() else ""
    return parsed.strftime("%a %d %b %H:%M") + overdue


def _fmt_task(task: dict[str, Any]) -> str:
    return (
        f"  #{task['id']} [{task['priority']}/{task['status']}] {task['title']} "
        f"— {_fmt_due(task.get('due_date'))}"
    )


def _fmt_event(event: dict[str, Any]) -> str:
    start = parse_datetime(event["time_start"])
    when = start.strftime("%a %d %b %H:%M") if start else (event["time_start"] or "")
    where = f" @ {event['location']}" if event.get("location") else ""
    return f"  #{event['id']} {when} — {event['event_name']}{where}"


def _fmt_weekly(entries: list[dict[str, Any]]) -> list[str]:
    """Weekly entries grouped by day.

    The whole timetable is included rather than a window of it: it is small,
    it rarely changes, and without it the model answers "I don't have your
    Monday schedule" when the rows are sitting in the database.
    """
    lines: list[str] = []
    for index, day in enumerate(WEEKDAYS):
        todays = [e for e in entries if e.get("day_of_week") == index]
        if todays:
            slots = ", ".join(f"{e['event_name']} {e['window']}" for e in todays)
            lines.append(f"  {day}: {slots}")
    return lines


def _active_and_next(
    today: list[dict[str, Any]], current: datetime
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Which block is running right now, and which is next.

    Computed here rather than left to the model. Asked "what am I meant to be
    doing", it was doing clock arithmetic against a list of ranges and getting
    it wrong — reporting a block that had already finished, then defending the
    wrong answer when corrected. A lookup cannot drift.
    """
    minutes_now = current.hour * 60 + current.minute
    active: dict[str, Any] | None = None
    upcoming: dict[str, Any] | None = None

    for entry in today:
        start = parse_datetime(entry.get("time_start"))
        if start is None:
            continue  # a class with no time recorded
        start_minutes = start.hour * 60 + start.minute

        end = parse_datetime(entry.get("time_end"))
        end_minutes = (end.hour * 60 + end.minute) if end else start_minutes + 60

        if start_minutes <= minutes_now < end_minutes:
            active = entry
        elif start_minutes > minutes_now and upcoming is None:
            upcoming = entry

    return active, upcoming


def _describe_block(entry: dict[str, Any] | None) -> str:
    if entry is None:
        return "nothing"
    window = entry.get("window") or ""
    return f"{entry['event_name']} ({window})".strip()


async def _current_location() -> str:
    """The user's remembered position, as one line of state.

    Present so the model never has to guess. Without it, "what's the weather"
    had no notion of here at all, and the model filled the gap with the word
    "current" — which a geocoder resolved to an island in the Bahamas.

    Read-only and failure-tolerant on purpose: this runs on the hot path of
    every turn, and no state line is worth failing a conversation over.
    """
    try:
        from app.services import location

        stored = await location.remembered()
    except Exception:  # noqa: BLE001 - a missing line beats a broken turn
        return "unknown"
    if not stored:
        return "unknown (ask, or say the city)"
    return str(stored.get("label") or "unknown")


async def build_context_snapshot(full_schedule: bool = True, user_text: str = "") -> str:
    """Return the human-readable state block injected into the system prompt.

    `full_schedule` carries the whole weekly grid. See the note beside it
    below -- it is the single largest thing here, and including it on every
    turn made unrelated questions come back as the timetable.
    """
    current = now()

    open_tasks = await crud.list_tasks(statuses=("PENDING", "IN_PROGRESS"), limit=MAX_TASKS)
    groups = await crud.grouped_schedules()
    today = await crud.todays_schedule()
    ideas = await crud.list_ideas(statuses=("DRAFT", "ACTIVE"), limit=MAX_IDEAS)
    memories = await memory_service.retrieve(
        user_text, limit=MAX_RELEVANT_MEMORIES, include_candidates=False
    )
    actions = await memory_service.retrieve_actions(user_text, limit=4)
    counts = await crud.count_tasks_by_status()
    where = await _current_location()
    notify = notification_policy.describe(await notification_policy.load())

    active, upcoming = _active_and_next(today, current)

    lines: list[str] = [
        "<current_state>",
        # Stated plainly, as a field among fields.
        #
        # This was once three emphatic sentences in capitals, added to stop the
        # model reasoning from a stale time it had inferred earlier. That worked
        # and overcorrected: salience is contagious, and the loudest line in the
        # context became the thing the model mentioned in every reply, whether or
        # not the clock had anything to do with the question. The rules about
        # trusting it live in the system prompt, which is where instructions
        # belong; this block is data.
        # Written as fields, not as a sentence, and deliberately not first.
        #
        # It used to lead the block as "Now: 22:59 (10:59 PM), Tuesday 25
        # August 2026" -- and that exact string came back out of JARVIS's
        # mouth, in Telugu, as the entire answer to "delete the tasks I created
        # today". The clock line was the most quotable thing in the context and
        # sat at the top of it, so when the model had nothing better to say it
        # said that.
        #
        # Splitting the clock from the date and labelling both as fields makes
        # the line harder to recite as a sentence, and putting the schedule
        # first means the top of the block is the thing most questions are
        # actually about.
        f"Current block: {_describe_block(active)}",
        f"Next block: {_describe_block(upcoming)}",
        f"Location: {where}",
        f"Clock: {current.strftime('%H:%M')} ({current.strftime('%I:%M %p').lstrip('0')})",
        f"Date: {current.strftime('%A %d %B %Y')}",
        f"Notifications: {notify}",
        "",
        f"Task counts: {counts['PENDING']} pending, {counts['IN_PROGRESS']} in progress",
        "",
        f"TASK BOARD (top {MAX_TASKS}):",
    ]
    if open_tasks:
        lines.extend(_fmt_task(task) for task in open_tasks)
    else:
        lines.append("  (none)")

    # The whole week, only when the week is plausibly the subject.
    #
    # This is the largest thing in the state block by a wide margin, and the
    # block as a whole runs to about six thousand characters -- bigger than the
    # entire voice prompt -- sitting immediately before every question. A
    # message carrying no content of its own then gets answered from the
    # biggest nearby thing: asked "Again" straight after "Name three colours",
    # JARVIS read out the day's timetable.
    #
    # Today's blocks stay in unconditionally; they are small and are what most
    # questions actually touch. The full grid is fetchable with
    # `get_dashboard_summary` when it is genuinely wanted, so nothing is lost
    # except the pull it was exerting on every unrelated turn.
    if full_schedule:
        lines.append("")
        lines.append("COLLEGE TIMETABLE (weekly):")
        lines.extend(_fmt_weekly(groups["COLLEGE"]) or ["  (none saved)"])

        lines.append("")
        lines.append("DAY ROUTINES (weekly):")
        lines.extend(_fmt_weekly(groups["ROUTINE"]) or ["  (none saved)"])

        lines.append("")
        lines.append("BOOKED SESSIONS (one-off):")
        upcoming = [
            e for e in groups["SESSION"]
            if (e["time_start"] or "") >= current.strftime("%Y-%m-%d")
        ]
        lines.extend(
            [_fmt_event(event) for event in upcoming[:MAX_EVENTS]] or ["  (none booked)"]
        )
    else:
        lines.append("")
        lines.append(
            "WEEKLY TIMETABLE: not shown for this turn. Call "
            "get_dashboard_summary if the user asks about the week."
        )

    lines.append("")
    lines.append(f"ON TODAY ({WEEKDAYS[current.weekday()]}), all kinds merged:")
    lines.extend(
        [f"  [{e['kind']}] {e['window']} {e['event_name']}" for e in today]
        or ["  (nothing on today)"]
    )

    if ideas:
        lines.append("")
        lines.append("IDEAS / NOTES:")
        lines.extend(f"  #{idea['id']} [{idea['status']}] {idea['title']}" for idea in ideas)

    if memories:
        lines.append("")
        # Content, not just keys: these hold the standing rules the user has
        # dictated, and a bare key tells the model nothing it can act on.
        lines.append("RELEVANT MEMORY (ranked for this request):")
        lines.extend(
            f"  [{mem['memory_type']}] {mem['key_concept']}"
            f"{(' [until ' + mem['expires_at'] + ']') if mem.get('expires_at') else ''}: "
            f"{mem['content'][:280]}"
            for mem in memories
        )
        lines.append("  (use search_memory if the needed detail is not in this ranked set)")

    if actions:
        lines.append("")
        lines.append("RELEVANT RECENT ACTIONS:")
        lines.extend(
            f"  {action['created_at']} [{action['status']}] {action['action_name']}"
            for action in actions
        )

    lines.append("</current_state>")
    return "\n".join(lines)
