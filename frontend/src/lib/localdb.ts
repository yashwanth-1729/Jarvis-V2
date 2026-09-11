/**
 * The client's local store.
 *
 * On the phone there is no Python backend and no SQLite, but the app still has
 * to render instantly on launch and stay usable with nothing reachable. So the
 * client keeps its own copy of the four synced tables in IndexedDB and treats
 * it as the read path: every list, filter and edit hits local storage, never
 * the network.
 *
 * IndexedDB rather than SQLite-via-plugin because the dataset is tiny (tens of
 * rows, kilobytes) and the queries are trivial. Avoiding a native plugin means
 * this exact module runs unchanged in a browser tab, in the Tauri desktop
 * shell, and inside the Android APK — which is also what lets the sync client
 * be tested in a browser before any Android toolchain exists.
 *
 * Row shapes mirror `backend/app/services/sync.py::SYNC_COLUMNS` exactly. The
 * two must not drift: `uid` is the identity on both sides and `updated_at` is
 * what decides conflicts.
 */

/** Mirrors `SYNCED_TABLES` in `backend/app/db/migrations.py`. */
import { blockEnd, localIso } from "@/lib/schedulePolicy";
import { upgradeMemoryContent } from "@/lib/memory";

export const SYNCED_TABLES = ["tasks", "schedules", "memories", "ideas", "note_pages"] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** A synced row. Loosely typed on purpose — the sync layer moves rows it does
 *  not need to interpret, and the UI narrows them where it actually cares. */
export interface SyncRow {
  uid: string;
  updated_at: string;
  kind?: unknown;
  [column: string]: unknown;
}

/**
 * The exact columns each table publishes, mirroring
 * `backend/app/services/sync.py::SYNC_COLUMNS`.
 *
 * Needed because PostgREST rejects a bulk insert whose objects do not all
 * carry an identical set of keys — `PGRST102: "All object keys must match"`.
 * Rows in IndexedDB are written by several paths over time, so their shapes
 * drift: one schedule has `notes`, an older one never had the field at all.
 * Pushing them as stored works right up until a single array happens to
 * contain both, which is exactly what a first-contact push guarantees.
 *
 * The Python engine never hit this because it SELECTs an explicit column list,
 * so every row it sends is the same shape. This is that projection.
 */
export const SYNC_COLUMNS: Record<SyncedTable, readonly string[]> = {
  tasks: [
    "uid", "title", "category", "priority", "status",
    "due_date", "created_at", "updated_at",
  ],
  schedules: [
    "uid", "event_name", "kind", "time_start", "time_end", "day_of_week",
    "start_time", "end_time", "location", "notes", "created_at", "updated_at",
  ],
  memories: [
    "uid", "key_concept", "category", "content", "created_at", "updated_at", "expires_at",
  ],
  ideas: [
    "uid", "title", "description", "tags", "status", "created_at", "updated_at", "page_uid",
  ],
  note_pages: ["uid", "title", "kind", "created_at", "updated_at"],
};

/** A row reduced to exactly its table's columns, absent ones explicitly null. */
export function project(table: SyncedTable, row: SyncRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of SYNC_COLUMNS[table]) {
    out[column] = row[column] === undefined ? null : row[column];
  }
  return out;
}

export interface Tombstone {
  table_name: string;
  uid: string;
  deleted_at: string;
}

const DB_NAME = "jarvis";
const DB_VERSION = 4;

/** Deletions awaiting publication, and watermarks. Prefixed so they can never
 *  collide with a table name that gets synced later. */
const TOMBSTONE_STORE = "__tombstones";

/** What has not yet been published. A set, never a timestamp cursor — see the
 *  note on `markPending`. */
const PENDING_STORE = "__pending";
const META_STORE = "__meta";

let dbPromise: Promise<IDBDatabase> | null = null;

// ---------------------------------------------------------------------------
// Local-change notifications
// ---------------------------------------------------------------------------
//
// Every write to the synced tables funnels through `putRows`/`deleteRow`, so a
// single notification here is enough for the auto-sync controller to know a
// push is due. Kept dependency-free (a plain Set) so `localdb` stays importable
// on the server render, and every callback is isolated so one throwing listener
// cannot swallow a write.
type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

/** Subscribe to local writes; returns an unsubscribe. */
export function onLocalChange(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function emitLocalChange(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // A listener's failure must never break the write that triggered it.
    }
  }
}

