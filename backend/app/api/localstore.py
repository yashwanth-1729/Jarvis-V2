"""Bridge between a client-owned data store and the agent's database.

Every platform runs client-owned-data now (2026-09-12): IndexedDB in the
WebView holds the authoritative copy and syncs it to Supabase, while this
backend is only the AI runtime. That leaves a gap, because the agent's tools
read and write SQLite directly and have no idea the real data lives
somewhere else.

Two endpoints close it, and the shape follows from the agent needing to *read*
as well as write:

``seed``
    The client uploads its rows. SQLite becomes a working copy, so
    "what's on my board?" answers from the user's actual data rather than an
    empty table.
``drain``
    Returns everything the agent changed since the last drain and forgets it.
    The client applies those changes to IndexedDB and queues them for
    Supabase, so the phone's authoritative store stays authoritative.

The journal is not new machinery: ``sync_pending`` is already maintained by
database triggers on every insert and update, and ``sync_tombstones`` already
records deletes. Both exist for cross-device sync, and they answer exactly the
question this bridge asks -- what changed here.

Consequently the SQLite file on a phone is disposable. Losing it costs nothing;
it is re-seeded on the next launch.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.core.config import settings
from app.providers import close_providers
from app.core.timeutil import now_iso
from app.db.database import db
from app.db.migrations import SYNCED_TABLES
from app.services.sync import SYNC_COLUMNS

logger = logging.getLogger("jarvis.localstore")

router = APIRouter(prefix="/api/local", tags=["local-store"])


def _require_client_owned() -> None:
    """Refuse unless this instance is explicitly a client-owned-data runtime.

    Draining consumes ``sync_pending``, which the Supabase sync engine also
    consumes. On a desktop, where the backend owns its data and pushes it
    upstream itself, letting a client drain that queue would silently eat
    changes before they ever reached Supabase.
    """
    if not settings.jarvis_client_owned_data:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This backend owns its own data; the local-store bridge is disabled.",
        )



def numeric_id(uid: str) -> int:
    """A stable rowid derived from the uid. Mirrors `numericId` in localDashboard.ts.

    This is the fix for a bug that looked impossible: opening a task on the
    board and deleting it answered "No task with id N" about a record visible
    on screen.

    Seeding replaces the working copy wholesale -- DELETE, then INSERT of the
    synced columns -- and `SYNC_COLUMNS` carries no `id`, so SQLite invented
    fresh rowids on every seed. Seeds run at launch and after every hand edit;
    one device log showed twenty in two days. The screen kept the ids it was
    given, the database renumbered underneath it, and the two silently stopped
    agreeing about which row was which.

    Deriving the rowid from the uid removes the disagreement rather than
    patching over it: the id is now a pure function of the record's durable
    identity, so a reseed cannot move it, and it is byte-identical to the id
    the client computes for the same row when it reads IndexedDB directly.
    That last part matters -- those were two separate id spaces before, and
    which one the UI held depended on whether the backend had answered yet.

    FNV-1a, 32-bit, kept positive and inside the safe-integer range. Collisions
    over a few hundred rows are on the order of one in a million; a duplicate
    would surface immediately as an INSERT conflict rather than silently.
    """
    hash_ = 0x811C9DC5
    for character in uid:
        hash_ ^= ord(character)
        hash_ = (hash_ * 0x01000193) & 0xFFFFFFFF
    return (hash_ % 2_000_000_000) + 1


@router.post("/seed", summary="Replace the working copy with the client's data")
async def seed(payload: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Load the client's rows into SQLite so the agent can read them.

    Replaces rather than merges: the client is the source of truth, so anything
    here that it did not send is stale by definition.
    """
    _require_client_owned()

    loaded: dict[str, int] = {}
    for table in SYNCED_TABLES:
        rows = payload.get(table) or []
        # `id` is written explicitly rather than left to AUTOINCREMENT. See
        # `numeric_id` -- letting SQLite renumber on every seed is what made
        # deleting a visible task report that it did not exist.
        columns = ("id", *SYNC_COLUMNS[table])
        placeholders = ", ".join("?" for _ in columns)

        await db.execute(f"DELETE FROM {table}")
        if rows:
            await db.execute_many(
                f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
                [
                    (
                        numeric_id(str(row.get("uid") or "")),
                        *(row.get(column) for column in SYNC_COLUMNS[table]),
                    )
                    for row in rows
                    if row.get("uid")
                ],
            )
        loaded[table] = len(rows)

    # Seeding is not a change. The inserts above tripped the pending triggers,
    # so clearing the queue here is what stops the very next drain handing the
    # client its own data back as if the agent had produced it.
    await db.execute("DELETE FROM sync_pending")
    await db.execute("DELETE FROM sync_tombstones")

    logger.info("Seeded working copy: %s", loaded)
    return {"seeded": loaded, "at": now_iso()}


