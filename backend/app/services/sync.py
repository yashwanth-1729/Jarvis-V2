"""Column definitions shared with the client-side sync engine.

This used to be the whole sync engine: a server-side push/pull loop syncing
this process's own SQLite against Supabase, for whichever platform did not
set ``jarvis_client_owned_data``. As of 2026-09-12 every platform sets that
flag -- desktop adopted the same architecture mobile already used, one
client-side sync engine per device (see ``frontend/src/lib/syncClient.ts`,
which ports the semantics this file used to implement: last-write-wins on
``updated_at``, tombstones for deletes, ``synced_at`` as the pull cursor).
A second engine running here would race the client and double-write the same
rows to the mirror, so it was removed rather than left dormant. See
``explanations.md`` (2026-09-12) for the full history if any of that
reasoning is ever needed again.

``SYNC_COLUMNS`` survives because ``app.api.localstore`` -- the seed/drain
bridge a client-owned-data runtime uses to hand its working copy to the
agent and take local edits back -- still needs to know which columns travel
between the two stores. It must stay byte-for-byte identical to
``SYNCED_TABLES`` in ``frontend/src/lib/localdb.ts``: the two sides project
the same rows to the same shape, and a mismatch there is a sync bug that
only shows up as a field silently failing to travel.
"""

from __future__ import annotations

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