/** True in a browser/webview, false during the static-export prerender. */
export function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  if (!isAvailable()) {
    return Promise.reject(new Error("IndexedDB unavailable (server render?)"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of SYNCED_TABLES) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: "uid" });
        }
      }
      if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        // Composite key: the same uid could in principle exist in two tables.
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: ["table_name", "uid"] });
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: ["table_name", "uid"] });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      const memories = request.transaction!.objectStore("memories");
      const pending = request.transaction!.objectStore(PENDING_STORE);
      memories.openCursor().onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) return;
        const row = cursor.value as SyncRow;
        const category = row.category === "PRIVATE" ? "LONG_TERM" : row.category;
        const content = upgradeMemoryContent(row.content, {
          category,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        });
        if (category !== row.category || content !== row.content) {
          cursor.update({...row, category, content});
          if (row.uid) pending.put({table_name: "memories", uid: row.uid});
        }
        cursor.continue();
      };
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

/** Run `work` in one transaction and resolve when it *commits*.
 *
 *  Resolving on the request rather than the transaction is the classic
 *  IndexedDB bug: the write appears to succeed, the transaction later aborts,
 *  and the data is silently gone. Waiting for `oncomplete` means a resolved
 *  promise really does mean durable. */
async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    Promise.resolve(work(transaction)).then(
      (value) => {
        result = value;
      },
      (error) => {
        try {
          transaction.abort();
        } catch {
          /* already finishing */
        }
        reject(error);
      },
    );
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export async function listRows(table: SyncedTable): Promise<SyncRow[]> {
  return tx(table, "readonly", (t) =>
    wrap(t.objectStore(table).getAll() as IDBRequest<SyncRow[]>),
  );
}

export async function getRow(table: SyncedTable, uid: string): Promise<SyncRow | undefined> {
  return tx(table, "readonly", (t) =>
    wrap(t.objectStore(table).get(uid) as IDBRequest<SyncRow | undefined>),
  );
}

/**
 * Write rows the user changed, and mark them for publication.
 *
 * The mark is a *set membership*, never a timestamp watermark. "Have I sent
 * this row" is a fact about local state, and inferring it from a clock breaks
 * whenever the clock moves — forward (a peer's future-stamped row strands every
 * later edit below the mark) or backward (an NTP correction puts new rows below
 * a mark already in the future). Both fail silently, which is the worst way for
 * a sync engine to fail. A set has no clock in it.
 */
export async function putRows(table: SyncedTable, rows: SyncRow[]): Promise<void> {
  if (!rows.length) return;
  await tx([table, PENDING_STORE, TOMBSTONE_STORE], "readwrite", async (t) => {
    const store = t.objectStore(table);
    const pending = t.objectStore(PENDING_STORE);
    for (const row of rows) {
      const tomb = await wrap(t.objectStore(TOMBSTONE_STORE).get([table, row.uid])) as Tombstone | undefined;
      if (tomb && tomb.deleted_at >= row.updated_at) continue;
      if (tomb) t.objectStore(TOMBSTONE_STORE).delete([table, row.uid]);
      store.put(row);
      if (row.uid) pending.put({ table_name: table, uid: row.uid });
    }
  });
  emitLocalChange();
}

