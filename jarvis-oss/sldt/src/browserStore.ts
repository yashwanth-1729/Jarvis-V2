/**
 * IndexedDB persistence for the sync engine's local state.
 *
 * `sync.ts` deliberately owns no persistence -- it takes a `LocalObjectSet`
 * and `SyncState` as plain in-memory arguments and hands back updated
 * versions, exactly like `frontend/src/lib/localdb.ts` owns storage while
 * `syncClient.ts` only owns reconciliation. This module is that storage half
 * for SLDT, following the same shape deliberately: IndexedDB works unchanged
 * in a browser tab, the Tauri desktop shell, and an Android webview, which is
 * also what lets this be tested without any native toolchain (see
 * `tests/browserStore.test.ts`, run under `fake-indexeddb`).
 *
 * What is never stored here: the account `secret`. Only `datasetId` (public)
 * and this device's own `deviceId` are persisted -- re-deriving encryption
 * keys from a re-entered recovery code every session is the deliberate
 * usability/security tradeoff the SLDT design calls for, not an oversight.
 */

import type { LocalObject, LocalObjectSet, SyncState } from "./sync.js";

const DB_NAME = "sldt";
const DB_VERSION = 1;

const OBJECTS_STORE = "objects";
const META_STORE = "meta";

const META_KEY_SYNC_STATE = "syncState";
const META_KEY_DATASET_ID = "datasetId";
const META_KEY_DEVICE_ID = "deviceId";

let dbPromise: Promise<IDBDatabase> | null = null;

/** True in a browser/webview, false during a server render or a non-browser test. */
export function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  if (!isAvailable()) {
    return Promise.reject(new Error("IndexedDB unavailable in this environment"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OBJECTS_STORE)) {
        db.createObjectStore(OBJECTS_STORE, { keyPath: "objectId" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

/** Run `work` in one transaction, resolving only when it *commits* -- resolving on the
 *  individual request instead is the classic IndexedDB bug where a write looks like it
 *  succeeded but the surrounding transaction later aborts and the data is silently gone. */
async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (t: IDBTransaction) => Promise<T> | T,
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
// Local objects
// ---------------------------------------------------------------------------

export async function loadLocalObjects(): Promise<LocalObjectSet> {
  const rows = await tx(OBJECTS_STORE, "readonly", (t) =>
    wrap(t.objectStore(OBJECTS_STORE).getAll() as IDBRequest<LocalObject[]>),
  );
  const map: LocalObjectSet = new Map();
  for (const row of rows) map.set(row.objectId, row);
  return map;
}

/** Persist the full local object set. Overwrites every row -- fine at this dataset's
 *  scale (tens to low thousands of records), and simpler than diffing dirty entries. */
export async function saveLocalObjects(local: LocalObjectSet): Promise<void> {
  await tx(OBJECTS_STORE, "readwrite", (t) => {
    const store = t.objectStore(OBJECTS_STORE);
    for (const record of local.values()) store.put(record);
  });
}

export async function saveLocalObject(record: LocalObject): Promise<void> {
  await tx(OBJECTS_STORE, "readwrite", (t) => {
    t.objectStore(OBJECTS_STORE).put(record);
  });
}

// ---------------------------------------------------------------------------
// Sync cursor and non-secret identity
// ---------------------------------------------------------------------------

export async function loadSyncState(): Promise<SyncState | null> {
  const row = await tx(META_STORE, "readonly", (t) =>
    wrap(t.objectStore(META_STORE).get(META_KEY_SYNC_STATE) as IDBRequest<{ key: string; value: SyncState } | undefined>),
  );
  return row?.value ?? null;
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await tx(META_STORE, "readwrite", (t) => {
    t.objectStore(META_STORE).put({ key: META_KEY_SYNC_STATE, value: state });
  });
}

export async function loadDatasetId(): Promise<string | null> {
  return loadMetaString(META_KEY_DATASET_ID);
}

export async function saveDatasetId(datasetId: string): Promise<void> {
  await saveMetaString(META_KEY_DATASET_ID, datasetId);
}

export async function loadDeviceId(): Promise<string | null> {
  return loadMetaString(META_KEY_DEVICE_ID);
}

export async function saveDeviceId(deviceId: string): Promise<void> {
  await saveMetaString(META_KEY_DEVICE_ID, deviceId);
}

async function loadMetaString(key: string): Promise<string | null> {
  const row = await tx(META_STORE, "readonly", (t) =>
    wrap(t.objectStore(META_STORE).get(key) as IDBRequest<{ key: string; value: string } | undefined>),
  );
  return row?.value ?? null;
}

async function saveMetaString(key: string, value: string): Promise<void> {
  await tx(META_STORE, "readwrite", (t) => {
    t.objectStore(META_STORE).put({ key, value });
  });
}

/** Test-only: wipe every store. Never call this from application code -- see
 *  the project convention of never populating or deleting real user records
 *  for tests, only isolated fixtures. */
export async function clearAllForTests(): Promise<void> {
  await tx([OBJECTS_STORE, META_STORE], "readwrite", (t) => {
    t.objectStore(OBJECTS_STORE).clear();
    t.objectStore(META_STORE).clear();
  });
}

/**
 * Test-only: forget the cached database connection.
 *
 * `open()` memoizes its connection in `dbPromise` for the lifetime of the
 * module -- correct in a real app (one IndexedDB per origin, for the whole
 * session) but wrong the moment a test swaps `globalThis.indexedDB` for a
 * fresh `IDBFactory` to simulate a second device: without this, every
 * "device" after the first would silently keep talking to the first
 * device's fake database.
 */
export function resetConnectionForTests(): void {
  dbPromise = null;
}
