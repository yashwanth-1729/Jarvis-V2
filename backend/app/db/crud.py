"""Typed CRUD helpers. Every function here is the *only* place raw SQL lives for
its table, so the API layer, the tool handlers and the services all share one
implementation and one set of validation rules.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal, NamedTuple, Sequence

from app.core.config import settings
from app.core.timeutil import (
    clock_to_minutes,
    days_from_now,
    end_of_day,
    format_clock,
    normalize_datetime,
    now,
    now_iso,
    parse_clock,
    parse_datetime,
    parse_weekday,
    start_of_day,
    weekday_name,
)
from app.db.database import db
from app.services import memory as memory_service

Priority = Literal["HIGH", "MEDIUM", "LOW"]
TaskStatus = Literal["PENDING", "IN_PROGRESS", "COMPLETED"]
IdeaStatus = Literal["DRAFT", "ACTIVE", "ARCHIVED"]
MemoryCategory = Literal["LONG_TERM", "GOAL", "PREFERENCE"]
MemoryType = Literal["WORKING", "EPISODIC", "SEMANTIC", "PROCEDURAL", "PROSPECTIVE", "REFLECTIVE"]

PRIORITIES: tuple[str, ...] = ("HIGH", "MEDIUM", "LOW")
TASK_STATUSES: tuple[str, ...] = ("PENDING", "IN_PROGRESS", "COMPLETED")
IDEA_STATUSES: tuple[str, ...] = ("DRAFT", "ACTIVE", "ARCHIVED")
MEMORY_CATEGORIES: tuple[str, ...] = ("LONG_TERM", "GOAL", "PREFERENCE")
MEMORY_TYPES: tuple[str, ...] = memory_service.MEMORY_TYPES
MEMORY_STATUSES: tuple[str, ...] = memory_service.MEMORY_STATUSES

# Sorts HIGH before MEDIUM before LOW inside SQL without a join table.
_PRIORITY_RANK = "CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END"


def coerce_choice(value: str | None, allowed: Sequence[str], fallback: str) -> str:
    """Normalize a model-supplied enum value, falling back instead of raising.

    Tool inputs come from an LLM; a lowercase 'high' or a stray 'urgent' should
    degrade gracefully rather than abort the turn with a CHECK constraint error.
    """
    if not value:
        return fallback
    upper = value.strip().upper().replace(" ", "_").replace("-", "_")
    return upper if upper in allowed else fallback


def new_uid() -> str:
    """A device-independent identity for a row.

    Local integer ids are assigned by SQLite and restart at 1 on every device,
    so two machines hand the same id to different rows within minutes. Sync
    keys on this instead - see ``migrations._v2_sync_identity``.
    """
    return str(uuid.uuid4())


async def _tombstone(table: str, rows: Sequence[dict[str, Any]]) -> None:
    """Record that ``rows`` were deleted, so the deletion can propagate.

    A row that has simply vanished locally is indistinguishable from one that
    has not synced in yet. Without a tombstone the next pull faithfully
    restores everything the user just deleted.

    Rows written before uids existed have none. They are skipped rather than
    guessed at, and were never on the remote to delete anyway.
    """
    stamp = now_iso()
    pairs = [(table, row["uid"], max(stamp, row.get("updated_at") or stamp)) for row in rows if row and row.get("uid")]
    if not pairs:
        return
    await db.execute_many(
        """
        INSERT INTO sync_tombstones (table_name, uid, deleted_at) VALUES (?, ?, ?)
        ON CONFLICT(table_name, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
        """,
        pairs,
    )


# ---------------------------------------------------------------------------
# tasks
# ---------------------------------------------------------------------------

async def create_task(
    title: str,
    due_date: str | None = None,
    priority: str | None = None,
    category: str | None = None,
) -> dict[str, Any]:
    stamp = now_iso()
    task_id = await db.execute(
        """
        INSERT INTO tasks (uid, title, category, priority, status, due_date,
                           created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)
        """,
        (
            new_uid(),
            title.strip(),
            (category or "GENERAL").strip().upper() or "GENERAL",
            coerce_choice(priority, PRIORITIES, "MEDIUM"),
            normalize_datetime(due_date),
            stamp,
            stamp,
        ),
    )
    created = await get_task(task_id)
    assert created is not None  # just inserted
    return created


async def get_task(task_id: int) -> dict[str, Any] | None:
    return await db.fetch_one("SELECT * FROM tasks WHERE id = ?", (task_id,))


async def list_tasks(
    statuses: Sequence[str] | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Ordered the way the dashboard wants it: dated work first (soonest first),
    then undated work, priority-major within each group."""
    params: list[Any] = []
    where = ""
    if statuses:
        placeholders = ", ".join("?" for _ in statuses)
        where = f"WHERE status IN ({placeholders})"
        params.extend(statuses)
    params.append(limit)

    return await db.fetch_all(
        f"""
        SELECT * FROM tasks
        {where}
        ORDER BY
            CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
            due_date ASC,
            {_PRIORITY_RANK},
            created_at DESC
        LIMIT ?
        """,
        params,
    )


class TaskChange(NamedTuple):
    """Outcome of a status write.

    ``cleared`` distinguishes "the task is gone because it was finished" from
    "no such task" — both of which leave ``task`` describing a row that is no
    longer on the board, and which callers must word differently.
    """

    task: dict[str, Any] | None
    cleared: bool = False


async def _settle_status(task_id: int, status: str) -> TaskChange:
    """Apply a status, then clear the task if that status means it is finished.

    The board is a list of outstanding work, so a completed task is removed
    rather than greyed out. Set ``JARVIS_CLEAR_COMPLETED_TASKS=false`` to keep
    completed rows instead.
    """
    normalized = coerce_choice(status, TASK_STATUSES, "PENDING")
    # execute_count: "did this match a row" is a rowcount question, and
    # `execute` answers it with a stale `lastrowid` when nothing matched. With
    # `execute` here, completing a task id that does not exist skipped this
    # guard and returned cleared=True — reporting a phantom task as finished.
    changed = await db.execute_count(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        (normalized, now_iso(), task_id),
    )
    if not changed:
        return TaskChange(None)

    updated = await get_task(task_id)
    if normalized == "COMPLETED" and settings.jarvis_clear_completed_tasks:
        # Completing a task removes it, so it needs a tombstone like any
        # other delete - otherwise the next pull puts it straight back.
        await _tombstone("tasks", [updated] if updated else [])
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        return TaskChange(updated, cleared=True)
    return TaskChange(updated)


async def update_task_status(task_id: int, status: str) -> TaskChange:
    return await _settle_status(task_id, status)


async def toggle_task_status(task_id: int) -> TaskChange:
    """PENDING -> IN_PROGRESS -> COMPLETED. Completing clears the task."""
    current = await get_task(task_id)
    if current is None:
        return TaskChange(None)
    nxt = {
        "PENDING": "IN_PROGRESS",
        "IN_PROGRESS": "COMPLETED",
        "COMPLETED": "PENDING",
    }[current["status"]]
    return await _settle_status(task_id, nxt)


async def update_task(task_id: int, **fields: Any) -> TaskChange:
    """Partial update. Only keys present in ``fields`` are written.

    ``None`` is a meaningful value for ``due_date`` (clear the deadline), so
    callers pass sentinel-free explicit keys rather than relying on defaults.
    """
    setters: list[str] = []
    params: list[Any] = []
    # Completing via this path must clear the task exactly as
    # `update_task_status` does, so the status write is split out and applied
    # last — after every other field has landed on the row being described.
    finishing = (
        "status" in fields
        and coerce_choice(fields.get("status"), TASK_STATUSES, "PENDING") == "COMPLETED"
    )

    if "title" in fields and fields["title"]:
        setters.append("title = ?")
        params.append(str(fields["title"]).strip())
    if "category" in fields and fields["category"]:
        setters.append("category = ?")
        params.append(str(fields["category"]).strip().upper())
    if "priority" in fields and fields["priority"]:
        setters.append("priority = ?")
        params.append(coerce_choice(fields["priority"], PRIORITIES, "MEDIUM"))
    if "status" in fields and fields["status"] and not finishing:
        setters.append("status = ?")
        params.append(coerce_choice(fields["status"], TASK_STATUSES, "PENDING"))
    if "due_date" in fields:
        setters.append("due_date = ?")
        params.append(normalize_datetime(fields["due_date"]))

    if not setters and not finishing:
        return TaskChange(await get_task(task_id))

    if setters:
        setters.append("updated_at = ?")
        params.extend([now_iso(), task_id])
        await db.execute(f"UPDATE tasks SET {', '.join(setters)} WHERE id = ?", params)

    if finishing:
        return await _settle_status(task_id, "COMPLETED")
    return TaskChange(await get_task(task_id))


async def delete_task(task_id: int) -> dict[str, Any] | None:
    """Delete and return the removed row, so the caller can describe or restore it."""
    existing = await get_task(task_id)
    if existing is None:
        return None
    await _tombstone("tasks", [existing])
    await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    return existing


#: Bulk-delete selectors, kept as an explicit whitelist so a scope can never be
#: interpolated into SQL.
TASK_SCOPES: dict[str, str] = {
    "all": "1 = 1",
    "open": "status != 'COMPLETED'",
    "completed": "status = 'COMPLETED'",
    "overdue": "status != 'COMPLETED' AND due_date IS NOT NULL AND due_date < :now",
}


async def sweep_completed_tasks() -> int:
    """Clear finished tasks off the board. Returns how many went.

    Completing a task normally removes it immediately, but rows can still
    linger: ones finished before that behaviour existed, or written while
    `JARVIS_CLEAR_COMPLETED_TASKS` was off. Running this on boot means the
    board is only ever outstanding work, without anyone having to tidy it.
    """
    if not settings.jarvis_clear_completed_tasks:
        return 0
    stale = await db.fetch_all("SELECT id, uid FROM tasks WHERE status = 'COMPLETED'", ())
    if stale:
        await _tombstone("tasks", stale)
        await db.execute("DELETE FROM tasks WHERE status = 'COMPLETED'", ())
    return len(stale)


async def delete_tasks_where(scope: str) -> list[dict[str, Any]]:
    """Delete every task matching ``scope`` in one shot.

    Exists because deleting a whole board one confirmation at a time is what
    the user explicitly asked not to be made to do.
    """
    predicate = TASK_SCOPES.get(scope)
    if predicate is None:
        return []
    params: list[Any] = []
    if ":now" in predicate:
        predicate = predicate.replace(":now", "?")
        params.append(now_iso())

    doomed = await db.fetch_all(f"SELECT * FROM tasks WHERE {predicate}", params)
    if doomed:
        await _tombstone("tasks", doomed)
        await db.execute(f"DELETE FROM tasks WHERE {predicate}", params)
    return doomed


async def count_tasks_by_status() -> dict[str, int]:
    rows = await db.fetch_all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
    counts = {status: 0 for status in TASK_STATUSES}
    for row in rows:
        counts[row["status"]] = row["n"]
    return counts


async def overdue_tasks() -> list[dict[str, Any]]:
    return await db.fetch_all(
        f"""
        SELECT * FROM tasks
        WHERE status != 'COMPLETED' AND due_date IS NOT NULL AND due_date < ?
        ORDER BY due_date ASC, {_PRIORITY_RANK}
        """,
        (now_iso(),),
    )


async def tasks_due_within(days: int) -> list[dict[str, Any]]:
    return await db.fetch_all(
        f"""
        SELECT * FROM tasks
        WHERE status != 'COMPLETED'
          AND due_date IS NOT NULL
          AND due_date >= ? AND due_date <= ?
        ORDER BY due_date ASC, {_PRIORITY_RANK}
        """,
        (now_iso(), days_from_now(days)),
    )


# ---------------------------------------------------------------------------
# schedules
# ---------------------------------------------------------------------------

# The three kinds the user asked for:
#   COLLEGE  the class timetable        — recurs weekly
#   ROUTINE  personal day-schedules     — recurs weekly
#   SESSION  a one-off booking          — a single concrete datetime
# Weekly kinds store day_of_week + start_time/end_time; SESSION stores
# time_start/time_end. Nothing else in the codebase should branch on kind
# without going through the helpers below.
SCHEDULE_KINDS: tuple[str, ...] = ("COLLEGE", "ROUTINE", "SESSION")
WEEKLY_KINDS: tuple[str, ...] = ("COLLEGE", "ROUTINE")

#: When an entry has a start but no end, assume this long for overlap maths.
ASSUMED_DURATION_MINUTES = 60


def session_end(row: dict[str, Any]) -> datetime | None:
    if row.get("kind") != "SESSION":
        return None
    start = parse_datetime(row.get("time_start"))
    if start is None:
        return None
    end = parse_datetime(row.get("time_end")) if row.get("time_end") else start + timedelta(minutes=60)
    return end if end and end > start else None


async def expire_sessions(current: datetime | None = None) -> int:
    """Atomically expire one-off Blocks. Weekly templates are never removed."""
    moment = current or now()
    removed = 0
    async with db.write() as conn:
        await conn.execute("BEGIN IMMEDIATE")
        try:
            async with conn.execute("SELECT * FROM schedules WHERE kind = 'SESSION'") as cursor:
                rows = [dict(row) for row in await cursor.fetchall()]
            for row in rows:
                end = session_end(row)
                if end is None or end > moment:
                    continue
                if row.get("uid"):
                    stamp = max(moment.isoformat(timespec="seconds"), row.get("updated_at") or "")
                    await conn.execute("INSERT INTO sync_tombstones (table_name, uid, deleted_at) VALUES ('schedules', ?, ?) "
                                       "ON CONFLICT(table_name, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)", (row["uid"], stamp))
                    await conn.execute("DELETE FROM sync_pending WHERE table_name = 'schedules' AND uid = ?", (row["uid"],))
                await conn.execute("DELETE FROM schedules WHERE id = ?", (row["id"],))
                removed += 1
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise
    return removed


def _decorate(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Attach display fields so callers never re-derive them from two shapes."""
    if row is None:
        return None
    kind = row.get("kind") or "SESSION"
    enriched = dict(row)

    if kind in WEEKLY_KINDS:
        enriched["day_name"] = weekday_name(row.get("day_of_week"))
        enriched["display_start"] = format_clock(row.get("start_time"))
        enriched["display_end"] = format_clock(row.get("end_time"))
    else:
        start = parse_datetime(row.get("time_start"))
        end = parse_datetime(row.get("time_end"))
        enriched["day_name"] = weekday_name(start.weekday()) if start else ""
        enriched["display_start"] = format_clock(start.strftime("%H:%M")) if start else ""
        enriched["display_end"] = format_clock(end.strftime("%H:%M")) if end else ""

    window = enriched["display_start"]
    if enriched["display_end"]:
        window = f"{window} - {enriched['display_end']}"
    enriched["window"] = window
    return enriched


def _footprint(row: dict[str, Any]) -> tuple[str | None, int, int, int] | None:
    """(date | None, weekday, start_minute, end_minute) — the slot an entry occupies.

    Weekly entries have no date, so they match on weekday alone. One-off
    sessions carry their date, so two sessions only collide if they fall on the
    same day, while a session still collides with any weekly entry sharing its
    weekday.
    """
    kind = row.get("kind") or "SESSION"

    if kind in WEEKLY_KINDS:
        weekday = row.get("day_of_week")
        start = clock_to_minutes(row.get("start_time"))
        if weekday is None or start is None:
            return None
        end = clock_to_minutes(row.get("end_time"))
        date_key = None
    else:
        started = parse_datetime(row.get("time_start"))
        if started is None:
            return None
        weekday = started.weekday()
        start = started.hour * 60 + started.minute
        finished = parse_datetime(row.get("time_end"))
        end = (finished.hour * 60 + finished.minute) if finished else None
        date_key = started.strftime("%Y-%m-%d")

    if end is None or end <= start:
        end = start + ASSUMED_DURATION_MINUTES
    return date_key, weekday, start, end


def _overlaps(a: dict[str, Any], b: dict[str, Any]) -> bool:
    left, right = _footprint(a), _footprint(b)
    if left is None or right is None:
        return False
    a_date, a_day, a_start, a_end = left
    b_date, b_day, b_start, b_end = right

    if a_date and b_date:
        if a_date != b_date:
            return False
    elif a_day != b_day:
        return False

    return a_start < b_end and b_start < a_end


async def find_schedule_conflicts(
    candidate: dict[str, Any], exclude_id: int | None = None
) -> list[dict[str, Any]]:
    """Every stored entry whose slot collides with ``candidate``.

    Overlaps are reported, never blocked. A one-off SESSION inside a ROUTINE
    is not reported at all: the user asked for that, because the session fills
    the block rather than competing with it.
    """
    rows = await db.fetch_all("SELECT * FROM schedules", ())
    return [
        decorated
        for row in rows
        if row["id"] != exclude_id
        and row["id"] != candidate.get("id")
        and _overlaps(candidate, row)
        and {candidate.get("kind"), row.get("kind")} != {"SESSION", "ROUTINE"}
        and (decorated := _decorate(row)) is not None
    ]


async def all_schedule_conflicts() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Every overlapping pair currently stored, each reported once.

    SESSION-inside-ROUTINE pairs are skipped, as in `find_schedule_conflicts`.
    """
    rows = await list_schedules()
    return [
        (rows[i], rows[j])
        for i in range(len(rows))
        for j in range(i + 1, len(rows))
        if _overlaps(rows[i], rows[j])
        and {rows[i].get("kind"), rows[j].get("kind")} != {"SESSION", "ROUTINE"}
    ]


async def create_schedule_event(
    event_name: str,
    kind: str | None = None,
    time_start: str | None = None,
    time_end: str | None = None,
    day_of_week: Any = None,
    start_time: str | None = None,
    end_time: str | None = None,
    location: str | None = None,
    notes: str | None = None,
) -> dict[str, Any] | None:
    weekday = parse_weekday(day_of_week)
    # A weekday without an explicit kind can only mean a recurring entry.
    fallback = "ROUTINE" if weekday is not None else "SESSION"
    normalized_kind = coerce_choice(kind, SCHEDULE_KINDS, fallback)

    if normalized_kind in WEEKLY_KINDS:
        # A weekday is required; a time is not. College timetables are often
        # known as "Monday, 4th period, room C410" with no clock time attached,
        # and refusing those would lose the timetable entirely.
        if weekday is None:
            return None
        clock_start = parse_clock(start_time)
        clock_end = parse_clock(end_time)
        start, end = None, None
    else:
        start = normalize_datetime(time_start)
        if start is None:
            return None
        end = normalize_datetime(time_end)
        if time_end and (end is None or end <= start):
            return None
        if end is None:
            end = (parse_datetime(start) + timedelta(minutes=60)).isoformat(timespec="seconds")
        clock_start = clock_end = None
        weekday = None

    stamp = now_iso()
    event_id = await db.execute(
        """
        INSERT INTO schedules (uid, event_name, kind, time_start, time_end,
                               day_of_week, start_time, end_time,
                               location, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_uid(),
            event_name.strip(),
            normalized_kind,
            start,
            end,
            weekday,
            clock_start,
            clock_end,
            (location or "").strip() or None,
            (notes or "").strip() or None,
            stamp,
            stamp,
        ),
    )
    return await get_schedule_event(event_id)


async def get_schedule_event(event_id: int) -> dict[str, Any] | None:
    return _decorate(
        await db.fetch_one("SELECT * FROM schedules WHERE id = ?", (event_id,))
    )


async def update_schedule_event(event_id: int, **fields: Any) -> dict[str, Any] | None:
    current = await get_schedule_event(event_id)
    if current is None:
        return None

    candidate = {**current, **fields}
    if candidate.get("kind") == "SESSION":
        if session_end(candidate) is None:
            return None
        fields["time_end"] = session_end(candidate).isoformat(timespec="seconds")

    setters: list[str] = []
    params: list[Any] = []

    if "event_name" in fields and fields["event_name"]:
        setters.append("event_name = ?")
        params.append(str(fields["event_name"]).strip())
    if "kind" in fields and fields["kind"]:
        setters.append("kind = ?")
        params.append(coerce_choice(fields["kind"], SCHEDULE_KINDS, current["kind"]))
    if "time_start" in fields and fields["time_start"]:
        start = normalize_datetime(fields["time_start"])
        if start is None:
            return None
        setters.append("time_start = ?")
        params.append(start)
    if "time_end" in fields:
        setters.append("time_end = ?")
        params.append(normalize_datetime(fields["time_end"]))
    if "day_of_week" in fields:
        setters.append("day_of_week = ?")
        params.append(parse_weekday(fields["day_of_week"]))
    if "start_time" in fields:
        setters.append("start_time = ?")
        params.append(parse_clock(fields["start_time"]))
    if "end_time" in fields:
        setters.append("end_time = ?")
        params.append(parse_clock(fields["end_time"]))
    if "location" in fields:
        setters.append("location = ?")
        params.append((fields["location"] or "").strip() or None)
    if "notes" in fields:
        setters.append("notes = ?")
        params.append((fields["notes"] or "").strip() or None)

    if not setters:
        return current

    # The one update path that was not stamping this. Last-write-wins has
    # nothing to compare two versions of a row on without it.
    setters.append("updated_at = ?")
    params.extend([now_iso(), event_id])
    await db.execute(f"UPDATE schedules SET {', '.join(setters)} WHERE id = ?", params)
    return await get_schedule_event(event_id)


async def delete_schedule_event(event_id: int) -> dict[str, Any] | None:
    existing = await get_schedule_event(event_id)
    if existing is None:
        return None
    await _tombstone("schedules", [existing])
    await db.execute("DELETE FROM schedules WHERE id = ?", (event_id,))
    return existing


async def list_schedules(kind: str | None = None, *, expire: bool = True) -> list[dict[str, Any]]:
    """All entries of one kind (or all kinds), each in its natural order."""
    if expire:
        await expire_sessions()
    if kind:
        rows = await db.fetch_all(
            """
            SELECT * FROM schedules WHERE kind = ?
            ORDER BY day_of_week ASC, start_time ASC, time_start ASC
            """,
            (kind,),
        )
    else:
        rows = await db.fetch_all(
            """
            SELECT * FROM schedules
            ORDER BY kind ASC, day_of_week ASC, start_time ASC, time_start ASC
            """,
            (),
        )
    return [d for row in rows if (d := _decorate(row)) is not None]


async def grouped_schedules() -> dict[str, list[dict[str, Any]]]:
    """Everything, bucketed by kind — the shape the schedule tab renders."""
    rows = await list_schedules()
    groups: dict[str, list[dict[str, Any]]] = {kind: [] for kind in SCHEDULE_KINDS}
    for row in rows:
        groups.setdefault(row["kind"], []).append(row)
    # One-off sessions read best chronologically rather than by weekday.
    groups["SESSION"].sort(key=lambda row: row["time_start"] or "")
    return groups


def _as_occurrence(row: dict[str, Any], on_day: date) -> dict[str, Any]:
    """Project a weekly entry onto a concrete date.

    Callers that render a day (today's agenda, the context snapshot, the brief)
    want one uniform shape with real datetimes, regardless of how the entry is
    stored.
    """
    if row["kind"] not in WEEKLY_KINDS:
        return row

    occurrence = dict(row)
    start = parse_clock(row.get("start_time")) or "00:00"
    occurrence["time_start"] = f"{on_day.isoformat()}T{start}:00"
    end = parse_clock(row.get("end_time"))
    occurrence["time_end"] = f"{on_day.isoformat()}T{end}:00" if end else None
    occurrence["recurring"] = True
    return occurrence


async def schedule_for_day(day: date | None = None) -> list[dict[str, Any]]:
    """Everything happening on one date: weekly entries for that weekday plus
    any one-off sessions booked that day, merged into one chronological list."""
    target = day or now().date()
    await expire_sessions()

    weekly = await db.fetch_all(
        """
        SELECT * FROM schedules
        WHERE kind IN ('COLLEGE', 'ROUTINE') AND day_of_week = ?
        ORDER BY start_time ASC
        """,
        (target.weekday(),),
    )
    sessions = await db.fetch_all(
        """
        SELECT * FROM schedules
        WHERE kind = 'SESSION' AND time_start <= ?
          AND COALESCE(time_end, strftime('%Y-%m-%dT%H:%M:%S', time_start, '+1 hour')) > ?
        ORDER BY time_start ASC
        """,
        (end_of_day(target), start_of_day(target)),
    )

    merged = [
        _as_occurrence(decorated, target)
        for row in (*weekly, *sessions)
        if (decorated := _decorate(row)) is not None
    ]
    merged = apply_session_overrides(merged)
    merged.sort(key=lambda row: row["time_start"] or "")
    return merged


def apply_session_overrides(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cut Block time out of that day's routine occurrences, preserving templates."""
    blocks = [row for row in events if row.get("kind") == "SESSION"]
    result = []
    for row in events:
        if row.get("kind") != "ROUTINE" or not row.get("start_time"):
            result.append(row)
            continue
        start = parse_datetime(row.get("time_start"))
        if start is None:
            result.append(row)
            continue
        end = parse_datetime(row.get("time_end")) or start + timedelta(minutes=60)
        if end <= start:
            end += timedelta(days=1)
        pieces = [(start, end)]
        for block in blocks:
            bs, be = parse_datetime(block.get("time_start")), session_end(block)
            if bs is None or be is None:
                continue
            parts = []
            for left, right in pieces:
                if bs >= right or be <= left:
                    parts.append((left, right))
                else:
                    parts.extend((s, e) for s, e in ((left, min(bs, right)), (max(be, left), right)) if s < e)
            pieces = parts
        for left, right in pieces:
            item = dict(row, time_start=left.isoformat(timespec="seconds"), time_end=right.isoformat(timespec="seconds"))
            item["display_start"], item["display_end"] = format_clock(left.strftime("%H:%M")), format_clock(right.strftime("%H:%M"))
            item["window"] = f"{item['display_start']} - {item['display_end']}"
            result.append(item)
    return result


async def todays_schedule() -> list[dict[str, Any]]:
    return await schedule_for_day()


async def upcoming_schedule(days: int = 7, limit: int = 100) -> list[dict[str, Any]]:
    """The next ``days`` days expanded into concrete occurrences, today first."""
    today = now().date()
    occurrences: list[dict[str, Any]] = []
    for offset in range(max(days, 1)):
        occurrences.extend(row for row in await schedule_for_day(today + timedelta(days=offset))
                           if (parse_datetime(row.get("time_end")) or parse_datetime(row.get("time_start")) or now()) > now())
        if len(occurrences) >= limit:
            break
    return occurrences[:limit]


async def list_schedule(from_iso: str, to_iso: str, limit: int = 100) -> list[dict[str, Any]]:
    """One-off sessions inside an explicit datetime window."""
    rows = await db.fetch_all(
        """
        SELECT * FROM schedules
        WHERE kind = 'SESSION' AND time_start >= ? AND time_start <= ?
        ORDER BY time_start ASC
        LIMIT ?
        """,
        (from_iso, to_iso, limit),
    )
    return [d for row in rows if (d := _decorate(row)) is not None]


async def delete_schedules_where(
    kind: str | None = None,
    matching: str | None = None,
    day_of_week: int | None = None,
) -> list[dict[str, Any]]:
    """Bulk removal, filtered by any combination of kind/name/weekday.

    Exists for the same reason `delete_tasks_where` does: a recurring block
    spans one row per weekday it repeats on, so "delete my Study block for
    the whole week" is N rows, not one -- and making that N confirmations
    instead of one is exactly the kind of thing the user should never have
    to sit through. Passing nothing deletes every schedule entry; callers
    that mean that should say so explicitly, the same as `bulk_delete_tasks`'s
    `scope="all"`.
    """
    doomed = await list_schedules(kind)
    if matching:
        needle = matching.strip().lower()
        doomed = [row for row in doomed if needle in (row.get("event_name") or "").lower()]
    if day_of_week is not None:
        doomed = [row for row in doomed if row.get("day_of_week") == day_of_week]
    if not doomed:
        return []
    await _tombstone("schedules", doomed)
    ids = [row["id"] for row in doomed if row.get("id") is not None]
    if ids:
        placeholders = ",".join("?" for _ in ids)
        await db.execute(f"DELETE FROM schedules WHERE id IN ({placeholders})", ids)
    return doomed


# ---------------------------------------------------------------------------
# ideas / notes
# ---------------------------------------------------------------------------

async def create_idea(
    title: str,
    description: str = "",
    tags: str = "",
    status: str | None = None,
    page_uid: str | None = None,
) -> dict[str, Any]:
    stamp = now_iso()
    idea_id = await db.execute(
        """
        INSERT INTO ideas (uid, title, description, tags, status,
                          created_at, updated_at, page_uid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_uid(),
            title.strip(),
            description.strip(),
            tags.strip(),
            coerce_choice(status, IDEA_STATUSES, "DRAFT"),
            stamp,
            stamp,
            page_uid,
        ),
    )
    row = await db.fetch_one("SELECT * FROM ideas WHERE id = ?", (idea_id,))
    assert row is not None
    return row


async def get_idea(idea_id: int) -> dict[str, Any] | None:
    return await db.fetch_one("SELECT * FROM ideas WHERE id = ?", (idea_id,))


async def update_idea(idea_id: int, **fields: Any) -> dict[str, Any] | None:
    setters: list[str] = []
    params: list[Any] = []

    if "title" in fields and fields["title"]:
        setters.append("title = ?")
        params.append(str(fields["title"]).strip())
    if "description" in fields:
        setters.append("description = ?")
        params.append((fields["description"] or "").strip())
    if "page_uid" in fields:
        setters.append("page_uid = ?")
        params.append(fields["page_uid"] or None)
    if "tags" in fields:
        setters.append("tags = ?")
        params.append((fields["tags"] or "").strip())
    if "status" in fields and fields["status"]:
        setters.append("status = ?")
        params.append(coerce_choice(fields["status"], IDEA_STATUSES, "DRAFT"))

    if not setters:
        return await get_idea(idea_id)

    setters.append("updated_at = ?")
    params.extend([now_iso(), idea_id])
    await db.execute(f"UPDATE ideas SET {', '.join(setters)} WHERE id = ?", params)
    return await get_idea(idea_id)


async def delete_idea(idea_id: int) -> dict[str, Any] | None:
    existing = await get_idea(idea_id)
    if existing is None:
        return None
    await _tombstone("ideas", [existing])
    await db.execute("DELETE FROM ideas WHERE id = ?", (idea_id,))
    return existing


async def delete_ideas_where(
    matching: str | None = None, status: str | None = None
) -> list[dict[str, Any]]:
    """Bulk removal, filtered by title/description text and/or status.

    Same reasoning as `delete_tasks_where`/`delete_schedules_where`: "clear
    every archived idea" or "delete all my ideas about X" is inherently more
    than one row, and making that one confirmation per row is the thing the
    two-step gate should never do.
    """
    doomed = await list_ideas(statuses=(status,) if status else None, limit=10_000)
    if matching:
        needle = matching.strip().lower()
        doomed = [
            row for row in doomed
            if needle in (row.get("title") or "").lower()
            or needle in (row.get("description") or "").lower()
        ]
    if not doomed:
        return []
    await _tombstone("ideas", doomed)
    ids = [row["id"] for row in doomed if row.get("id") is not None]
    if ids:
        placeholders = ",".join("?" for _ in ids)
        await db.execute(f"DELETE FROM ideas WHERE id IN ({placeholders})", ids)
    return doomed


async def get_memory(memory_id: int) -> dict[str, Any] | None:
    row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    return memory_service.decorate_row(row) if row else None


async def update_memory(memory_id: int, **fields: Any) -> dict[str, Any] | None:
    """Edit a stored memory in place, by id.

    `upsert_memory` addresses a memory by ``key_concept``, which is right for
    the agent -- it is remembering a fact and does not know an id. It is wrong
    for someone editing the row in front of them, where renaming the concept is
    itself a legitimate edit and would otherwise create a second memory instead
    of changing the one on screen.
    """
    raw = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    if raw is None:
        return None
    current = memory_service.decorate_row(raw)
    key_concept = str(fields.get("key_concept", current["key_concept"])).strip()
    content = str(fields.get("content", current["content"])).strip()
    if not key_concept or not content:
        raise ValueError("A memory needs both a title and content.")
    category = coerce_choice(fields.get("category", current["category"]), MEMORY_CATEGORIES, "LONG_TERM")
    expires_at = fields.get("expires_at", current.get("expires_at"))
    if expires_at:
        expires_at = normalize_datetime(expires_at)
        if not expires_at or expires_at <= now_iso():
            raise ValueError("Temporary memory needs a future expiry date and time.")

    memory_type = coerce_choice(fields.get("memory_type", current["memory_type"]), MEMORY_TYPES, current["memory_type"])
    memory_status = coerce_choice(fields.get("memory_status", current["memory_status"]), MEMORY_STATUSES, current["memory_status"])
    if memory_type == "WORKING" and not expires_at:
        expires_at = (now() + timedelta(hours=8)).isoformat(timespec="seconds")
    stored = memory_service.storage_value(
        content,
        existing=raw,
        memory_type=memory_type,
        memory_status=memory_status,
        confidence=fields.get("confidence", current["confidence"]),
        importance=fields.get("importance", current["importance"]),
        source_kind=fields.get("source_kind", current["source_kind"]),
        source_ref=fields.get("source_ref", current["source_ref"]),
        valid_from=fields.get("valid_from", current["valid_from"]),
        supersedes_uid=fields.get("supersedes_uid", current["supersedes_uid"]),
        pinned=fields.get("pinned", current["pinned"]),
        tags=fields.get("tags", current["tags"]),
    )
    changed = await db.execute_count(
        """
        UPDATE memories
        SET key_concept = ?, content = ?, category = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (key_concept, stored, category, expires_at, now_iso(), memory_id),
    )
    if not changed:
        return None
    await memory_service.refresh_markdown_vault()
    return await get_memory(memory_id)


async def delete_memory(memory_id: int) -> dict[str, Any] | None:
    existing = await get_memory(memory_id)
    if existing is None:
        return None
    await _tombstone("memories", [existing])
    await db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    await memory_service.refresh_markdown_vault()
    return existing


async def delete_memories_where(
    matching: str | None = None, category: str | None = None
) -> list[dict[str, Any]]:
    """Bulk removal, filtered by concept/content text and/or category.

    Same reasoning as the other `delete_*_where` helpers: "forget everything
    about X" or "clear all my GOAL memories" is inherently more than one row.
    """
    doomed = await list_memories(limit=10_000)
    if category:
        doomed = [row for row in doomed if row.get("category") == category]
    if matching:
        needle = matching.strip().lower()
        doomed = [
            row for row in doomed
            if needle in (row.get("key_concept") or "").lower()
            or needle in (row.get("content") or "").lower()
        ]
    if not doomed:
        return []
    await _tombstone("memories", doomed)
    ids = [row["id"] for row in doomed if row.get("id") is not None]
    if ids:
        placeholders = ",".join("?" for _ in ids)
        await db.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", ids)
    await memory_service.refresh_markdown_vault()
    return doomed


async def list_ideas(
    statuses: Sequence[str] | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    params: list[Any] = []
    where = ""
    if statuses:
        placeholders = ", ".join("?" for _ in statuses)
        where = f"WHERE status IN ({placeholders})"
        params.extend(statuses)
    params.append(limit)
    return await db.fetch_all(
        f"SELECT * FROM ideas {where} ORDER BY updated_at DESC LIMIT ?", params
    )


# ---------------------------------------------------------------------------
# memories
# ---------------------------------------------------------------------------

async def upsert_memory(
    key_concept: str,
    content: str,
    category: str | None = None,
    expires_at: str | None = None,
    *,
    memory_type: str | None = None,
    memory_status: str = "ACTIVE",
    confidence: float = 1.0,
    importance: float = 0.65,
    source_kind: str = "explicit",
    source_ref: str | None = None,
    pinned: bool = False,
    tags: Sequence[str] | None = None,
) -> dict[str, Any]:
    """One row per ``key_concept`` — re-saving the same concept updates it in
    place so long-term memory does not accumulate near-duplicates."""
    normalized_category = coerce_choice(category, MEMORY_CATEGORIES, "LONG_TERM")
    deadline = normalize_datetime(expires_at)
    if expires_at and (not deadline or deadline <= now_iso()):
        raise ValueError("Temporary memory needs a future expiry date and time.")
    await expire_memories()
    stamp = now_iso()
    key = key_concept.strip()

    existing = await db.fetch_one(
        "SELECT * FROM memories WHERE lower(key_concept) = lower(?) LIMIT 1", (key,)
    )
    chosen_type = coerce_choice(
        memory_type,
        MEMORY_TYPES,
        memory_service.infer_type(normalized_category, deadline),
    )
    chosen_status = coerce_choice(memory_status, MEMORY_STATUSES, "ACTIVE")
    if chosen_type == "WORKING" and not deadline:
        deadline = (now() + timedelta(hours=8)).isoformat(timespec="seconds")
    stored = memory_service.storage_value(
        content.strip(),
        existing=existing,
        memory_type=chosen_type,
        memory_status=chosen_status,
        confidence=confidence,
        importance=importance,
        source_kind=source_kind,
        source_ref=source_ref,
        pinned=pinned,
        tags=tags,
    )
    if existing:
        await db.execute(
            "UPDATE memories SET content = ?, category = ?, updated_at = ?, expires_at = ? WHERE id = ?",
            (stored, normalized_category, stamp, deadline, existing["id"]),
        )
        row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (existing["id"],))
    else:
        memory_id = await db.execute(
            """
            INSERT INTO memories (uid, key_concept, category, content,
                                  created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (new_uid(), key, normalized_category, stored, stamp, stamp, deadline),
        )
        row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    assert row is not None
    await memory_service.refresh_markdown_vault()
    return memory_service.decorate_row(row)


async def list_memories(limit: int = 100) -> list[dict[str, Any]]:
    await expire_memories()
    rows = await db.fetch_all(
        "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?", (limit,)
    )
    await memory_service.refresh_markdown_vault()
    return [memory_service.decorate_row(row) for row in rows]


async def search_memories_and_ideas(query: str, limit: int = 20) -> dict[str, list[dict[str, Any]]]:
    """Rank memory intelligently; retain exact local search for records."""
    pattern = f"%{query.strip().lower()}%"
    await expire_memories()

    include_candidates = any(word in query.casefold() for word in ("candidate", "review", "inferred"))
    memories = await memory_service.retrieve(query, limit=limit, include_candidates=include_candidates)
    ideas = await db.fetch_all(
        """
        SELECT * FROM ideas
        WHERE lower(title) LIKE ? OR lower(description) LIKE ? OR lower(tags) LIKE ?
        ORDER BY updated_at DESC LIMIT ?
        """,
        (pattern, pattern, pattern, limit),
    )
    tasks = await db.fetch_all(
        """
        SELECT * FROM tasks
        WHERE lower(title) LIKE ? OR lower(category) LIKE ?
        ORDER BY updated_at DESC LIMIT ?
        """,
        (pattern, pattern, limit),
    )
    actions = await memory_service.retrieve_actions(query, limit=min(limit, 5))
    return {"memories": memories, "ideas": ideas, "tasks": tasks, "actions": actions}


# ---------------------------------------------------------------------------
async def expire_memories(current: datetime | None = None) -> int:
    """Permanently remove expired rules; tombstones contain no note content."""
    stamp = (current or now()).isoformat(timespec="seconds")
    async with db.write() as conn:
        await conn.execute("BEGIN IMMEDIATE")
        try:
            async with conn.execute("SELECT * FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?", (stamp,)) as cursor:
                rows = [dict(row) for row in await cursor.fetchall()]
            for row in rows:
                await conn.execute("INSERT INTO sync_tombstones (table_name, uid, deleted_at) VALUES ('memories', ?, ?) "
                                   "ON CONFLICT(table_name, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)",
                                   (row["uid"], max(stamp, row["updated_at"])))
                await conn.execute("DELETE FROM memories WHERE id = ?", (row["id"],))
                await conn.execute("DELETE FROM sync_pending WHERE table_name = 'memories' AND uid = ?", (row["uid"],))
            await conn.commit()
            return len(rows)
        except BaseException:
            await conn.rollback()
            raise


async def list_note_pages() -> list[dict[str, Any]]:
    return await db.fetch_all("SELECT * FROM note_pages ORDER BY created_at, uid")


async def save_note_page(uid: str | None, title: str, kind: str = "CUSTOM") -> dict[str, Any]:
    uid = uid or new_uid()
    stamp = now_iso()
    existing = await db.fetch_one("SELECT uid FROM note_pages WHERE uid = ?", (uid,))
    if existing:
        await db.execute("UPDATE note_pages SET title = ?, updated_at = ? WHERE uid = ?",
                         (title.strip(), stamp, uid))
    else:
        await db.execute("INSERT INTO note_pages (uid, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                         (uid, title.strip(), kind, stamp, stamp))
    return await db.fetch_one("SELECT * FROM note_pages WHERE uid = ?", (uid,))


async def delete_note_page(uid: str) -> bool:
    page = await db.fetch_one("SELECT * FROM note_pages WHERE uid = ?", (uid,))
    if not page or page["kind"] != "CUSTOM":
        return False
    await db.execute("UPDATE ideas SET page_uid = NULL, updated_at = ? WHERE page_uid = ?", (now_iso(), uid))
    await _tombstone("note_pages", [page])
    return bool(await db.execute_count("DELETE FROM note_pages WHERE uid = ?", (uid,)))


# proactive briefs
# ---------------------------------------------------------------------------

async def save_brief(summary_text: str, urgent_count: int) -> dict[str, Any]:
    brief_id = await db.execute(
        "INSERT INTO proactive_briefs (summary_text, urgent_count, generated_at) VALUES (?, ?, ?)",
        (summary_text, urgent_count, now_iso()),
    )
    row = await db.fetch_one("SELECT * FROM proactive_briefs WHERE id = ?", (brief_id,))
    assert row is not None
    return row


async def latest_brief() -> dict[str, Any] | None:
    return await db.fetch_one(
        "SELECT * FROM proactive_briefs ORDER BY generated_at DESC, id DESC LIMIT 1"
    )


async def prune_briefs(keep: int = 50) -> None:
    """Briefs are regenerated often; keep the table from growing without bound."""
    await db.execute(
        """
        DELETE FROM proactive_briefs
        WHERE id NOT IN (SELECT id FROM proactive_briefs ORDER BY id DESC LIMIT ?)
        """,
        (keep,),
    )


# ---------------------------------------------------------------------------
# chat history
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# preferences
# ---------------------------------------------------------------------------

PREF_VOICE_LANGUAGE = "voice_language"
PREF_VOICE_SPEAKER = "voice_speaker"
PREF_NOTIFICATION_POLICY = "notification_policy"


async def get_preference(key: str, default: str = "") -> str:
    row = await db.fetch_one("SELECT value FROM preferences WHERE key = ?", (key,))
    return row["value"] if row else default


async def set_preference(key: str, value: str) -> str:
    await db.execute(
        """
        INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, now_iso()),
    )
    return value


# ---------------------------------------------------------------------------
# chat history
# ---------------------------------------------------------------------------

async def append_chat_message(
    role: str, text: str, payload: dict[str, Any] | list[dict[str, Any]] | None = None
) -> int:
    """Persist one transcript entry.

    ``role`` is the coarse transcript role used for display ('user' or
    'assistant'); ``payload`` is the exact provider message object, stored
    verbatim so a restarted process can replay the turn structure — including
    tool calls and their results — without reconstructing it.
    """
    return await db.execute(
        "INSERT INTO chat_messages (role, text, blocks, created_at) VALUES (?, ?, ?, ?)",
        (role, text, json.dumps(payload) if payload is not None else None, now_iso()),
    )


async def recent_chat_messages(limit: int) -> list[dict[str, Any]]:
    """Oldest-first slice of the tail of the conversation."""
    rows = await db.fetch_all(
        "SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,)
    )
    rows.reverse()
    for row in rows:
        row["blocks"] = json.loads(row["blocks"]) if row["blocks"] else None
    return rows


async def clear_chat_history() -> None:
    await db.execute("DELETE FROM chat_messages", ())


# ---------------------------------------------------------------------------
# Reminders and announcements
# ---------------------------------------------------------------------------

async def create_reminder(text: str, due_at: str, target_at: str | None = None) -> dict[str, Any]:
    stamp = now_iso()
    reminder_id = await db.execute(
        "INSERT INTO reminders (text, due_at, target_at, created_at) VALUES (?, ?, ?, ?)",
        (text.strip(), due_at, target_at, stamp),
    )
    return await get_reminder(reminder_id)  # type: ignore[return-value]


async def get_reminder(reminder_id: int) -> dict[str, Any] | None:
    return await db.fetch_one("SELECT * FROM reminders WHERE id = ?", (reminder_id,))


async def list_reminders(include_fired: bool = False, limit: int = 50) -> list[dict[str, Any]]:
    where = "" if include_fired else "WHERE fired_at IS NULL"
    return await db.fetch_all(
        f"SELECT * FROM reminders {where} ORDER BY due_at LIMIT ?", (limit,)
    )


async def due_reminders(cutoff: str) -> list[dict[str, Any]]:
    return await db.fetch_all(
        "SELECT * FROM reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at",
        (cutoff,),
    )


async def mark_reminder_fired(reminder_id: int) -> None:
    await db.execute(
        "UPDATE reminders SET fired_at = ? WHERE id = ?", (now_iso(), reminder_id)
    )


async def update_reminder(
    reminder_id: int, *, text: str | None = None, due_at: str | None = None
) -> dict[str, Any] | None:
    """Edit a reminder's text and/or firing time in place.

    Editing the time un-fires it -- a reminder someone moved forward clearly
    has not happened yet, and the old `fired_at` would otherwise make the
    scheduler skip it silently. It also clears `target_at`: that field only
    means something as the real moment an *early-notice* row (from the
    two-row default reminder) stands in for, and a manual edit to `due_at`
    replaces that relationship with a plain, exact-time reminder -- leaving
    the old target in place would misquote "in N minutes" against a time
    that is no longer what changed. Editing only the text leaves both alone.
    """
    existing = await get_reminder(reminder_id)
    if existing is None:
        return None
    fields: list[str] = []
    params: list[Any] = []
    if text is not None:
        fields.append("text = ?")
        params.append(text.strip())
    if due_at is not None:
        fields.append("due_at = ?")
        params.append(due_at)
        fields.append("fired_at = NULL")
        fields.append("target_at = NULL")
    if not fields:
        return existing
    params.append(reminder_id)
    await db.execute(f"UPDATE reminders SET {', '.join(fields)} WHERE id = ?", params)
    return await get_reminder(reminder_id)


async def delete_reminder(reminder_id: int) -> dict[str, Any] | None:
    existing = await get_reminder(reminder_id)
    if existing is None:
        return None
    await db.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
    return existing


async def record_announcement(
    kind: str, ref_id: int | None, occurrence_at: str, text: str, urgency: int = 0
) -> bool:
    """Queue something to say. Returns False if it was already queued.

    The UNIQUE constraint on (kind, ref_id, occurrence_at) is what stops a
    polling scheduler repeating itself, so a conflict here is the normal case
    rather than an error -- it means "already handled", and the caller should
    quietly move on.
    """
    # Asked separately rather than inferred from the INSERT. `db.execute`
    # returns `lastrowid or rowcount`, and SQLite leaves `lastrowid` pointing at
    # the previous successful insert when `ON CONFLICT DO NOTHING` does nothing
    # -- measured: lastrowid=2, rowcount=0 on a conflict. Trusting that return
    # would have reported every duplicate as freshly queued, which is precisely
    # the repetition the UNIQUE constraint exists to prevent.
    #
    # There is one scheduler loop, so nothing races between these two
    # statements; the constraint remains the backstop if that ever stops being
    # true.
    already = await db.fetch_one(
        "SELECT id FROM announcements "
        "WHERE kind = ? AND ref_id IS ? AND occurrence_at = ?",
        (kind, ref_id, occurrence_at),
    )
    if already is not None:
        return False

    await db.execute(
        """
        INSERT INTO announcements (kind, ref_id, occurrence_at, text, urgency, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, ref_id, occurrence_at) DO NOTHING
        """,
        (kind, ref_id, occurrence_at, text, urgency, now_iso()),
    )
    return True


async def pending_announcements(limit: int = 20) -> list[dict[str, Any]]:
    return await db.fetch_all(
        "SELECT * FROM announcements WHERE delivered_at IS NULL "
        "ORDER BY urgency DESC, occurrence_at LIMIT ?",
        (limit,),
    )


async def mark_announcements_delivered(ids: Sequence[int]) -> int:
    if not ids:
        return 0
    placeholders = ", ".join("?" for _ in ids)
    # execute_count, not execute: this must report rows actually changed, and
    # `execute` falls back to a stale `lastrowid` when an UPDATE matches nothing.
    return await db.execute_count(
        f"UPDATE announcements SET delivered_at = ? "
        f"WHERE id IN ({placeholders}) AND delivered_at IS NULL",
        (now_iso(), *ids),
    )


async def prune_announcements(keep_days: int = 14) -> int:
    """Delivered announcements are a log, not state. Keep a fortnight."""
    cutoff = to_iso(now() - timedelta(days=keep_days))
    return await db.execute_count(
        "DELETE FROM announcements WHERE delivered_at IS NOT NULL AND created_at < ?",
        (cutoff,),
    )
