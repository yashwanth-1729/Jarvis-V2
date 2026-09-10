"""Versioned schema migrations, keyed on SQLite's ``PRAGMA user_version``.

`schema.sql` only ever runs ``CREATE TABLE IF NOT EXISTS``, so it cannot evolve
a database that already has rows in it. Anything that changes an existing table
belongs here instead, and must be safe to run against a live database with real
data in it.
"""

from __future__ import annotations

import json
import logging
from typing import Awaitable, Callable

import aiosqlite

logger = logging.getLogger("jarvis.db.migrations")

#: Bump when adding a migration below.
TARGET_VERSION = 6


async def _columns(conn: aiosqlite.Connection, table: str) -> set[str]:
    """Column names of ``table``, or an empty set if it does not exist yet."""
    async with conn.execute(f"PRAGMA table_info({table})") as cursor:
        return {row[1] for row in await cursor.fetchall()}


async def _table_exists(conn: aiosqlite.Connection, table: str) -> bool:
    async with conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ) as cursor:
        return await cursor.fetchone() is not None


async def _v1_schedule_kinds(conn: aiosqlite.Connection) -> None:
    """Split schedules into college / routine / session, and allow recurring rows.

    Recurring entries (a weekly class, a nightly study block) have no single
    datetime, so ``time_start`` must become nullable and the row instead carries
    ``day_of_week`` + ``start_time``/``end_time``. SQLite cannot drop a NOT NULL
    constraint in place, so the table is rebuilt and copied.
    """
    # Fresh database: there is nothing to migrate, and `schema.sql` will create
    # the table in its current shape immediately after this runs.
    if not await _table_exists(conn, "schedules"):
        return
    if "kind" in await _columns(conn, "schedules"):
        return

    logger.info("Migrating `schedules` to support recurring entries and kinds")

    await conn.execute("ALTER TABLE schedules RENAME TO schedules_old")
    await conn.execute(
        """
        CREATE TABLE schedules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name  TEXT     NOT NULL,
            kind        TEXT     NOT NULL DEFAULT 'SESSION'
                                 CHECK (kind IN ('COLLEGE', 'ROUTINE', 'SESSION')),
            -- One-off entries use these.
            time_start  DATETIME,
            time_end    DATETIME,
            -- Weekly entries use these. 0 = Monday .. 6 = Sunday.
            day_of_week INTEGER  CHECK (day_of_week BETWEEN 0 AND 6),
            start_time  TEXT,
            end_time    TEXT,
            location    TEXT,
            notes       TEXT,
            created_at  DATETIME NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
        )
        """
    )
    # Everything that existed before was a concrete one-off event.
    await conn.execute(
        """
        INSERT INTO schedules (id, event_name, kind, time_start, time_end,
                               location, notes, created_at)
        SELECT id, event_name, 'SESSION', time_start, time_end,
               location, notes, created_at
        FROM schedules_old
        """
    )
    await conn.execute("DROP TABLE schedules_old")

    await conn.execute("CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules (time_start)")
    await conn.execute("CREATE INDEX IF NOT EXISTS idx_schedules_kind ON schedules (kind)")
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schedules_weekly ON schedules (day_of_week, start_time)"
    )


#: Tables that take part in cross-device sync.
#:
#: `proactive_briefs` and `chat_messages` are deliberately absent. Both are
#: high-churn, locally regenerable and would dominate sync traffic without
#: making the board on another device any more correct.
SYNCED_TABLES: tuple[str, ...] = ("tasks", "schedules", "memories", "ideas", "note_pages")

#: A version-4 UUID built from SQLite primitives, evaluated once per row.
#:
#: Generating these in SQL rather than Python keeps the backfill a single
#: statement over a table of any size, instead of a read-modify-write per row.
_UUID4_SQL = """
    lower(
        substr(hex(randomblob(4)), 1, 8) || '-' ||
        substr(hex(randomblob(2)), 1, 4) || '-4' ||
        substr(hex(randomblob(2)), 2, 3) || '-' ||
        substr('89ab', 1 + (abs(random()) % 4), 1) ||
        substr(hex(randomblob(2)), 2, 3) || '-' ||
        substr(hex(randomblob(6)), 1, 12)
    )
"""


