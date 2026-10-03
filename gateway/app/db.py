"""Storage: SQLAlchemy 2 async core over Postgres (production) or SQLite (dev, tests).

Tables are created at startup with plain DDL (``create_all``); ``schema_meta``
records the schema version so a later change can add a numbered migration to
``_MIGRATIONS`` instead of hand-editing a live database.

Balances are integer **milli-Aura** (1/1000 Aura). ``ledger`` is append-only:
every balance movement is one row carrying the signed delta per bucket and the
balances after it, so any account's history can be replayed and audited.
``usage`` has one row per metered provider call.

Concurrency: balance changes run inside ``Database.tx()``. On Postgres the
account row is taken ``FOR UPDATE``, which serializes one user's requests even
across several gateway processes. SQLite has no row locks and fails a write
transaction that loses a lock upgrade, so there every write transaction takes
one process-wide lock instead (SQLite is dev/test only).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    event,
    select,
    text,
)
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

SCHEMA_VERSION = 1

#: Numbered DDL applied after ``create_all`` on databases older than the
#: version. Empty: version 1 is the initial schema.
_MIGRATIONS: dict[int, list[str]] = {}

metadata = MetaData()

#: BIGINT autoincrement on Postgres; SQLite only autoincrements a column
#: declared exactly INTEGER PRIMARY KEY.
_BigId = BigInteger().with_variant(Integer, "sqlite")


def _ts(name: str, nullable: bool = True) -> Column:
    return Column(name, DateTime(timezone=True), nullable=nullable)


accounts = Table(
    "accounts", metadata,
    #: Supabase ``sub``.
    Column("user_id", String(64), primary_key=True),
    Column("email", String(320)),
    Column("plan", String(32), nullable=False),
    #: default | admin | play
    Column("plan_source", String(16), nullable=False),
    #: When a paid entitlement ends (store expiry or an admin grant's days).
    #: Null = no end (Spawn, or an open-ended admin grant).
    _ts("plan_expires_at"),
    #: The two buckets. Plan Aura resets to the allowance each period; top-up
    #: Aura persists. ``plan_milli`` can go briefly negative when a call costs
    #: more than everything left (cleared at the next reset).
    Column("plan_milli", BigInteger, nullable=False),
    Column("topup_milli", BigInteger, nullable=False),
    #: Sum of open reservations: available = plan + topup - held.
    Column("held_milli", BigInteger, nullable=False, default=0),
    _ts("period_start", nullable=False),
    _ts("period_end", nullable=False),
    _ts("trial_lockin_started_at"),
    _ts("trial_lockin_ends_at"),
    #: The Play purchase that currently sets the plan, so a stale token's
    #: expiry cannot downgrade a user who has since switched plans.
    Column("play_purchase_token", Text),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)

ledger = Table(
    "ledger", metadata,
    Column("id", _BigId, primary_key=True, autoincrement=True),
    Column("user_id", String(64), nullable=False),
    #: grant | spend | topup | refund | adjust
    Column("kind", String(16), nullable=False),
    Column("plan_delta_milli", BigInteger, nullable=False),
    Column("topup_delta_milli", BigInteger, nullable=False),
    Column("plan_after_milli", BigInteger, nullable=False),
    Column("topup_after_milli", BigInteger, nullable=False),
    Column("usage_id", BigInteger),
    #: External reference: a Play purchase token, an admin note id...
    Column("ref", Text),
    Column("note", Text),
    _ts("created_at", nullable=False),
)
Index("ix_ledger_user_created", ledger.c.user_id, ledger.c.created_at)

usage = Table(
    "usage", metadata,
    Column("id", _BigId, primary_key=True, autoincrement=True),
    Column("user_id", String(64), nullable=False),
    #: chat | stt | tts
    Column("endpoint", String(16), nullable=False),
    Column("model", String(128), nullable=False),
    Column("streamed", Boolean, nullable=False, default=False),
    #: ok | upstream_error | upstream_unreachable | upstream_dropped |
    #: client_aborted | no_usage | stale_hold
    Column("status", String(32), nullable=False),
    Column("http_status", Integer),
    Column("prompt_tokens", Integer, nullable=False, default=0),
    Column("cached_tokens", Integer, nullable=False, default=0),
    Column("cache_write_tokens", Integer, nullable=False, default=0),
    Column("completion_tokens", Integer, nullable=False, default=0),
    Column("reasoning_tokens", Integer, nullable=False, default=0),
    Column("audio_seconds", Float),
    Column("chars", Integer),
    Column("cost_usd", Float, nullable=False, default=0.0),
    #: OpenRouter's own reported cost, kept for reconciliation.
    Column("upstream_cost_usd", Float),
    Column("cost_inr", Float, nullable=False, default=0.0),
    #: What was actually taken from the balance.
    Column("milli_aura", BigInteger, nullable=False, default=0),
    Column("reserve_milli", BigInteger, nullable=False, default=0),
    Column("generation_id", String(128)),
    Column("language", String(16)),
    Column("duration_ms", Integer),
    _ts("created_at", nullable=False),
)
Index("ix_usage_user_created", usage.c.user_id, usage.c.created_at)

reservations = Table(
    "reservations", metadata,
    Column("id", String(32), primary_key=True),
    Column("user_id", String(64), nullable=False),
    Column("endpoint", String(16), nullable=False),
    Column("model", String(128), nullable=False),
    Column("amount_milli", BigInteger, nullable=False),
    _ts("created_at", nullable=False),
)
Index("ix_reservations_user", reservations.c.user_id)

#: Every Play notification received, keyed by Pub/Sub messageId: dedupes
#: redeliveries and doubles as the billing audit log.
play_events = Table(
    "play_events", metadata,
    Column("message_id", String(128), primary_key=True),
    Column("package_name", String(255)),
    #: subscription | one_time | voided | test | other
    Column("kind", String(16), nullable=False),
    Column("notification_type", Integer),
    Column("product_id", String(255)),
    Column("purchase_token", Text),
    Column("user_id", String(64)),
    Column("outcome", String(64), nullable=False),
    _ts("received_at", nullable=False),
)

#: One credit per consumable purchase token, however many notifications or
#: redeliveries mention it.
play_topups = Table(
    "play_topups", metadata,
    Column("purchase_token", String(512), primary_key=True),
    Column("user_id", String(64), nullable=False),
    Column("product_id", String(255), nullable=False),
    Column("aura", Integer, nullable=False),
    _ts("created_at", nullable=False),
)

schema_meta = Table(
    "schema_meta", metadata,
    Column("key", String(64), primary_key=True),
    Column("value", String(255), nullable=False),
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: datetime | None) -> datetime | None:
    """SQLite hands timestamps back naive; everything stored is UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_url(url: str) -> str:
    """Accept the URL shapes hosting dashboards print and pick the async driver."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    if url.startswith("sqlite:///"):
        return "sqlite+aiosqlite:///" + url[len("sqlite:///"):]
    return url


class Database:
    def __init__(self, url: str) -> None:
        self.url = normalize_url(url)
        self.is_sqlite = self.url.startswith("sqlite")
        if self.is_sqlite:
            self.engine: AsyncEngine = create_async_engine(
                self.url, connect_args={"timeout": 30},
            )

            @event.listens_for(self.engine.sync_engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _record) -> None:  # noqa: ANN001
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA busy_timeout=30000")
                cursor.close()
        else:
            self.engine = create_async_engine(
                self.url, pool_pre_ping=True, pool_size=10, max_overflow=10,
            )
        self._write_lock = asyncio.Lock()

    async def init(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
            row = (await conn.execute(
                select(schema_meta.c.value).where(schema_meta.c.key == "version")
            )).first()
            current = int(row[0]) if row else SCHEMA_VERSION
            for version in sorted(v for v in _MIGRATIONS if v > current):
                for statement in _MIGRATIONS[version]:
                    await conn.execute(text(statement))
            if row is None:
                await conn.execute(
                    schema_meta.insert().values(key="version", value=str(SCHEMA_VERSION))
                )
            elif current < SCHEMA_VERSION:
                await conn.execute(
                    schema_meta.update().where(schema_meta.c.key == "version")
                    .values(value=str(SCHEMA_VERSION))
                )

    @asynccontextmanager
    async def tx(self) -> AsyncIterator[AsyncConnection]:
        """A write transaction: commits on success, rolls back on any error."""
        if self.is_sqlite:
            async with self._write_lock:
                async with self.engine.begin() as conn:
                    yield conn
        else:
            async with self.engine.begin() as conn:
                yield conn

    @asynccontextmanager
    async def read(self) -> AsyncIterator[AsyncConnection]:
        async with self.engine.connect() as conn:
            yield conn

    async def ping(self) -> None:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self.engine.dispose()