@router.post("/drain", summary="Take everything the agent changed")
async def drain() -> dict[str, Any]:
    """Return the agent's changes and forget them.

    Destructive by design: each change is handed over exactly once, and the
    client is responsible for it from that point. Returning without clearing
    would replay the same edits on every call.
    """
    _require_client_owned()

    upserts: dict[str, list[dict[str, Any]]] = {}
    for table in SYNCED_TABLES:
        columns = ", ".join(f"t.{column}" for column in SYNC_COLUMNS[table])
        rows = await db.fetch_all(
            f"SELECT {columns} FROM {table} t "
            f"JOIN sync_pending p ON p.table_name = ? AND p.uid = t.uid "
            f"ORDER BY t.updated_at",
            (table,),
        )
        if rows:
            upserts[table] = rows

    deletes = await db.fetch_all(
        "SELECT table_name, uid, deleted_at FROM sync_tombstones ORDER BY deleted_at"
    )

    if upserts or deletes:
        await db.execute("DELETE FROM sync_pending")
        await db.execute("DELETE FROM sync_tombstones")
        logger.info(
            "Drained %d upserts, %d deletes to the client",
            sum(len(rows) for rows in upserts.values()),
            len(deletes),
        )

    return {"upserts": upserts, "deletes": deletes, "at": now_iso()}


@router.post("/credentials", summary="Hand the runtime its provider key")
async def credentials(payload: dict[str, str]) -> dict[str, Any]:
    """Set the provider API key for this session.

    A packaged app ships no ``.env``, so the key cannot come from disk the way
    it does on the desktop. The client holds it -- entered once in settings,
    stored on the device -- and hands it over whenever it connects.

    Deliberately not persisted here. The client already stores it and re-sends
    on every connect, so writing a second copy into the app's files would add a
    place for the key to leak from without adding any capability. It lives in
    memory for the life of the process and goes when the app closes.

    The value is never logged, and the response reports only whether a key is
    now present.

    **Desktop carve-out.** This endpoint predates desktop being client-owned
    at all -- only Android ever called it, because only Android's sandboxed
    ``.env`` genuinely ships with no key. Desktop adopting the same sync
    architecture (2026-09-12) made its frontend start calling this too, on
    every app open, with whatever this browser's own localStorage holds --
    which is empty on a machine that has only ever relied on the real key
    already sitting in ``backend/.env``, since desktop never needed to type
    it into Settings. An empty key here silently overwrote the correct one on
    every single launch, disabling voice mode outright (`has_api_key` false)
    with no visible error -- caught live: `/api/health` flipped from
    `api_key_configured: true` right after a fresh restart to `false` within
    seconds, as soon as the frontend's first-contact handshake ran.
    Android's `.env` has no key to protect, so an empty value there still
    means exactly what it always has -- "clear it" -- and that path is
    untouched. Desktop's Settings panel can still type in an override key at
    any time; only a *blank* value is now treated as "nothing to hand over"
    rather than "erase the working one" when a real key is already active.
    """
    _require_client_owned()

    key = (payload.get("sarvam_api_key") or "").strip()
    if not key and not settings.jarvis_android and settings.has_api_key:
        return {"configured": True}
    settings.sarvam_api_key = key

    # The HTTP clients bake the key into their auth header when first built and
    # then cache it, so a new key does nothing until they are torn down. They
    # rebuild lazily on the next request.
    await close_providers()

    logger.info("Provider credentials %s", "set" if key else "cleared")
    return {"configured": bool(key)}


@router.get("/sync-bootstrap", summary="Hand a first-run client its Supabase credentials")
async def sync_bootstrap() -> dict[str, str]:
    """Save a desktop user from retyping a key that is already on their disk.

    Desktop's ``backend/.env`` has held the real Supabase URL and service key
    since before sync moved client-side -- they were already cleartext on
    this exact machine, just read by this process instead of the browser.
    Handing them to the frontend once, over localhost, to seed its own
    localStorage is not a new exposure; it removes a manual copy-paste step
    that would otherwise reproduce a value already sitting on disk here.

    Android's bundled backend never has these set (its ``.env`` ships empty,
    deliberately -- the service key must never enter the APK), so this always
    returns blanks there and the client falls back to its existing manual
    entry in Settings, unchanged.

    The client calls this at most once (only when its own localStorage is
    still empty) -- see `frontend/src/lib/syncClient.ts` -- so a user who
    later clears or edits their stored credentials is never overwritten by
    this endpoint on a subsequent launch.
    """
    _require_client_owned()
    return {
        "supabase_url": settings.supabase_url.strip(),
        "supabase_key": settings.supabase_service_key.strip(),
    }