/** Rows still awaiting publication, oldest edit first. */
export async function listPending(table: SyncedTable): Promise<SyncRow[]> {
  return tx([table, PENDING_STORE], "readonly", async (t) => {
    const marks = (await wrap(
      t.objectStore(PENDING_STORE).getAll() as IDBRequest<Array<{ table_name: string; uid: string }>>,
    )).filter((m) => m.table_name === table);

    const store = t.objectStore(table);
    const rows: SyncRow[] = [];
    for (const mark of marks) {
      const row = await wrap(store.get(mark.uid) as IDBRequest<SyncRow | undefined>);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  });
}

/**
 * Clear marks for rows that were successfully sent.
 *
 * `sent` carries the `updated_at` each row had when it was read. A row edited
 * while the request was in flight no longer matches, keeps its mark, and goes
 * out next round — clearing blindly would drop that edit permanently, which is
 * exactly the failure this mechanism exists to prevent.
 */
export async function clearPending(
  table: SyncedTable,
  sent: Array<{ uid: string; updated_at: string }>,
): Promise<void> {
  if (!sent.length) return;
  await tx([table, PENDING_STORE], "readwrite", async (t) => {
    const store = t.objectStore(table);
    const pending = t.objectStore(PENDING_STORE);
    for (const { uid, updated_at } of sent) {
      const current = await wrap(store.get(uid) as IDBRequest<SyncRow | undefined>);
      if (current && String(current.updated_at) !== String(updated_at)) continue;
      pending.delete([table, uid]);
    }
  });
}

/**
 * Write a row only when it is genuinely newer, mirroring the server's
 * `keep_newer_write` trigger and the `WHERE excluded.updated_at > ...` guard on
 * the Python upsert.
 *
 * Returns how many actually landed, so a pull can report real movement rather
 * than counting rows it considered and rejected.
 */
export async function mergeRows(table: SyncedTable, rows: SyncRow[]): Promise<number> {
  if (!rows.length) return 0;
  return tx([table, PENDING_STORE, TOMBSTONE_STORE], "readwrite", async (t) => {
    const store = t.objectStore(table);
    const pending = t.objectStore(PENDING_STORE);
    let applied = 0;
    for (const row of rows) {
      if (!row?.uid) continue;
      const tomb = await wrap(t.objectStore(TOMBSTONE_STORE).get([table, row.uid])) as Tombstone | undefined;
      if (tomb && tomb.deleted_at >= row.updated_at) continue;
      if (tomb) t.objectStore(TOMBSTONE_STORE).delete([table, row.uid]);
      const existing = (await wrap(store.get(row.uid) as IDBRequest<SyncRow | undefined>)) ?? null;
      // A local row of equal or newer age wins, and stays pending — it is still
      // unpublished and must go out on the next push.
      if (existing && String(existing.updated_at) >= String(row.updated_at)) continue;
      store.put(row);
      // The remote version won, so there is nothing local left to publish.
      // Without this every pulled row would queue straight back for pushing.
      pending.delete([table, row.uid]);
      applied += 1;
    }
    return applied;
  });
}

/**
 * Merge rows produced by the mobile agent's disposable SQLite working copy.
 *
 * Agent changes are local user changes and therefore remain pending for the
 * next Supabase sync, but the working copy may be older than IndexedDB after a
 * restart.  Applying it through `putRows` would let that stale copy overwrite
 * a newer hand edit.  This path accepts only a strictly newer row while keeping
 * the accepted row queued for publication.
 */
export async function mergeAgentRows(table: SyncedTable, rows: SyncRow[]): Promise<number> {
  if (!rows.length) return 0;
  return tx([table, PENDING_STORE, TOMBSTONE_STORE], "readwrite", async (t) => {
    const store = t.objectStore(table);
    const pending = t.objectStore(PENDING_STORE);
    const tombstones = t.objectStore(TOMBSTONE_STORE);
    let applied = 0;
    for (const row of rows) {
      if (!row?.uid) continue;
      const tomb = await wrap(tombstones.get([table, row.uid])) as Tombstone | undefined;
      if (tomb && tomb.deleted_at >= String(row.updated_at)) continue;
      const existing = await wrap(store.get(row.uid) as IDBRequest<SyncRow | undefined>);
      if (existing && String(existing.updated_at) >= String(row.updated_at)) continue;
      if (tomb) tombstones.delete([table, row.uid]);
      store.put(row);
      pending.put({ table_name: table, uid: row.uid });
      applied += 1;
    }
    return applied;
  });
}

/**
 * Delete locally and record why, so the deletion can be published.
 *
 * A row that merely vanishes is indistinguishable from one that has not synced
 * in yet, and the next pull would restore it. The tombstone is what makes a
 * delete survive the round trip.
 */
export async function deleteRow(
  table: SyncedTable,
  uid: string,
  deletedAt: string,
): Promise<void> {
  await tx([table, TOMBSTONE_STORE, PENDING_STORE], "readwrite", async (t) => {
    const previous = await wrap(t.objectStore(TOMBSTONE_STORE).get([table, uid])) as Tombstone | undefined;
    const row = await wrap(t.objectStore(table).get(uid)) as SyncRow | undefined;
    deletedAt = [deletedAt, previous?.deleted_at ?? "", row?.updated_at ?? ""].sort().at(-1)!;
    t.objectStore(table).delete(uid);
    t.objectStore(PENDING_STORE).delete([table, uid]);
    t.objectStore(TOMBSTONE_STORE).put({ table_name: table, uid, deleted_at: deletedAt });
  });
  emitLocalChange();
}

/** Apply a deletion that arrived from the remote.
 *
 *  Skipped when the local row was edited *after* the delete happened: that edit
 *  is the newer fact and will re-publish on the next push. Without this a stale
 *  tombstone keeps deleting a row the user has since brought back. */
export async function applyRemoteTombstone(tomb: Tombstone): Promise<boolean> {
  if (!SYNCED_TABLES.includes(tomb.table_name as SyncedTable)) return false;
  const table = tomb.table_name as SyncedTable;
  return tx([table, TOMBSTONE_STORE, PENDING_STORE], "readwrite", async (t) => {
    const store = t.objectStore(table);
    const tombs = t.objectStore(TOMBSTONE_STORE);
    const previous = await wrap(tombs.get([table, tomb.uid])) as Tombstone | undefined;
    if (previous && previous.deleted_at > tomb.deleted_at) tomb = previous;
    tombs.put(tomb);
    const existing = (await wrap(store.get(tomb.uid) as IDBRequest<SyncRow | undefined>)) ?? null;
    if (!existing) return false;
    if (tomb.deleted_at && String(existing.updated_at) > String(tomb.deleted_at)) return false;
    store.delete(tomb.uid);
    t.objectStore(PENDING_STORE).delete([table, tomb.uid]);
    return true;
  });
}

export async function listTombstones(since?: string | null): Promise<Tombstone[]> {
  const all = await tx(TOMBSTONE_STORE, "readonly", (t) =>
    wrap(t.objectStore(TOMBSTONE_STORE).getAll() as IDBRequest<Tombstone[]>),
  );
  const fresh = since ? all.filter((x) => x.deleted_at >= since) : all;
  return fresh.sort((a, b) => a.deleted_at.localeCompare(b.deleted_at));
}

/** Expiry is a durable deletion, atomic with the read so rescheduling cannot race it. */
export async function expireBlocks(current = new Date()): Promise<number> {
  return tx(["schedules", TOMBSTONE_STORE, PENDING_STORE], "readwrite", async (t) => {
    const schedules = t.objectStore("schedules");
    const rows = await wrap(schedules.getAll()) as SyncRow[];
    let count = 0;
    for (const row of rows) {
      const end = blockEnd(row);
      if (end === null || end > current.getTime()) continue;
      const previous = await wrap(t.objectStore(TOMBSTONE_STORE).get(["schedules", row.uid])) as Tombstone | undefined;
      const deleted_at = [localIso(current), row.updated_at, previous?.deleted_at ?? ""].sort().at(-1)!;
      schedules.delete(row.uid);
      t.objectStore(PENDING_STORE).delete(["schedules", row.uid]);
      t.objectStore(TOMBSTONE_STORE).put({table_name: "schedules", uid: row.uid, deleted_at});
      count++;
    }
    return count;
  });
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

/** Remove temporary contents; only identity/time remain for deletion sync. */
export async function expireMemories(current = new Date()): Promise<number> {
  return tx(["memories", TOMBSTONE_STORE, PENDING_STORE], "readwrite", async t => {
    const store = t.objectStore("memories");
    const rows = await wrap(store.getAll()) as SyncRow[];
    let count = 0;
    for (const row of rows) {
      if (!row.expires_at || !(new Date(String(row.expires_at)).getTime() <= current.getTime())) continue;
      const previous = await wrap(t.objectStore(TOMBSTONE_STORE).get(["memories", row.uid])) as Tombstone | undefined;
      const deleted_at = [localIso(current), row.updated_at, previous?.deleted_at ?? ""].sort().at(-1)!;
      store.delete(row.uid);
      t.objectStore(PENDING_STORE).delete(["memories", row.uid]);
      t.objectStore(TOMBSTONE_STORE).put({table_name: "memories", uid: row.uid, deleted_at});
      count++;
    }
    return count;
  });
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await tx(META_STORE, "readonly", (t) =>
    wrap(t.objectStore(META_STORE).get(key) as IDBRequest<{ value: string } | undefined>),
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await tx(META_STORE, "readwrite", (t) => {
    t.objectStore(META_STORE).put({ key, value });
  });
}

/** Wipe everything. Used by the tests to stand in for a second device, and by
 *  a "reset local data" action in settings. */
export async function clearAll(): Promise<void> {
  const stores = [...SYNCED_TABLES, TOMBSTONE_STORE, PENDING_STORE, META_STORE];
  await tx(stores, "readwrite", (t) => {
    for (const store of stores) t.objectStore(store).clear();
  });
}

/**
 * How many local changes are waiting to be published.
 *
 * Cheap on purpose: counts only, no rows read. Used to decide whether leaving
 * the app is worth a network round trip, and the answer is usually no — an
 * app that phones home every time it is backgrounded is one people turn off.
 */
export async function pendingCount(): Promise<number> {
  if (!isAvailable()) return 0;
  let total = 0;
  for (const table of SYNCED_TABLES) {
    total += (await listPending(table)).length;
  }
  // Every tombstone, not just unpublished ones: the push watermark is keyed
  // per remote and lives in the sync client, and syncing once too often is
  // a far cheaper mistake than dropping a deletion on the floor.
  total += (await listTombstones(null)).length;
  return total;
}
