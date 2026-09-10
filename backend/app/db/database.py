"""Async SQLite engine.

Design notes
------------
SQLite under WAL allows *many concurrent readers and exactly one writer*. This
module mirrors that shape directly:

* a bounded pool of read connections handed out via ``read()``
* a single dedicated writer connection guarded by an ``asyncio.Lock``, via
  ``write()``

Every connection is created once at startup and closed once at shutdown — there
is no per-request connect/close churn and no connection can be leaked, because
``read()``/``write()`` are async context managers that always return the handle
to the pool in a ``finally`` block.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterable, Sequence

import aiosqlite

from app.core.config import settings
from app.db import migrations

logger = logging.getLogger("jarvis.db")

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# Applied to every connection. WAL + NORMAL is the standard durable-but-fast
# combination for a local single-process application.
_CONNECTION_PRAGMAS = (
    "PRAGMA journal_mode = WAL;",
    "PRAGMA synchronous = NORMAL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA busy_timeout = 5000;",
    "PRAGMA temp_store = MEMORY;",
    "PRAGMA cache_size = -16000;",  # ~16 MB page cache
)


class Database:
    """Owns the read pool and the single writer connection."""

    def __init__(self, path: Path, pool_size: int) -> None:
        self._path = path
        self._pool_size = pool_size
        self._readers: asyncio.Queue[aiosqlite.Connection] = asyncio.Queue()
        self._all_readers: list[aiosqlite.Connection] = []
        self._writer: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()
        self._started = False

    # -- lifecycle ----------------------------------------------------------

    async def connect(self) -> None:
        if self._started:
            return

        self._path.parent.mkdir(parents=True, exist_ok=True)

        self._writer = await self._open()
        await self._apply_schema(self._writer)

        for _ in range(self._pool_size):
            conn = await self._open()
            self._all_readers.append(conn)
            self._readers.put_nowait(conn)

        self._started = True
        logger.info(
            "SQLite ready at %s (1 writer + %d readers, WAL)", self._path, self._pool_size
        )

    async def disconnect(self) -> None:
        if not self._started:
            return
        self._started = False

        for conn in self._all_readers:
            await conn.close()
        self._all_readers.clear()
        while not self._readers.empty():  # drain so a restart starts clean
            self._readers.get_nowait()

        if self._writer is not None:
            await self._writer.close()
            self._writer = None

        logger.info("SQLite connections closed")

    async def _open(self) -> aiosqlite.Connection:
        conn = await aiosqlite.connect(self._path, isolation_level=None)
        conn.row_factory = aiosqlite.Row
        for pragma in _CONNECTION_PRAGMAS:
            await conn.execute(pragma)
        return conn

    async def _apply_schema(self, conn: aiosqlite.Connection) -> None:
        # Migrations run *first*: `schema.sql` declares indexes over columns that
        # only exist after an upgrade, so running it against a pre-migration
        # table fails with "no such column". On a fresh database the migrations
        # are no-ops and `schema.sql` creates the current shape directly.
        await migrations.apply(conn)
        await conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        await conn.commit()

    # -- acquisition --------------------------------------------------------

    @asynccontextmanager
    async def read(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._started:
            raise RuntimeError("Database.connect() has not been awaited")
        conn = await self._readers.get()
        try:
            yield conn
        finally:
            self._readers.put_nowait(conn)

    @asynccontextmanager
    async def write(self) -> AsyncIterator[aiosqlite.Connection]:
        if not self._started or self._writer is None:
            raise RuntimeError("Database.connect() has not been awaited")
        async with self._write_lock:
            yield self._writer

    # -- convenience --------------------------------------------------------

    async def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        async with self.read() as conn:
            async with conn.execute(sql, params) as cursor:
                rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def fetch_one(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        async with self.read() as conn:
            async with conn.execute(sql, params) as cursor:
                row = await cursor.fetchone()
        return dict(row) if row else None

    async def fetch_value(self, sql: str, params: Sequence[Any] = (), default: Any = None) -> Any:
        async with self.read() as conn:
            async with conn.execute(sql, params) as cursor:
                row = await cursor.fetchone()
        return row[0] if row else default

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run a write and return ``lastrowid`` (INSERT) or ``rowcount`` (UPDATE/DELETE).

        Use :meth:`execute_count` instead when you need "how many rows did that
        touch". The fallback below is only reached when ``lastrowid`` is falsy,
        and there is exactly one writer connection for the whole process — so
        ``lastrowid`` keeps pointing at the last row *any* INSERT created, and an
        UPDATE that matched nothing returns that stale id rather than 0.
        Measured: after inserting row 2, a conflicting insert reports
        ``lastrowid=2, rowcount=0``.
        """
        async with self.write() as conn:
            cursor = await conn.execute(sql, params)
            try:
                await conn.commit()
                return cursor.lastrowid if cursor.lastrowid else cursor.rowcount
            finally:
                await cursor.close()

    async def execute_count(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run a write and return how many rows it actually changed.

        The honest answer for UPDATE and DELETE, where :meth:`execute` cannot
        give one.
        """
        async with self.write() as conn:
            cursor = await conn.execute(sql, params)
            try:
                await conn.commit()
                return cursor.rowcount
            finally:
                await cursor.close()

    async def execute_many(self, sql: str, seq: Iterable[Sequence[Any]]) -> None:
        async with self.write() as conn:
            await conn.executemany(sql, seq)
            await conn.commit()


db = Database(settings.db_file, settings.jarvis_db_pool_size)
