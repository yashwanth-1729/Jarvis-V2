"""Cross-device sync.

Local SQLite stays the source of truth. Every read the agent, the tools and the
dashboard make is answered locally at memory speed; sync runs on a timer in the
background and never sits in the path of a voice turn. That ordering is
deliberate -- routing reads through Supabase would put a network round trip
inside every turn, which is the opposite of the direction this codebase has been
pushed.

The remote is therefore a *mirror*, not a database::

    local write --> (timer) --> push --> Supabase
    Supabase    --> (timer) --> pull --> local upsert

Three separate mechanisms, and keeping them separate is the whole design:

``sync_pending``  (a set)
    What this device has not published. Maintained by SQLite triggers, so no
    write path can forget. **Not a clock** -- see below.
``synced_at``     (server clock)
    The pull cursor: what this device has not yet seen. Server-assigned, so
    skew between devices cannot hide a row.
``updated_at``    (client clock)
    Used *only* to decide conflicts -- which of two versions of a row is newer.

The first of those used to be a high-water mark over ``updated_at``, and that
was wrong in a way that failed silently. "Have I published this row" is a fact
about local state, not about time, and inferring it from a clock breaks whenever
the clock moves: forward (a peer's future-stamped row strands every later local
edit below the watermark) or backward (an NTP correction puts new rows below a
watermark already in the future). Neither raises an error -- sync simply stops
publishing. A set has no clock in it and cannot fail either way.

Guarantees this protocol *does* provide:

* **Eventual convergence** -- given no new writes, repeated syncs bring every
  device to the same state.
* **Deletes stay deleted** -- tombstones, so a delete is never undone by a peer
  that had not heard about it.
* **Idempotence** -- syncing twice changes nothing.
* **No lost publication** -- a row stays pending until it is confirmed sent.

Guarantees it does **not** provide, deliberately:

* **No lost updates.** Conflict resolution is last-write-wins, so two devices
  editing the same row while both offline will keep one edit and discard the
  other. Right for one person with a laptop and a phone; wrong for genuine
  multi-user collaboration, which would need CRDTs or vector clocks.
* **Causal consistency.** There is no happens-before tracking.
* **Cross-table atomicity.** A round can be interrupted between tables.
* **Deterministic tie-breaking.** Two versions of one row sharing an identical
  second-resolution ``updated_at`` but differing in content resolve to whichever
  the device already had. Reaching that state needs two devices to edit the same
  row inside the same second while both offline; raising timestamp resolution
  would remove it if it ever mattered.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Any, Iterable, Protocol, Sequence

import httpx

from app.core.config import settings
from app.core.timeutil import now_iso
from app.db.database import db
from app.db.migrations import SYNCED_TABLES

logger = logging.getLogger("jarvis.sync")

#: Columns that travel. The local INTEGER ``id`` deliberately does not: it is
#: device-local, and two devices would collide on it immediately.
SYNC_COLUMNS: dict[str, tuple[str, ...]] = {
    "tasks": (
        "uid", "title", "category", "priority", "status",
        "due_date", "created_at", "updated_at",
    ),
    "schedules": (
        "uid", "event_name", "kind", "time_start", "time_end", "day_of_week",
        "start_time", "end_time", "location", "notes", "created_at", "updated_at",
    ),
    "memories": (
        "uid", "key_concept", "category", "content", "created_at", "updated_at", "expires_at",
    ),
    "ideas": (
        "uid", "title", "description", "tags", "status", "created_at", "updated_at", "page_uid",
    ),
    "note_pages": ("uid", "title", "kind", "created_at", "updated_at"),
}

#: Supabase caps a single REST response at 1000 rows; page rather than truncate.
PAGE_SIZE = 1000


@dataclass
class SyncResult:
    """What one round actually moved. Returned so tests can assert on it."""

    pushed: dict[str, int] = field(default_factory=dict)
    pulled: dict[str, int] = field(default_factory=dict)
    deleted_locally: int = 0
    tombstones_pushed: int = 0
    skipped: str | None = None          # set when sync did not run at all
    error: str | None = None

    @property
    def moved(self) -> int:
        return sum(self.pushed.values()) + sum(self.pulled.values())

    def summary(self) -> str:
        if self.skipped:
            return f"sync skipped: {self.skipped}"
        if self.error:
            return f"sync failed: {self.error}"
        if not self.moved and not self.deleted_locally:
            return "sync: already up to date"
        parts: list[str] = []
        if any(self.pushed.values()):
            parts.append("pushed " + ", ".join(f"{n} {t}" for t, n in self.pushed.items() if n))
        if any(self.pulled.values()):
            parts.append("pulled " + ", ".join(f"{n} {t}" for t, n in self.pulled.items() if n))
        if self.deleted_locally:
            parts.append(f"removed {self.deleted_locally} deleted elsewhere")
        return "sync: " + "; ".join(parts)


class StorageAdapter(Protocol):
    """The remote, reduced to four operations.

    Narrow on purpose: everything above this line is transport-agnostic, so the
    tests can run the whole engine against an in-memory fake rather than
    spending a live Supabase call on every assertion.
    """

    async def fetch_rows(
        self, table: str, since: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        """Rows with ``synced_at`` after ``since``, plus the new cursor."""
        ...

    async def push_rows(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        """Upsert ``rows`` on their primary key."""
        ...

    async def fetch_tombstones(
        self, since: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        ...

    async def push_tombstones(self, rows: Sequence[dict[str, Any]]) -> None:
        ...

    async def close(self) -> None:
        ...


class SupabaseAdapter:
    """PostgREST over httpx.

    Authenticates with the *service role* key, which bypasses row-level
    security. That is correct here because this process is the only thing
    holding it -- it lives in ``backend/.env`` on the machine running JARVIS and
    must never reach the frontend bundle or a mobile app. The mirror tables have
    RLS enabled with no policies, so every other key sees nothing at all.
    """

    def __init__(self, url: str, service_key: str, timeout: float = 20.0) -> None:
        self._base = url.rstrip("/") + "/rest/v1"
        # Identifies whose clock the stored cursors belong to. Derived from the
        # URL rather than the key so rotating credentials does not force a full
        # re-pull, but pointing at a different project does.
        self.remote_id = hashlib.sha256(self._base.encode()).hexdigest()[:12]
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            },
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _fetch(
        self, table: str, since: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        rows: list[dict[str, Any]] = []
        cursor = since
        while True:
            params: dict[str, str] = {
                "select": "*",
                "order": "synced_at.asc",
                "limit": str(PAGE_SIZE),
            }
            if cursor:
                params["synced_at"] = f"gt.{cursor}"
            response = await self._client.get(f"{self._base}/{table}", params=params)
            response.raise_for_status()
            page = response.json()
            if not page:
                break
            rows.extend(page)
            cursor = page[-1]["synced_at"]
            # A short page means the table is exhausted. Breaking only on an
            # empty page would spin forever if the server ever ignored the
            # filter.
            if len(page) < PAGE_SIZE:
                break
        return rows, cursor

    async def fetch_rows(
        self, table: str, since: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        return await self._fetch(table, since)

    async def fetch_tombstones(
        self, since: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        return await self._fetch("sync_tombstones", since)

    async def _upsert(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        if not rows:
            return
        for start in range(0, len(rows), PAGE_SIZE):
            chunk = list(rows[start : start + PAGE_SIZE])
            response = await self._client.post(
                f"{self._base}/{table}",
                json=chunk,
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            )
            response.raise_for_status()

    async def push_rows(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        await self._upsert(table, rows)

    async def _remove(self, table: str, uids: Sequence[str]) -> None:
        """Delete rows upstream by uid.

        Quoted because a uid may legally contain a comma, and PostgREST splits
        an unquoted ``in.()`` list on them.
        """
        if not uids:
            return
        for start in range(0, len(uids), PAGE_SIZE):
            chunk = uids[start : start + PAGE_SIZE]
            quoted = ",".join('"' + str(uid).replace('"', '""') + '"' for uid in chunk)
            response = await self._client.delete(
                f"{self._base}/{table}",
                params={"uid": f"in.({quoted})"},
                headers={"Prefer": "return=minimal"},
            )
            response.raise_for_status()

    async def push_tombstones(self, rows: Sequence[dict[str, Any]]) -> None:
        """Publish deletions -- and actually delete the rows.

        Writing the tombstone alone left the row sitting in Supabase, so the
        next pull fetched it and merged it straight back. On the phone a board
        went from 3 tasks after a deletion to 38 seven seconds later: the
        delete worked, and the sync that was meant to publish it undid it.

        The tombstone is still published. It is what tells a peer holding the
        row to drop its copy, and what stops that peer's stale copy from
        re-creating the row on its own next push. It is a notification of a
        deletion now, rather than being mistaken for the whole of one.
        """
        await self._upsert("sync_tombstones", rows)

        by_table: dict[str, list[str]] = {}
        for row in rows:
            table = str(row.get("table_name") or "")
            uid = row.get("uid")
            if table and uid:
                by_table.setdefault(table, []).append(str(uid))
        for table, uids in by_table.items():
            await self._remove(table, uids)


# ---------------------------------------------------------------------------
# Watermarks
# ---------------------------------------------------------------------------

def _state_key(adapter: StorageAdapter, direction: str, name: str) -> str:
    """Namespace a watermark to the remote that issued it.

    A cursor is a token in *one* remote's clock and is meaningless anywhere
    else. Pointing JARVIS at a different backend -- a VPS instead of Supabase,
    a fresh project, a test double -- and reusing the old cursor would silently
    skip every row written before it. Keying on the remote makes that
    impossible: an unknown remote simply starts from nothing and pulls in full.
    """
    return f"{direction}:{getattr(adapter, 'remote_id', 'default')}:{name}"


async def _get_state(key: str) -> str | None:
    return await db.fetch_value(
        "SELECT value FROM sync_state WHERE key = ?", (key,), default=None
    )


async def _set_state(key: str, value: str) -> None:
    await db.execute(
        """
        INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value      = excluded.value,
                                       updated_at = excluded.updated_at
        """,
        (key, value, now_iso()),
    )


# ---------------------------------------------------------------------------
# Local read / write
# ---------------------------------------------------------------------------

def _upsert_sql(table: str) -> str:
    """Local upsert keyed on uid, resolved last-write-wins.

    The ``WHERE`` on ``DO UPDATE`` is what makes this safe to run repeatedly and
    in any order: an older remote row loses rather than clobbering a newer local
    edit.
    """
    columns = SYNC_COLUMNS[table]
    placeholders = ", ".join("?" for _ in columns)
    assignments = ", ".join(f"{c} = excluded.{c}" for c in columns if c != "uid")
    return (
        f"INSERT INTO {table} ({', '.join(columns)}) SELECT {placeholders} "
        f"WHERE NOT EXISTS (SELECT 1 FROM sync_tombstones WHERE table_name = '{table}' "
        f"AND uid = ? AND deleted_at >= ?) "
        f"ON CONFLICT(uid) DO UPDATE SET {assignments} "
        f"WHERE excluded.updated_at > {table}.updated_at"
    )


async def _local_changes(table: str, since: str | None) -> list[dict[str, Any]]:
    columns = ", ".join(SYNC_COLUMNS[table])
    if since:
        # `>=` rather than `>`: timestamps are second-resolution, so a strict
        # comparison drops any row sharing the boundary second. Re-sending the
        # boundary row each round is bounded and harmless -- the push upserts.
        return await db.fetch_all(
            f"SELECT {columns} FROM {table} "
            f"WHERE uid IS NOT NULL AND updated_at >= ? ORDER BY updated_at",
            (since,),
        )
    return await db.fetch_all(
        f"SELECT {columns} FROM {table} WHERE uid IS NOT NULL ORDER BY updated_at"
    )


async def _apply_remote_rows(table: str, rows: Iterable[dict[str, Any]]) -> int:
    columns = SYNC_COLUMNS[table]
    sql = _upsert_sql(table)
    applied = 0
    for row in rows:
        # The mirror also carries `synced_at`; project down to the shared
        # columns so drift on either side cannot corrupt the insert.
        values = tuple(row.get(c) for c in columns)
        if values[0] is None:  # uid -- nothing to key on
            continue
        changed = await db.execute_count(sql, (*values, row.get("uid"), row.get("updated_at")))
        if changed:
            await db.execute(
                "DELETE FROM sync_tombstones WHERE table_name = ? AND uid = ? AND deleted_at < ?",
                (table, row.get("uid"), row.get("updated_at")),
            )

        # Writing the row fired the pending triggers, so without this every
        # pulled row would be queued straight back for pushing -- an endless
        # round trip of rows the server already has.
        #
        # Cleared only when the remote version actually won. The upsert is a
        # no-op when the local row is newer, and in that case the local edit is
        # still unpublished and must stay pending.
        await db.execute(
            f"DELETE FROM sync_pending WHERE table_name = ? AND uid = ? "
            f"AND (SELECT updated_at FROM {table} WHERE uid = ?) = ?",
            (table, values[0], values[0], row.get("updated_at")),
        )
        applied += max(changed, 0)
    return applied


async def _apply_remote_tombstones(rows: Iterable[dict[str, Any]]) -> int:
    removed = 0
    for row in rows:
        table = row.get("table_name")
        uid = row.get("uid")
        deleted_at = row.get("deleted_at")
        if table not in SYNC_COLUMNS or not uid:
            continue
        await db.execute("INSERT INTO sync_tombstones (table_name, uid, deleted_at) VALUES (?, ?, ?) "
                         "ON CONFLICT(table_name, uid) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)",
                         (table, uid, deleted_at))
        local_stamp = await db.fetch_value(
            f"SELECT updated_at FROM {table} WHERE uid = ?", (uid,), default=None
        )
        if local_stamp is None:
            continue
        # A local edit made *after* the remote delete wins, and re-pushes on the
        # next round. Without this check a stale tombstone would keep deleting a
        # row the user has since brought back.
        if deleted_at and local_stamp > deleted_at:
            continue
        await db.execute(f"DELETE FROM {table} WHERE uid = ? AND updated_at <= ?", (uid, deleted_at))
        removed += 1
    return removed


# ---------------------------------------------------------------------------
# One round
# ---------------------------------------------------------------------------

#: How far back a pull re-reads before its stored cursor.
#:
#: `synced_at` is `now()`, which in Postgres is *transaction start* time -- and
#: transactions do not commit in start order. A write that began at 10:00:00.000
#: but committed slowly can land after one that began at 10:00:00.050 and
#: committed instantly. A cursor that advanced to the later stamp would step
#: straight over the earlier row and never see it again.
#:
#: Re-reading a few seconds of already-seen rows closes that window. It costs
#: nothing: the merge is idempotent, so re-examined rows are simply no-ops.
PULL_OVERLAP_SECONDS = 5


def _rewind(cursor: str | None) -> str | None:
    """Move a server cursor back by the overlap window."""
    if not cursor:
        return None
    try:
        moment = datetime.fromisoformat(cursor)
    except (TypeError, ValueError):
        # Not a timestamp (the test double uses a counter). Nothing to rewind.
        return cursor
    return (moment - timedelta(seconds=PULL_OVERLAP_SECONDS)).isoformat()


async def push(adapter: StorageAdapter, result: SyncResult) -> None:
    # The pending set records what this *device* has not published, which is not
    # the same as what a *given remote* has never seen. Pointing JARVIS at a
    # fresh backend -- a VPS replacing Supabase, a new project -- would otherwise
    # leave it permanently empty: every row was already published, just to
    # somewhere else. First contact therefore publishes everything once.
    boot_key = _state_key(adapter, "bootstrapped", "all")
    first_contact = await _get_state(boot_key) is None

    for table in SYNCED_TABLES:
        columns = ", ".join(f"t.{column}" for column in SYNC_COLUMNS[table])
        rows = await db.fetch_all(
            f"SELECT {columns} FROM {table} t WHERE t.uid IS NOT NULL ORDER BY t.updated_at"
            if first_contact
            else f"SELECT {columns} FROM {table} t "
            f"JOIN sync_pending p ON p.table_name = ? AND p.uid = t.uid "
            f"ORDER BY t.updated_at",
            () if first_contact else (table,),
        )
        result.pushed[table] = len(rows)
        if not rows:
            continue

        await adapter.push_rows(table, rows)

        # Clear the mark only for rows that still look exactly as they did when
        # they were read. Anything edited while the request was in flight stays
        # pending and goes out next round -- clearing it blindly would drop that
        # edit permanently, which is the failure this whole mechanism exists to
        # prevent.
        await db.execute_many(
            f"DELETE FROM sync_pending WHERE table_name = ? AND uid = ? "
            f"AND (SELECT updated_at FROM {table} WHERE uid = ?) = ?",
            [(table, row["uid"], row["uid"], row["updated_at"]) for row in rows],
        )

    # Recorded only after every table published cleanly, so a round that failed
    # part-way retries the full bootstrap rather than assuming it finished.
    if first_contact:
        await _set_state(boot_key, now_iso())

    tomb_key = _state_key(adapter, "push", "tombstones")
    since = await _get_state(tomb_key)
    tombstones = await db.fetch_all(
        "SELECT table_name, uid, deleted_at FROM sync_tombstones "
        + ("WHERE deleted_at >= ? " if since else "")
        + "ORDER BY deleted_at",
        (since,) if since else (),
    )
    result.tombstones_pushed = len(tombstones)
    if tombstones:
        await adapter.push_tombstones(tombstones)
        # Tombstones are immutable once written, so a plain high-water mark is
        # safe here in a way it never was for rows: a deletion cannot be edited
        # afterwards, so there is nothing for a moving clock to strand.
        await _set_state(tomb_key, max(t["deleted_at"] for t in tombstones))


async def pull(adapter: StorageAdapter, result: SyncResult) -> None:
    for table in SYNCED_TABLES:
        key = _state_key(adapter, "pull", table)
        stored = await _get_state(key)
        rows, cursor = await adapter.fetch_rows(table, _rewind(stored))
        result.pulled[table] = await _apply_remote_rows(table, rows)
        # Never let the stored cursor move backwards: the rewind is a read
        # widening, not a rollback.
        if cursor and (stored is None or str(cursor) > str(stored)):
            await _set_state(key, cursor)

    # Tombstones apply *after* rows, so a row that was edited and then deleted
    # elsewhere ends up deleted rather than resurrected by its own update.
    tomb_key = _state_key(adapter, "pull", "tombstones")
    stored = await _get_state(tomb_key)
    rows, cursor = await adapter.fetch_tombstones(_rewind(stored))
    result.deleted_locally = await _apply_remote_tombstones(rows)
    if cursor and (stored is None or str(cursor) > str(stored)):
        await _set_state(tomb_key, cursor)


def build_adapter() -> StorageAdapter | None:
    """The configured adapter, or ``None`` when sync is off or unconfigured."""
    if not settings.jarvis_sync_enabled:
        return None
    if not (settings.supabase_url and settings.supabase_service_key):
        return None
    return SupabaseAdapter(settings.supabase_url, settings.supabase_service_key)


async def sync_once(adapter: StorageAdapter | None = None) -> SyncResult:
    """Run one push + pull round.

    Never raises. Sync is a background convenience, and an unreachable Supabase
    -- offline, throttled, misconfigured -- must not take down an assistant that
    works perfectly well from local SQLite alone.
    """
    result = SyncResult()

    owned = adapter is None
    if adapter is None:
        adapter = build_adapter()
    if adapter is None:
        result.skipped = (
            "disabled"
            if not settings.jarvis_sync_enabled
            else "SUPABASE_URL / SUPABASE_SERVICE_KEY not set"
        )
        return result

    try:
        # Push first: local is the source of truth, so publishing what this
        # device knows before accepting remote state keeps a fresh local edit
        # from being overwritten by a stale remote copy of the same row.
        await push(adapter, result)
        await pull(adapter, result)
    except httpx.HTTPStatusError as exc:
        # PostgREST puts the actual cause -- constraint name, offending column,
        # bad value -- in the body. A bare status code sends you guessing at the
        # wire format when the answer was already in the response.
        detail = (exc.response.text or "").strip().replace("\n", " ")[:300]
        result.error = f"{exc.response.status_code} from {exc.request.url.path}: {detail}"
        logger.warning("Sync failed: %s", result.error)
    except httpx.HTTPError as exc:
        result.error = f"network: {exc.__class__.__name__}"
        logger.warning("Sync unreachable (%s) -- continuing on local data", exc)
    except Exception as exc:  # pragma: no cover - defensive
        result.error = repr(exc)
        logger.exception("Unexpected sync failure")
    finally:
        if owned:
            await adapter.close()

    return result


async def run_forever(stop: asyncio.Event | None = None) -> None:
    """Background loop: sync on boot, then every ``JARVIS_SYNC_INTERVAL`` seconds.

    Syncing immediately matters more than it looks. A device that has been off
    is exactly the one holding stale data, so waiting a full interval before the
    first round is the worst possible moment to wait.
    """
    stop = stop or asyncio.Event()
    interval = max(30, settings.jarvis_sync_interval)

    while not stop.is_set():
        try:
            result = await sync_once()
            if result.moved or result.deleted_locally:
                logger.info("%s", result.summary())
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - the loop must outlive any round
            logger.exception("Sync loop error; continuing")

        try:
            # Waiting on the event rather than sleeping means shutdown is
            # immediate instead of up to one interval late.
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