async def _v2_sync_identity(conn: aiosqlite.Connection) -> None:
    """Give syncable rows a device-independent identity, and start recording deletes.

    Sync needs two things an ``INTEGER PRIMARY KEY`` cannot give it.

    A *stable identity*: two devices both counting from 1 assign id 3 to
    different tasks, and the collision is silent — one row overwrites the other
    the moment they meet. ``uid`` is generated per row and never reused, so
    identity survives the trip between devices.

    A *record of deletion*: a row that has simply vanished locally is
    indistinguishable from one that has not arrived yet. Without tombstones the
    next pull faithfully restores everything the user just deleted, which is the
    single most common way naive sync loses people's trust.
    """
    for table in SYNCED_TABLES:
        # Fresh database: `schema.sql` runs after this and declares the current
        # shape directly, so there is nothing here to migrate.
        if not await _table_exists(conn, table):
            continue
        if "uid" not in await _columns(conn, table):
            # SQLite rejects non-constant defaults in ALTER TABLE, so the column
            # arrives empty and the UPDATE below fills it.
            await conn.execute(f"ALTER TABLE {table} ADD COLUMN uid TEXT")
        await conn.execute(
            f"UPDATE {table} SET uid = {_UUID4_SQL} WHERE uid IS NULL OR uid = ''"
        )
        # NULLs compare distinct in a SQLite unique index, so a row that somehow
        # misses a uid degrades to unsynced rather than breaking every insert.
        await conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_uid ON {table} (uid)"
        )

    # `schedules` is the one synced table without an updated_at, and last-write-
    # wins has nothing to compare two versions of a row on without it.
    if await _table_exists(conn, "schedules"):
        if "updated_at" not in await _columns(conn, "schedules"):
            await conn.execute("ALTER TABLE schedules ADD COLUMN updated_at DATETIME")
        await conn.execute(
            "UPDATE schedules SET updated_at = created_at WHERE updated_at IS NULL"
        )

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_tombstones (
            table_name  TEXT     NOT NULL,
            uid         TEXT     NOT NULL,
            deleted_at  DATETIME NOT NULL,
            PRIMARY KEY (table_name, uid)
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tombstones_deleted ON sync_tombstones (deleted_at)"
    )
    # Watermarks for the sync engine: how far each direction has got.
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_state (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  DATETIME NOT NULL
        )
        """
    )


#: Marks a row as needing publication. Written by triggers rather than by
#: application code so that no write path -- including ones added later, and
#: including raw SQL -- can forget to do it.
_MARK_PENDING = """
    CREATE TRIGGER IF NOT EXISTS {table}_mark_pending_{event} AFTER {sql_event} ON {table}
    WHEN NEW.uid IS NOT NULL
    BEGIN
        INSERT INTO sync_pending (table_name, uid) VALUES ('{table}', NEW.uid)
        ON CONFLICT(table_name, uid) DO NOTHING;
    END
"""


async def _v3_pending_set(conn: aiosqlite.Connection) -> None:
    """Track *what is unpublished* explicitly, instead of inferring it from a clock.

    The push cursor used to be a high-water mark over ``updated_at``, which
    conflates two different questions: "when was this edited" and "have I sent
    it yet". They come apart in both directions and the failure is silent
    either way.

    A clock that jumps **forward** -- a peer device running fast, whose rows
    this device pulls -- drags the watermark past the present, and every later
    local edit sorts below it and is never sent. A clock that jumps
    **backward** -- an ordinary NTP correction -- makes new rows land below a
    watermark already in the future, with the same result. Neither raises an
    error; sync simply stops publishing.

    A dirty set has no clock in it, so neither failure exists. A row is pending
    because something wrote it, and stops being pending because it was
    successfully sent.
    """
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_pending (
            table_name  TEXT NOT NULL,
            uid         TEXT NOT NULL,
            PRIMARY KEY (table_name, uid)
        )
        """
    )

    for table in SYNCED_TABLES:
        if not await _table_exists(conn, table):
            continue
        for event, sql_event in (("ins", "INSERT"), ("upd", "UPDATE")):
            await conn.execute(_MARK_PENDING.format(table=table, event=event, sql_event=sql_event))

        # Everything currently local is treated as unpublished exactly once, so
        # the changeover cannot drop a row that the old cursor had already
        # skipped. The re-push is idempotent and costs one round.
        await conn.execute(
            f"""
            INSERT INTO sync_pending (table_name, uid)
            SELECT '{table}', uid FROM {table} WHERE uid IS NOT NULL
            ON CONFLICT(table_name, uid) DO NOTHING
            """
        )

    # The old per-table push watermarks are now meaningless. Leaving them would
    # be harmless but misleading to anyone reading sync_state later.
    await conn.execute("DELETE FROM sync_state WHERE key LIKE 'push:%' AND key NOT LIKE '%tombstones'")


