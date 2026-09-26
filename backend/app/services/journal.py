"""Undo for JARVIS's own changes: a local change journal.

Every tool call that can change the user's records is bracketed by two
snapshots of the record tables, and the difference is stored here, grouped
into one batch per agent turn. ``undo_last`` reverts the newest batch that has
not been undone yet; asking again walks further back.

Added 2026-09-26 after "undo what you did now" had nothing behind it: the
model answered "there is nothing to undo" moments after claiming it had
changed the schedule.

Local to the device and never synced. The Android reseed replaces the synced
tables and their sync bookkeeping, not this table, so a batch survives the
seed/drain cycle between turns. Rows are matched by ``uid`` (ids are
renumbered from the uid on Android) and restored only if nobody has changed
them since: an undo never overwrites a later hand edit.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from app.core.timeutil import now, now_iso, parse_datetime
from app.db import database

#: Tables an undo can restore, and the column that identifies a row.
TABLES: dict[str, str] = {
    "tasks": "uid",
    "schedules": "uid",
    "memories": "uid",
    "ideas": "uid",
    "note_pages": "uid",
    "reminders": "id",
}
_SYNCED = frozenset({"tasks", "schedules", "memories", "ideas", "note_pages"})
KEEP_BATCHES = 50
KEEP_DAYS = 14

Snapshot = dict[str, dict[str, dict[str, Any]]]


async def snapshot() -> Snapshot:
    """Every row of every journaled table, keyed by its identity column."""
    taken: Snapshot = {}
    for table, key in TABLES.items():
        rows = await database.db.fetch_all(f"SELECT * FROM {table}")
        taken[table] = {str(row[key]): row for row in rows if row.get(key) is not None}
    return taken


def _lapsed(table: str, row: dict[str, Any]) -> bool:
    """Rows that vanish on their own (an ended Block, an expired rule) are not
    changes anyone made, and bringing them back would only restore something
    stale."""
    current = now()
    if table == "memories":
        expires = parse_datetime(row.get("expires_at"))
        return bool(expires and expires <= current)
    if table == "schedules" and row.get("kind") == "SESSION":
        end = parse_datetime(row.get("time_end")) or parse_datetime(row.get("time_start"))
        return bool(end and end <= current)
    return False


async def record(batch: str, label: str, before: Snapshot) -> int:
    """Store what changed since ``before`` under ``batch``; returns the row count."""
    after = await snapshot()
    stamp = now_iso()
    entries: list[tuple[Any, ...]] = []
    for table in TABLES:
        old, new = before.get(table, {}), after.get(table, {})
        for key in sorted(old.keys() | new.keys()):
            was, became = old.get(key), new.get(key)
            if was == became or (became is None and _lapsed(table, was or {})):
                continue
            entries.append((
                batch, label, table, key,
                json.dumps(was, ensure_ascii=False) if was is not None else None,
                json.dumps(became, ensure_ascii=False) if became is not None else None,
                stamp,
            ))
    if not entries:
        return 0
    await database.db.execute_many(
        """
        INSERT INTO change_journal (batch, label, table_name, row_key, before_row, after_row, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        entries,
    )
    cutoff = (now() - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
    await database.db.execute("DELETE FROM change_journal WHERE created_at < ?", (cutoff,))
    await database.db.execute(
        """
        DELETE FROM change_journal WHERE batch NOT IN (
            SELECT batch FROM change_journal GROUP BY batch ORDER BY MAX(id) DESC LIMIT ?
        )
        """,
        (KEEP_BATCHES,),
    )
    return len(entries)


def _same_version(table: str, current: dict[str, Any], expected: dict[str, Any]) -> bool:
    if table in _SYNCED:
        return current.get("updated_at") == expected.get("updated_at")
    return {k: v for k, v in current.items() if k != "id"} == {k: v for k, v in expected.items() if k != "id"}


async def _columns(conn: Any, table: str) -> list[str]:
    async with conn.execute(f"PRAGMA table_info({table})") as cursor:
        return [row[1] for row in await cursor.fetchall()]


async def undo_last() -> dict[str, Any] | None:
    """Revert the newest batch that has not been undone. ``None`` if there is none."""
    latest = await database.db.fetch_one(
        "SELECT batch FROM change_journal WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    if latest is None:
        return None
    batch = latest["batch"]
    entries = await database.db.fetch_all(
        "SELECT * FROM change_journal WHERE batch = ? ORDER BY id", (batch,)
    )
    labels: list[str] = []
    # A row touched several times in one turn is undone once, from its state
    # before the turn to its state after it.
    net: dict[tuple[str, str], list[dict[str, Any] | None]] = {}
    for entry in entries:
        if entry["label"] not in labels:
            labels.append(entry["label"])
        before = json.loads(entry["before_row"]) if entry["before_row"] else None
        after = json.loads(entry["after_row"]) if entry["after_row"] else None
        key = (entry["table_name"], entry["row_key"])
        if key in net:
            net[key][1] = after
        else:
            net[key] = [before, after]

    stamp = now_iso()
    counts = {"removed": 0, "restored": 0, "reverted": 0, "skipped": 0}
    touched: set[str] = set()
    async with database.db.write() as conn:
        await conn.execute("BEGIN IMMEDIATE")
        try:
            for (table, key), (before, after) in net.items():
                if before == after:
                    continue
                column = TABLES[table]
                lookup = key if column == "uid" else int(key)
                async with conn.execute(f"SELECT * FROM {table} WHERE {column} = ?", (lookup,)) as cursor:
                    found = await cursor.fetchone()
                current = dict(found) if found else None

                if after is not None and current is not None and not _same_version(table, current, after):
                    counts["skipped"] += 1  # changed since; the later edit wins
                    continue
                if before is None:  # JARVIS created it: remove it
                    if current is None:
                        continue
                    await _delete(conn, table, current, stamp)
                    counts["removed"] += 1
                elif after is None:  # JARVIS deleted it: bring it back
                    if current is not None or (table == "reminders" and _overdue(before)):
                        counts["skipped"] += 1
                        continue
                    await _insert(conn, table, before, stamp)
                    counts["restored"] += 1
                else:  # JARVIS changed it: put the old values back
                    if current is None:
                        counts["skipped"] += 1
                        continue
                    await _update(conn, table, column, before, stamp)
                    counts["reverted"] += 1
                touched.add(table)
            await conn.execute("UPDATE change_journal SET undone_at = ? WHERE batch = ?", (stamp, batch))
            await conn.commit()
        except BaseException:
            await conn.rollback()
            raise

    if "memories" in touched:
        from app.services import memory as memory_service

        await memory_service.refresh_markdown_vault()
    return {"label": "; ".join(labels), "tables": sorted(touched), **counts}


def _overdue(reminder: dict[str, Any]) -> bool:
    """A deleted reminder whose moment has passed would fire the instant it
    came back; leave it gone."""
    due = parse_datetime(reminder.get("due_at"))
    return bool(due and due <= now() and not reminder.get("fired_at"))


async def _delete(conn: Any, table: str, current: dict[str, Any], stamp: str) -> None:
    if table in _SYNCED and current.get("uid"):
        await conn.execute(
            """
            INSERT INTO sync_tombstones (table_name, uid, deleted_at) VALUES (?, ?, ?)
            ON CONFLICT(table_name, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
            """,
            (table, current["uid"], max(stamp, str(current.get("updated_at") or stamp))),
        )
        await conn.execute(
            "DELETE FROM sync_pending WHERE table_name = ? AND uid = ?", (table, current["uid"])
        )
    column = TABLES[table]
    await conn.execute(f"DELETE FROM {table} WHERE {column} = ?", (current[column],))


async def _insert(conn: Any, table: str, before: dict[str, Any], stamp: str) -> None:
    row = dict(before)
    if table in _SYNCED:
        # Newer than the tombstone the deletion left, locally and on the
        # phone's IndexedDB, so the restored row wins everywhere.
        row["updated_at"] = stamp
        await conn.execute(
            "DELETE FROM sync_tombstones WHERE table_name = ? AND uid = ?", (table, row.get("uid"))
        )
    columns = [column for column in await _columns(conn, table) if column in row]
    for attempt in (columns, [column for column in columns if column != "id"]):
        try:
            await conn.execute(
                f"INSERT INTO {table} ({', '.join(attempt)}) VALUES ({', '.join('?' for _ in attempt)})",
                [row[column] for column in attempt],
            )
            return
        except Exception:  # noqa: BLE001 - the old id is taken; let SQLite pick one
            if attempt is not columns:
                raise


async def _update(conn: Any, table: str, key_column: str, before: dict[str, Any], stamp: str) -> None:
    row = dict(before)
    if table in _SYNCED:
        row["updated_at"] = stamp
    columns = [
        column for column in await _columns(conn, table)
        if column in row and column not in ("id", key_column)
    ]
    await conn.execute(
        f"UPDATE {table} SET {', '.join(f'{column} = ?' for column in columns)} WHERE {key_column} = ?",
        [*(row[column] for column in columns), row[key_column]],
    )
