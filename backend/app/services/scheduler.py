"""Makes the schedule act instead of merely existing.

JARVIS has always known the user's timetable. It could recite it, reason about
it, and put it on a dashboard — and then the class would start and nothing would
happen. Every "reminder" it accepted was a row in a table nobody was watching.
This is the loop that watches.

What it fires on, in order of how much the user notices:

* **reminders** they asked for out loud ("remind me in twenty minutes"),
* **schedule entries** — weekly classes and routines, and one-off sessions —
  a short lead time before they start,
* **tasks** falling due.

Two decisions worth stating, because both could reasonably have gone the other
way.

*No cron expressions.* OpenClaw's equivalent asks you to author a schedule in a
second language. JARVIS already has this data, in the user's own words: they
said "my Java class is Monday at 7:30" months ago and it became a row. Firing
from that row means the thing they already told it is the thing that happens.

*Interruption is earned, not automatic.* Everything due does not deserve to be
said aloud. The urgency scoring in `proactive.py` already ranks what matters --
deterministic, free, and tuned against this user's real board -- so it decides
what crosses the threshold. A loop that announces everything gets muted, and a
muted assistant is worse than a silent one.

Desktop only. The Android build is deliberately foreground-only (see
`frontend/src/lib/lifecycle.ts`), so a background timer there would be firing
into a process the OS is about to freeze.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from app.core.config import settings
from app.core.timeutil import (
    WEEKDAYS,
    clock_to_minutes,
    format_clock,
    now,
    parse_datetime,
    to_iso,
)
from app.db import crud
from app.services import notification_policy, proactive

logger = logging.getLogger("jarvis.scheduler")

#: How often the loop wakes. Fine-grained enough that a lead time of ten
#: minutes is not silently a lead time of fifteen, coarse enough to be free.
TICK_SECONDS = 30

#: How far ahead of a scheduled block to speak up.
LEAD_MINUTES = 10

#: A block whose start is further past than this is not worth announcing -- the
#: machine was probably asleep, and being told about a class that started forty
#: minutes ago is noise, not help.
STALE_AFTER_MINUTES = 20

#: Below this, a due item is recorded but not pushed at the user. Matches the
#: banner threshold in `proactive.py`, so "urgent enough to interrupt" means the
#: same thing everywhere.
URGENCY_TO_INTERRUPT = proactive.URGENT_THRESHOLD


def _spoken_time(value: str | None) -> str:
    """'19:30' -> '7:30 PM', for something that will be read aloud."""
    return format_clock(value) or (value or "")


def _occurrence_today(day: datetime, clock: str | None) -> datetime | None:
    minutes = clock_to_minutes(clock)
    if minutes is None:
        return None
    return day.replace(hour=minutes // 60, minute=minutes % 60, second=0, microsecond=0)


def _reminder_announcement_text(reminder: dict) -> str:
    """The plain reminder text, or an early-notice framing if this row is one.

    A row with `target_at` set is the early half of a default (non-instant)
    reminder -- `due_at` on it is already the lead moment, so the delta to
    `target_at` is exactly how much notice this is. Computed from the two
    stored timestamps rather than a fixed "15 minutes", since
    `_handle_set_reminder` clamps the lead when the target was too close to
    give the full REMINDER_LEAD_MINUTES.
    """
    target = parse_datetime(reminder.get("target_at"))
    if target is None:
        return reminder["text"]
    due = parse_datetime(reminder["due_at"])
    lead = round((target - due).total_seconds() / 60) if due else 0
    if lead <= 0:
        return reminder["text"]
    unit = "minute" if lead == 1 else "minutes"
    return f"In {lead} {unit}, at {_spoken_time(target.strftime('%H:%M'))}: {reminder['text']}"


async def _collect_reminders(current: datetime, policy: dict) -> int:
    queued = 0
    for reminder in await crud.due_reminders(to_iso(current)):
        reference = f"reminder:{reminder['id']}"
        if not notification_policy.permits(policy, reference, "reminders"):
            # Its moment passed while muted. Consume it rather than surprising
            # the user hours later when they turn an unrelated category on.
            await crud.mark_reminder_fired(reminder["id"])
            continue
        if await crud.record_announcement(
            kind="reminder",
            ref_id=reminder["id"],
            occurrence_at=reminder["due_at"],
            text=_reminder_announcement_text(reminder),
            # A reminder was asked for explicitly. That is the strongest signal
            # of intent available, so it always crosses the threshold.
            urgency=100,
        ):
            queued += 1
        await crud.mark_reminder_fired(reminder["id"])
    return queued


async def _collect_schedule(current: datetime, policy: dict) -> int:
    """Announce blocks starting within the lead window."""
    horizon = current + timedelta(minutes=LEAD_MINUTES)
    stale = current - timedelta(minutes=STALE_AFTER_MINUTES)
    queued = 0

    for row in await crud.list_schedules(expire=False):
        category = (
            "college" if row.get("kind") == "COLLEGE"
            else "routine" if row.get("kind") == "ROUTINE"
            else "blocks"
        )
        reference = f"schedule:{row.get('uid')}"
        if not row.get("uid") or not notification_policy.permits(
            policy, reference, category
        ):
            continue
        # Weekly rows carry day_of_week + start_time; one-offs carry time_start.
        #
        # Weekly is checked FIRST, and that order is load-bearing. Rows in the
        # real database carry both: a weekly class with `day_of_week=5,
        # start_time='09:00'` also had a leftover `time_start` of a date months
        # ago. Reading `time_start` first turned that class into a one-off that
        # had already happened, so it silently never fired again — the weekly
        # half of the row was dead and nothing said so.
        #
        # When both are present the recurring slot is the live one: it names a
        # day and a clock time, which is a standing arrangement, where
        # `time_start` is a single moment that has passed.
        weekly = row.get("day_of_week") is not None and row.get("start_time")
        if weekly:
            if int(row["day_of_week"]) != current.weekday():
                continue
            start = _occurrence_today(current, row.get("start_time"))
        elif row.get("time_start"):
            start = parse_datetime(row["time_start"])
        else:
            continue

        if start is None or not (stale <= start <= horizon):
            continue

        minutes_away = max(0, round((start - current).total_seconds() / 60))
        when = "now" if minutes_away <= 1 else f"in {minutes_away} minutes"
        text = f"{row['event_name']} starts {when}, at {_spoken_time(row.get('start_time')) or start.strftime('%I:%M %p').lstrip('0')}."
        if row.get("location"):
            text += f" {row['location']}."

        if await crud.record_announcement(
            kind="schedule",
            ref_id=row["id"],
            # The *occurrence*, not the row: a weekly class must be announceable
            # again next Monday, but only once this Monday.
            occurrence_at=to_iso(start),
            text=text,
            urgency=proactive.URGENT_THRESHOLD + 5,
        ):
            queued += 1
    return queued


async def _collect_tasks(current: datetime, policy: dict) -> int:
    """Announce a task the moment it comes due, once."""
    queued = 0
    for task in await crud.list_tasks(statuses=("PENDING", "IN_PROGRESS")):
        reference = f"task:{task.get('uid')}"
        if not task.get("uid") or not notification_policy.permits(
            policy, reference, "deadline_tasks"
        ):
            continue
        due = parse_datetime(task.get("due_date"))
        if due is None or due > current:
            continue
        if due < current - timedelta(days=1):
            continue  # long overdue; the brief already covers it

        score = proactive.urgency_of_task(task)

        if await crud.record_announcement(
            kind="task",
            ref_id=task["id"],
            occurrence_at=to_iso(due),
            text=f"{task['title']} is due now.",
            # A deadline is the user's selected notification boundary. Priority
            # ranks the card; it must not silently suppress an enabled alarm.
            urgency=max(int(score), URGENCY_TO_INTERRUPT),
        ):
            queued += 1
    return queued


async def tick(current: datetime | None = None) -> int:
    """One pass. Returns how many new announcements were queued.

    Takes the clock as a parameter so tests can drive it without waiting, and
    never raises: a scheduler that dies on one malformed row stops firing
    everything, silently, which is the worst possible failure for this feature.
    """
    moment = current or now()
    await crud.expire_sessions(moment)
    await crud.expire_memories(moment)
    policy = await notification_policy.load()
    queued = 0
    for collect in (_collect_reminders, _collect_schedule, _collect_tasks):
        try:
            queued += await collect(moment, policy)
        except Exception:  # noqa: BLE001
            logger.exception("Scheduler pass %s failed", collect.__name__)
    return queued


async def run_forever(stop: asyncio.Event | None = None) -> None:
    stop = stop or asyncio.Event()
    logger.info(
        "Scheduler watching the timetable (every %ds, %dm lead)",
        TICK_SECONDS,
        LEAD_MINUTES,
    )
    ticks = 0
    while not stop.is_set():
        try:
            queued = await tick()
            if queued:
                logger.info("Queued %d announcement(s)", queued)
            ticks += 1
            # Roughly daily, on a 30s tick.
            if ticks % 2880 == 0:
                await crud.prune_announcements()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Scheduler tick failed")

        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            continue
    logger.info("Scheduler stopped")
