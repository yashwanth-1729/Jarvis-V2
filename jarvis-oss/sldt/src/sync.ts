/**
 * The sync algorithm: fetch manifest, verify, detect replay, pull changed
 * objects, resolve conflicts against pending local edits, push local
 * changes, then CAS-update the manifest -- retrying the whole cycle on a
 * lost race, bounded so contention can't spin forever.
 */

import { resolveConflict } from "./conflict.js";
import { ConcurrentWriteConflict, SyncRetriesExhausted } from "./errors.js";
import {
  emptyManifest,
  hashManifest,
  signManifest,
  verifyManifest,
  type ManifestData,
  type ManifestObjectEntry,
  type SignedManifest,
} from "./manifest.js";
import { deserializeManifest, serializeManifest } from "./manifest.js";
import {
  decodeObject,
  deserializeEnvelope,
  encodeObject,
  hashCiphertextBytes,
  serializeEnvelope,
  type ObjectRecord,
} from "./objects.js";
import type { Store } from "./store.js";

const MANIFEST_PATH = "manifest.json";
const MAX_SYNC_RETRIES = 5;

/**
 * Durable per-device sync cursor. Must be persisted by the host app across
 * restarts (SQLite row, IndexedDB record, whatever) -- an in-memory-only
 * `lastSyncedManifestRevision` forgets itself on a cold start and weakens
 * replay protection right when a long-offline device needs it most.
 */
export interface SyncState {
  lastSyncedManifestRevision: number;
}

export function initialSyncState(): SyncState {
  return { lastSyncedManifestRevision: 0 };
}

export interface LocalObject extends ObjectRecord {
  /** True if this device has an edit that hasn't been confirmed pushed yet. */
  pending: boolean;
  /** The store's version token for this object's ciphertext, as last observed -- the CAS token for the next write to its path. Null means "never observed / doesn't exist yet remotely." */
  storeVersion: string | null;
  /**
   * The manifest `hash` this device last confirmed matches remote reality
   * (via a pull, or its own successful push). Comparing hashes rather than
   * revision numbers is what catches the case a plain revision comparison
   * misses: a conflict winner can keep its existing revision number, so two
   * devices can each hold "revision 2" while disagreeing about content --
   * only the hash actually distinguishes them.
   */
  knownHash: string | null;
}

/** In-memory local object set the caller owns and mutates between syncs (via `upsert`/`remove`). Persistence of this set is entirely the host app's responsibility -- SLDT only knows how to reconcile it against the remote. */
export type LocalObjectSet = Map<string, LocalObject>;

export function upsert(
  local: LocalObjectSet,
  deviceId: string,
  objectId: string,
  type: string,
  payload: unknown,
): void {
  const previous = local.get(objectId);
  local.set(objectId, {
    objectId,
    revision: (previous?.revision ?? 0) + 1,
    deviceId,
    type,
    deleted: false,
    payload,
    pending: true,
    storeVersion: previous?.storeVersion ?? null,
    knownHash: previous?.knownHash ?? null,
  });
}

/**
 * Deletes write a tombstone record through the same path as any other edit
 * -- see module doc in manifest.ts and the design note in the README about
 * why entries are never actually removed.
 *
 * `payload` is optional metadata a caller may want to keep alongside the
 * tombstone (e.g. a deletion timestamp some other layer's own delete
 * semantics require) -- the `deleted` flag, not this field, is what the
 * protocol itself acts on.
 */
export function remove(local: LocalObjectSet, deviceId: string, objectId: string, payload: unknown = null): void {
  const previous = local.get(objectId);
  local.set(objectId, {
    objectId,
    revision: (previous?.revision ?? 0) + 1,
    deviceId,
    type: previous?.type ?? "unknown",
    deleted: true,
    payload,
    pending: true,
    storeVersion: previous?.storeVersion ?? null,
    knownHash: previous?.knownHash ?? null,
  });
}

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  corrupted: string[];
  state: SyncState;
}

export interface SyncOptions {
  store: Store;
  encryptionKey: CryptoKey;
  authKey: Uint8Array;
  deviceId: string;
  local: LocalObjectSet;
  state: SyncState;
}

export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
  for (let attempt = 0; attempt < MAX_SYNC_RETRIES; attempt++) {
    const result = await attemptSync(options);
    if (result) return result;
    // A concurrent writer won the manifest CAS race; re-fetch and retry from scratch.
  }
  throw new SyncRetriesExhausted(MAX_SYNC_RETRIES);
}

