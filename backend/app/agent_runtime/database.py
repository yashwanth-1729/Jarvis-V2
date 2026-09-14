"""Separate SQLite owner for durable agent control-plane state."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import aiosqlite

from app.agent_runtime import migrations
from app.core.config import settings

SCHEMA_VERSION = migrations.TARGET_VERSION
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


class RuntimeDatabase:
    """One serialized writer with FULL-sync durability for control facts."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._connection: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        if self._connection is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = await aiosqlite.connect(self.path, isolation_level=None)
        connection.row_factory = aiosqlite.Row
        await connection.execute("PRAGMA journal_mode = WAL")
        await connection.execute("PRAGMA synchronous = FULL")
        await connection.execute("PRAGMA foreign_keys = ON")
        await connection.execute("PRAGMA busy_timeout = 5000")
        try:
            await migrations.apply(connection)
        except BaseException:
            await connection.close()
            raise
        await connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        await connection.commit()
        self._connection = connection

    async def disconnect(self) -> None:
        if self._connection is not None:
            await self._connection.close()
            self._connection = None

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[aiosqlite.Connection]:
        if self._connection is None:
            raise RuntimeError("RuntimeDatabase.connect() has not been awaited")
        async with self._lock:
            await self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield self._connection
            except BaseException:
                await self._connection.rollback()
                raise
            else:
                await self._connection.commit()


runtime_db = RuntimeDatabase(settings.runtime_db_file)
