"""Context Synthesizer.

Builds the compact state snapshot that gets appended to the system prompt on
every turn, so JARVIS knows roughly what is on the board without having to spend
a tool round-trip calling ``get_dashboard_summary`` first.

It is intentionally terse and hard-capped: this text is regenerated per request
and therefore sits *after* the cached system-prompt breakpoint, so every token
here is paid in full on every turn.
"""

from __future__ import annotations

from typing import Any

from app.core.timeutil import now, parse_datetime
from app.db import crud

MAX_TASKS = 12
MAX_EVENTS = 6
MAX_IDEAS = 5
MAX_MEMORIES = 8


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
    when = start.strftime("%a %d %b %H:%M") if start else event["time_start"]
    where = f" @ {event['location']}" if event.get("location") else ""
    return f"  #{event['id']} {when} — {event['event_name']}{where}"


async def build_context_snapshot() -> str:
    """Return the human-readable state block injected into the system prompt."""
    current = now()

    open_tasks = await crud.list_tasks(statuses=("PENDING", "IN_PROGRESS"), limit=MAX_TASKS)
    upcoming = await crud.upcoming_schedule(days=7, limit=MAX_EVENTS)
    ideas = await crud.list_ideas(statuses=("DRAFT", "ACTIVE"), limit=MAX_IDEAS)
    memories = await crud.list_memories(limit=MAX_MEMORIES)
    counts = await crud.count_tasks_by_status()

    lines: list[str] = [
        "<current_state>",
        f"Local date/time: {current.strftime('%A %d %B %Y, %H:%M')}",
        (
            f"Task counts: {counts['PENDING']} pending, "
            f"{counts['IN_PROGRESS']} in progress, {counts['COMPLETED']} completed"
        ),
        "",
        f"Open tasks (top {MAX_TASKS}):",
    ]
    if open_tasks:
        lines.extend(_fmt_task(task) for task in open_tasks)
    else:
        lines.append("  (none)")

    lines.append("")
    lines.append("Schedule, next 7 days:")
    if upcoming:
        lines.extend(_fmt_event(event) for event in upcoming)
    else:
        lines.append("  (nothing scheduled)")

    if ideas:
        lines.append("")
        lines.append("Active ideas / notes:")
        lines.extend(f"  #{idea['id']} [{idea['status']}] {idea['title']}" for idea in ideas)

    if memories:
        lines.append("")
        lines.append("Long-term memory keys:")
        lines.extend(f"  {mem['key_concept']} [{mem['category']}]" for mem in memories)

    lines.append("</current_state>")
    return "\n".join(lines)
