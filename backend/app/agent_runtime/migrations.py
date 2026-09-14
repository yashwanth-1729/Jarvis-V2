"""Exclusive, transactional migrations for the runtime control-plane DB."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping

import aiosqlite

TARGET_VERSION = 2
Migration = Callable[[aiosqlite.Connection], Awaitable[None]]


async def _v1_initial_marker(conn: aiosqlite.Connection) -> None:
    # Version 1's actual tables are installed by schema.sql. This migration is
    # intentionally empty so a brand-new v0 database advances monotonically.
    del conn


async def _v2_migration_history(conn: aiosqlite.Connection) -> None:
    await conn.execute(
        """CREATE TABLE IF NOT EXISTS runtime_migration_history (
               version     INTEGER PRIMARY KEY,
               applied_at  TEXT NOT NULL DEFAULT (
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               )
           )"""
    )
    await conn.execute(
        "INSERT OR IGNORE INTO runtime_migration_history(version) VALUES (2)"
    )


MIGRATIONS: Mapping[int, Migration] = {1: _v1_initial_marker, 2: _v2_migration_history}


async def apply(
    conn: aiosqlite.Connection,
    *,
    migrations: Mapping[int, Migration] = MIGRATIONS,
    target_version: int = TARGET_VERSION,
) -> None:
    current = int((await (await conn.execute("PRAGMA user_version")).fetchone())[0])
    if current > target_version:
        raise RuntimeError(
            f"Runtime database schema {current} is newer than supported {target_version}; "
            "refusing to downgrade or wipe it."
        )
    if current == target_version:
        return

    # One process owns the migration transaction. A second writer waits on the
    # configured busy timeout and then fails; it cannot interleave DDL/version.
    await conn.execute("BEGIN EXCLUSIVE")
    try:
        for version in range(current + 1, target_version + 1):
            migration = migrations.get(version)
            if migration is None:
                raise RuntimeError(f"Missing runtime migration for version {version}")
            await migration(conn)
            await conn.execute(f"PRAGMA user_version = {version}")
        await conn.commit()
    except BaseException:
        await conn.rollback()
        raise
