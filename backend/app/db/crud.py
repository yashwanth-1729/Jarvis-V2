"""Typed CRUD helpers. Every function here is the *only* place raw SQL lives for
its table, so the API layer, the tool handlers and the services all share one
implementation and one set of validation rules.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Sequence

from app.core.timeutil import end_of_day, days_from_now, normalize_datetime, now_iso, start_of_day
from app.db.database import db

Priority = Literal["HIGH", "MEDIUM", "LOW"]
TaskStatus = Literal["PENDING", "IN_PROGRESS", "COMPLETED"]
IdeaStatus = Literal["DRAFT", "ACTIVE", "ARCHIVED"]
MemoryCategory = Literal["LONG_TERM", "GOAL", "PREFERENCE", "PRIVATE"]

PRIORITIES: tuple[str, ...] = ("HIGH", "MEDIUM", "LOW")
TASK_STATUSES: tuple[str, ...] = ("PENDING", "IN_PROGRESS", "COMPLETED")
IDEA_STATUSES: tuple[str, ...] = ("DRAFT", "ACTIVE", "ARCHIVED")
MEMORY_CATEGORIES: tuple[str, ...] = ("LONG_TERM", "GOAL", "PREFERENCE", "PRIVATE")

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
        INSERT INTO tasks (title, category, priority, status, due_date, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
        """,
        (
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


async def update_task_status(task_id: int, status: str) -> dict[str, Any] | None:
    normalized = coerce_choice(status, TASK_STATUSES, "PENDING")
    changed = await db.execute(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        (normalized, now_iso(), task_id),
    )
    if not changed:
        return None
    return await get_task(task_id)


async def toggle_task_status(task_id: int) -> dict[str, Any] | None:
    """PENDING -> IN_PROGRESS -> COMPLETED -> PENDING."""
    current = await get_task(task_id)
    if current is None:
        return None
    nxt = {
        "PENDING": "IN_PROGRESS",
        "IN_PROGRESS": "COMPLETED",
        "COMPLETED": "PENDING",
    }[current["status"]]
    return await update_task_status(task_id, nxt)


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

async def create_schedule_event(
    event_name: str,
    time_start: str,
    time_end: str | None = None,
    location: str | None = None,
    notes: str | None = None,
) -> dict[str, Any] | None:
    start = normalize_datetime(time_start)
    if start is None:
        return None
    event_id = await db.execute(
        """
        INSERT INTO schedules (event_name, time_start, time_end, location, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            event_name.strip(),
            start,
            normalize_datetime(time_end),
            (location or "").strip() or None,
            (notes or "").strip() or None,
            now_iso(),
        ),
    )
    return await db.fetch_one("SELECT * FROM schedules WHERE id = ?", (event_id,))


async def list_schedule(from_iso: str, to_iso: str, limit: int = 100) -> list[dict[str, Any]]:
    return await db.fetch_all(
        """
        SELECT * FROM schedules
        WHERE time_start >= ? AND time_start <= ?
        ORDER BY time_start ASC
        LIMIT ?
        """,
        (from_iso, to_iso, limit),
    )


async def todays_schedule() -> list[dict[str, Any]]:
    return await list_schedule(start_of_day(), end_of_day())


async def upcoming_schedule(days: int = 7, limit: int = 100) -> list[dict[str, Any]]:
    return await list_schedule(start_of_day(), days_from_now(days), limit)


# ---------------------------------------------------------------------------
# ideas / notes
# ---------------------------------------------------------------------------

async def create_idea(
    title: str,
    description: str = "",
    tags: str = "",
    status: str | None = None,
) -> dict[str, Any]:
    stamp = now_iso()
    idea_id = await db.execute(
        """
        INSERT INTO ideas (title, description, tags, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            title.strip(),
            description.strip(),
            tags.strip(),
            coerce_choice(status, IDEA_STATUSES, "DRAFT"),
            stamp,
            stamp,
        ),
    )
    row = await db.fetch_one("SELECT * FROM ideas WHERE id = ?", (idea_id,))
    assert row is not None
    return row


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

async def upsert_memory(key_concept: str, content: str, category: str | None = None) -> dict[str, Any]:
    """One row per ``key_concept`` — re-saving the same concept updates it in
    place so long-term memory does not accumulate near-duplicates."""
    normalized_category = coerce_choice(category, MEMORY_CATEGORIES, "LONG_TERM")
    stamp = now_iso()
    key = key_concept.strip()

    existing = await db.fetch_one(
        "SELECT * FROM memories WHERE lower(key_concept) = lower(?) LIMIT 1", (key,)
    )
    if existing:
        await db.execute(
            "UPDATE memories SET content = ?, category = ?, updated_at = ? WHERE id = ?",
            (content.strip(), normalized_category, stamp, existing["id"]),
        )
        row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (existing["id"],))
    else:
        memory_id = await db.execute(
            """
            INSERT INTO memories (key_concept, category, content, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (key, normalized_category, content.strip(), stamp, stamp),
        )
        row = await db.fetch_one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    assert row is not None
    return row


async def list_memories(limit: int = 100) -> list[dict[str, Any]]:
    return await db.fetch_all(
        "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?", (limit,)
    )


async def search_memories_and_ideas(query: str, limit: int = 20) -> dict[str, list[dict[str, Any]]]:
    """Case-insensitive substring search across memories, ideas and task titles."""
    pattern = f"%{query.strip().lower()}%"

    memories = await db.fetch_all(
        """
        SELECT * FROM memories
        WHERE lower(key_concept) LIKE ? OR lower(content) LIKE ?
        ORDER BY updated_at DESC LIMIT ?
        """,
        (pattern, pattern, limit),
    )
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
    return {"memories": memories, "ideas": ideas, "tasks": tasks}


# ---------------------------------------------------------------------------
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