async def _v4_reminders(conn: aiosqlite.Connection) -> None:
    """Give JARVIS something to fire, and somewhere to record that it did.

    Until now the schedule was inert: a college timetable and a set of routines
    sat in the database, were rendered on a dashboard and injected into the
    prompt, and nothing ever happened at the time they described. Both tables
    here exist to change that.

    ``reminders`` holds one-shots the user asks for out loud ("remind me in
    twenty minutes"). ``announcements`` is the outbox: one row per thing JARVIS
    has decided to say, and *also* the record that it already said it.

    That second job is why the UNIQUE constraint matters. A scheduler that
    polls will see the same class as due on every tick, and the obvious guard --
    remembering in memory what was already announced -- forgets across a
    restart and starts repeating itself. Making the database refuse a duplicate
    means no polling loop, however it is later rewritten, can announce the same
    occurrence twice. It follows the same reasoning as the sync triggers: put
    the invariant where no future write path can forget it.

    Neither table syncs. They have no ``uid`` and no pending-set triggers, so
    the sync engine does not see them, which is deliberate -- two devices
    sharing an outbox would both fire the same reminder, and the person would
    be told twice.
    """
    await conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS reminders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            text        TEXT NOT NULL,
            due_at      DATETIME NOT NULL,
            created_at  DATETIME NOT NULL,
            fired_at    DATETIME
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_pending
            ON reminders (due_at) WHERE fired_at IS NULL;

        CREATE TABLE IF NOT EXISTS announcements (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'schedule', 'task')),
            ref_id        INTEGER,
            occurrence_at DATETIME NOT NULL,
            text          TEXT NOT NULL,
            urgency       INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME NOT NULL,
            delivered_at  DATETIME,
            UNIQUE (kind, ref_id, occurrence_at)
        );

        CREATE INDEX IF NOT EXISTS idx_announcements_undelivered
            ON announcements (created_at) WHERE delivered_at IS NULL;
        """
    )


async def _v5_notes_pages(conn: aiosqlite.Connection) -> None:
    for table, column in (("memories", "expires_at"), ("ideas", "page_uid")):
        if await _table_exists(conn, table) and column not in await _columns(conn, table):
            await conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
    if await _table_exists(conn, "memories"):
        await conn.execute("UPDATE memories SET category = 'LONG_TERM' WHERE category = 'PRIVATE'")


async def _v6_systematic_memory(conn: aiosqlite.Connection) -> None:
    """Add the local action/access ledger and wrap legacy text as Markdown.

    Rich memory metadata deliberately lives in YAML-compatible front matter in
    ``memories.content``.  The existing Supabase table can therefore transport
    v2 memories immediately, while old clients still see ordinary text.
    """
    await conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS memory_access (
            memory_uid       TEXT PRIMARY KEY,
            access_count     INTEGER NOT NULL DEFAULT 0,
            last_accessed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS action_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            uid              TEXT UNIQUE NOT NULL,
            action_name      TEXT NOT NULL,
            action_type      TEXT NOT NULL,
            status           TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
            source_turn_ref  TEXT,
            input_summary    TEXT NOT NULL DEFAULT '{}',
            result_summary   TEXT NOT NULL DEFAULT '',
            started_at       TEXT NOT NULL,
            completed_at     TEXT NOT NULL,
            created_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_action_events_created
            ON action_events (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_action_events_type
            ON action_events (action_type, created_at DESC);
        """
    )

    if not await _table_exists(conn, "memories"):
        return
    async with conn.execute(
        "SELECT id, category, content, expires_at, created_at FROM memories"
    ) as cursor:
        rows = await cursor.fetchall()
    for row in rows:
        content = str(row[2] or "")
        if content.startswith("---\njarvis_memory: 2\n"):
            continue
        memory_type = (
            "PROCEDURAL" if row[3]
            else "PROSPECTIVE" if str(row[1] or "").upper() == "GOAL"
            else "SEMANTIC"
        )
        meta = {
            "jarvis_memory": 2,
            "type": memory_type,
            "status": "ACTIVE",
            "confidence": 1.0,
            "importance": 0.65,
            "source_kind": "legacy",
            "source_ref": None,
            "valid_from": row[4],
            "supersedes_uid": None,
            "pinned": False,
            "evidence_count": 1,
            "tags": [],
            "history": [],
        }
        front = ["---"]
        for key, value in meta.items():
            front.append(
                f"{key}: {json.dumps(value, ensure_ascii=False, separators=(',', ':'))}"
            )
        front.extend(("---", content))
        await conn.execute(
            "UPDATE memories SET content = ? WHERE id = ?", ("\n".join(front), row[0])
        )


MIGRATIONS: dict[int, Callable[[aiosqlite.Connection], Awaitable[None]]] = {
    1: _v1_schedule_kinds,
    2: _v2_sync_identity,
    3: _v3_pending_set,
    4: _v4_reminders,
    5: _v5_notes_pages,
    6: _v6_systematic_memory,
}


async def apply(conn: aiosqlite.Connection) -> None:
    """Bring the database up to ``TARGET_VERSION``. Safe to call on every boot."""
    async with conn.execute("PRAGMA user_version") as cursor:
        row = await cursor.fetchone()
    current = int(row[0]) if row else 0

    if current >= TARGET_VERSION:
        return

    for version in range(current + 1, TARGET_VERSION + 1):
        migrate = MIGRATIONS.get(version)
        if migrate is None:
            continue
        await migrate(conn)
        # PRAGMA does not accept bound parameters.
        await conn.execute(f"PRAGMA user_version = {version}")
        await conn.commit()
        logger.info("Applied schema migration v%d", version)