async function attemptSync(options: SyncOptions): Promise<SyncResult | null> {
  const { store, encryptionKey, authKey, local, state } = options;

  const remoteManifestObject = await store.get(MANIFEST_PATH);
  let remoteManifest: SignedManifest;
  let manifestVersion: string | null;

  if (remoteManifestObject === null) {
    // First device: nothing to pull, publish everything pending and stop.
    return publishFirstManifest(options);
  }

  remoteManifest = deserializeManifest(remoteManifestObject.content);
  manifestVersion = remoteManifestObject.version;
  await verifyManifest(remoteManifest, authKey, state.lastSyncedManifestRevision);

  const pulled: string[] = [];
  const corrupted: string[] = [];

  for (const [objectId, entry] of Object.entries(remoteManifest.data.objects)) {
    const localEntry = local.get(objectId);

    // A pending local edit always needs conflict resolution (the remote
    // side may have moved too, even to the same revision number -- see
    // `knownHash` doc). Absent a pending edit, only fetch when the
    // manifest's hash for this object has actually moved past what we last
    // confirmed; comparing revision numbers alone would miss a conflict
    // winner that kept its existing revision.
    const needsFetch = localEntry?.pending || !localEntry || entry.hash !== localEntry.knownHash;
    if (!needsFetch) continue;

    const remoteRecord = await fetchAndVerifyObject(store, objectId, entry, encryptionKey, corrupted);
    if (!remoteRecord) continue;

    if (localEntry?.pending) {
      const winner = resolveConflict(
        { revision: remoteRecord.revision, deviceId: remoteRecord.deviceId },
        { revision: localEntry.revision, deviceId: localEntry.deviceId },
      );
      if (winner.deviceId === remoteRecord.deviceId && winner.revision === remoteRecord.revision) {
        local.set(objectId, { ...remoteRecord, pending: false, knownHash: entry.hash });
        pulled.push(objectId);
      } else {
        // Local edit wins: keep its content/revision, but refresh storeVersion
        // to what was just observed remotely -- otherwise the push below CAS
        // writes against a stale token (the version from before the other
        // device's write) and loses the race every retry, forever.
        local.set(objectId, { ...localEntry, storeVersion: remoteRecord.storeVersion });
      }
    } else {
      local.set(objectId, { ...remoteRecord, pending: false, knownHash: entry.hash });
      pulled.push(objectId);
    }
  }

  // Advance the revision watermark right after the pull, before any local
  // push -- so this device's own edits sort strictly after whatever was
  // just absorbed. Doing this after the push instead is the classic
  // off-by-one that makes local edits keep losing to stale remote state.
  const newState: SyncState = {
    lastSyncedManifestRevision: Math.max(state.lastSyncedManifestRevision, remoteManifest.data.revision),
  };

  const pushedEntries = await pushPendingObjects(store, local, encryptionKey);
  const pushed = Object.keys(pushedEntries);
  if (pushed.length === 0) {
    return { pulled, pushed, corrupted, state: newState };
  }

  const nextData: ManifestData = {
    revision: remoteManifest.data.revision + 1,
    previousManifestHash: await hashManifest(remoteManifest),
    objects: { ...remoteManifest.data.objects, ...pushedEntries },
  };
  const nextSigned = await signManifest(nextData, authKey);

  try {
    await store.put(MANIFEST_PATH, serializeManifest(nextSigned), manifestVersion);
  } catch (error) {
    if (error instanceof ConcurrentWriteConflict) {
      return null; // caller retries the whole cycle
    }
    throw error;
  }

  for (const objectId of pushed) {
    const entry = local.get(objectId);
    if (entry) local.set(objectId, { ...entry, pending: false, knownHash: pushedEntries[objectId].hash });
  }

  return {
    pulled,
    pushed,
    corrupted,
    state: { lastSyncedManifestRevision: nextData.revision },
  };
}

async function fetchAndVerifyObject(
  store: Store,
  objectId: string,
  entry: ManifestObjectEntry,
  encryptionKey: CryptoKey,
  corrupted: string[],
): Promise<LocalObject | null> {
  const stored = await store.get(objectPath(objectId));
  if (!stored) {
    corrupted.push(objectId);
    return null;
  }
  const actualHash = await hashCiphertextBytes(stored.content);
  if (actualHash !== entry.hash) {
    corrupted.push(objectId);
    return null; // reject silently-corrupted objects without crashing the whole sync cycle
  }
  try {
    const envelope = deserializeEnvelope(stored.content);
    const record = await decodeObject(encryptionKey, envelope, objectId);
    return { ...record, pending: false, storeVersion: stored.version, knownHash: entry.hash };
  } catch {
    corrupted.push(objectId);
    return null;
  }
}

async function pushPendingObjects(
  store: Store,
  local: LocalObjectSet,
  encryptionKey: CryptoKey,
): Promise<Record<string, ManifestObjectEntry>> {
  const entries: Record<string, ManifestObjectEntry> = {};
  for (const [objectId, record] of local) {
    if (!record.pending) continue;
    const encoded = await encodeObject(encryptionKey, record);
    const newVersion = await store.put(
      objectPath(objectId),
      serializeEnvelope(encoded.envelope),
      record.storeVersion,
    );
    local.set(objectId, { ...record, storeVersion: newVersion });
    entries[objectId] = {
      revision: record.revision,
      hash: encoded.ciphertextHash,
      type: record.type,
      deleted: record.deleted,
    };
  }
  return entries;
}

async function publishFirstManifest(options: SyncOptions): Promise<SyncResult> {
  const { store, encryptionKey, authKey, local } = options;
  const objects: Record<string, ManifestObjectEntry> = {};
  const pushed: string[] = [];

  for (const [objectId, record] of local) {
    if (!record.pending) continue;
    const encoded = await encodeObject(encryptionKey, record);
    const newVersion = await store.put(objectPath(objectId), serializeEnvelope(encoded.envelope), null);
    local.set(objectId, { ...record, storeVersion: newVersion });
    objects[objectId] = {
      revision: record.revision,
      hash: encoded.ciphertextHash,
      type: record.type,
      deleted: record.deleted,
    };
    pushed.push(objectId);
  }

  const data: ManifestData = { ...emptyManifest(), revision: 1, objects };
  const signed = await signManifest(data, authKey);
  await store.put(MANIFEST_PATH, serializeManifest(signed), null);

  for (const objectId of pushed) {
    const entry = local.get(objectId);
    if (entry) local.set(objectId, { ...entry, pending: false, knownHash: objects[objectId].hash });
  }

  return { pulled: [], pushed, corrupted: [], state: { lastSyncedManifestRevision: 1 } };
}

function objectPath(objectId: string): string {
  return `objects/${objectId}.enc`;
}
