"""Proactive Summary Generator.

Evaluates every open commitment — overdue work, imminent calendar events,
high-priority tasks, in-flight work — ranks them, and emits a prioritized
three-bullet action summary.

This is deliberately *deterministic* rather than a nested LLM call: the brief is
recomputed on every dashboard load, so it must be fast, free and identical for
identical state. JARVIS narrates it; it does not have to author it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.timeutil import days_from_now, humanize_delta, now, now_iso, parse_datetime
from app.db import crud

# Ranking weights. Higher score = surfaced sooner.
_PRIORITY_WEIGHT = {"HIGH": 60, "MEDIUM": 30, "LOW": 10}
_OVERDUE_BONUS = 100
_DUE_TODAY_BONUS = 55
_DUE_SOON_BONUS = 25          # within 72h
_IN_PROGRESS_BONUS = 15
_EVENT_IMMINENT_BONUS = 90    # starts within 2h
_EVENT_TODAY_BONUS = 45

# An item counts as "urgent" — and increments the banner's alert counter —
# at or above this score.
URGENT_THRESHOLD = 85


@dataclass(slots=True)
class BriefItem:
    score: int
    text: str
    kind: str  # 'task' | 'event'
    source_id: int

    @property
    def is_urgent(self) -> bool:
        return self.score >= URGENT_THRESHOLD


def _score_task(task: dict[str, Any]) -> BriefItem:
    reference = now()
    score = _PRIORITY_WEIGHT.get(task["priority"], 30)
    detail = ""

    due = parse_datetime(task.get("due_date"))
    if due is not None:
        delta_hours = (due - reference).total_seconds() / 3600
        if delta_hours < 0:
            score += _OVERDUE_BONUS
        elif due.date() == reference.date():
            score += _DUE_TODAY_BONUS
        elif delta_hours <= 72:
            score += _DUE_SOON_BONUS
        detail = f" ({humanize_delta(due, reference)})"

    if task["status"] == "IN_PROGRESS":
        score += _IN_PROGRESS_BONUS

    label = "Finish" if task["status"] == "IN_PROGRESS" else "Handle"
    text = f"{label} **{task['title']}**{detail} — {task['priority'].lower()} priority"
    return BriefItem(score=score, text=text, kind="task", source_id=task["id"])


def _score_event(event: dict[str, Any]) -> BriefItem:
    reference = now()
    score = 20
    start = parse_datetime(event["time_start"])
    detail = ""

    if start is not None:
        delta_hours = (start - reference).total_seconds() / 3600
        if 0 <= delta_hours <= 2:
            score += _EVENT_IMMINENT_BONUS
        elif start.date() == reference.date():
            score += _EVENT_TODAY_BONUS
        detail = f" {humanize_delta(start, reference)}"

    where = f" @ {event['location']}" if event.get("location") else ""
    text = f"Prepare for **{event['event_name']}**{detail}{where}"
    return BriefItem(score=score, text=text, kind="event", source_id=event["id"])


async def build_brief(bullet_count: int = 3) -> dict[str, Any]:
    """Compute, persist and return the current proactive brief."""
    open_tasks = await crud.list_tasks(statuses=("PENDING", "IN_PROGRESS"))
    events = await crud.list_schedule(now_iso(), days_from_now(3))

    items = [_score_task(task) for task in open_tasks]
    items.extend(_score_event(event) for event in events)
    items.sort(key=lambda item: item.score, reverse=True)

    urgent_count = sum(1 for item in items if item.is_urgent)
    top = items[:bullet_count]

    if not top:
        summary_text = (
            "All clear. No open tasks and nothing on the calendar for the next 72 hours."
        )
    else:
        summary_text = "\n".join(f"- {item.text}" for item in top)

    brief = await crud.save_brief(summary_text, urgent_count)
    await crud.prune_briefs()

    return {
        "id": brief["id"],
        "summary_text": brief["summary_text"],
        "urgent_count": brief["urgent_count"],
        "generated_at": brief["generated_at"],
        "bullets": [item.text for item in top],
        "considered": len(items),
    }


async def get_or_build_brief(max_age_seconds: int = 300) -> dict[str, Any]:
    """Return the stored brief if it is still fresh, otherwise regenerate."""
    latest = await crud.latest_brief()
    if latest is not None:
        generated = parse_datetime(latest["generated_at"])
        if generated is not None and (now() - generated).total_seconds() < max_age_seconds:
            return {
                "id": latest["id"],
                "summary_text": latest["summary_text"],
                "urgent_count": latest["urgent_count"],
                "generated_at": latest["generated_at"],
                "bullets": [
                    line.lstrip("- ").strip()
                    for line in latest["summary_text"].splitlines()
                    if line.strip()
                ],
                "considered": None,
            }
    return await build_brief()
