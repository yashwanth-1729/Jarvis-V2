/**
 * The one thing an app actually calls. Composes identity/key derivation,
 * IndexedDB persistence, and the sync engine into a small stateful client:
 * create it once per session (deriving keys from a re-entered recovery
 * code), make local edits, call `sync()` when you want to reconcile.
 *
 * Everything this wraps is independently tested in isolation
 * (identity.test.ts, browserStore.test.ts, sync.test.ts); this file's own
 * tests focus on the composition -- that edits made through the façade
 * actually round-trip through persistence and converge across "devices"
 * the way the underlying engine promises.
 */

import {
  loadDeviceId,
  loadLocalObjects,
  loadSyncState,
  saveDeviceId,
  saveLocalObjects,
  saveSyncState,
} from "./browserStore.js";
import { deriveKeys, generateDatasetId, type Identity } from "./identity.js";
import { importAesKey } from "./crypto.js";
import {
  initialSyncState,
  remove as removeObject,
  syncOnce,
  upsert as upsertObject,
  type LocalObject,
  type LocalObjectSet,
  type SyncResult,
  type SyncState,
} from "./sync.js";
import type { Store } from "./store.js";

export interface SldtClientOptions {
  /** The account. Held only in memory for this client's lifetime -- never written by this module. */
  identity: Identity;
  store: Store;
  /** Supply to reuse a known device id (e.g. one already persisted elsewhere); otherwise one is generated and persisted here. */
  deviceId?: string;
}

/** Generates a fresh, unpersisted device id -- distinct from the account's `datasetId`, which identifies the dataset, not any one device. */
export function generateDeviceId(): string {
  return generateDatasetId(); // same shape (random, URL-safe) serves fine; naming kept distinct for clarity at call sites.
}

export class SldtClient {
  private readonly store: Store;
  private readonly deviceId: string;
  private readonly encryptionKey: CryptoKey;
  private readonly authKey: Uint8Array;
  private local: LocalObjectSet;
  private state: SyncState;

  private constructor(
    store: Store,
    deviceId: string,
    encryptionKey: CryptoKey,
    authKey: Uint8Array,
    local: LocalObjectSet,
    state: SyncState,
  ) {
    this.store = store;
    this.deviceId = deviceId;
    this.encryptionKey = encryptionKey;
    this.authKey = authKey;
    this.local = local;
    this.state = state;
  }

  /**
   * Derives keys from `options.identity` and loads whatever this device has
   * persisted before (empty on a first run). Call once per session -- the
   * identity's `secret` is used here and then never touched again; nothing
   * in this class persists it.
   */
  static async create(options: SldtClientOptions): Promise<SldtClient> {
    const keys = await deriveKeys(options.identity);
    const encryptionKey = await importAesKey(keys.encryptionKey);

    let deviceId = options.deviceId ?? (await loadDeviceId());
    if (!deviceId) {
      deviceId = generateDeviceId();
    }
    await saveDeviceId(deviceId);

    const local = await loadLocalObjects();
    const state = (await loadSyncState()) ?? initialSyncState();

    return new SldtClient(options.store, deviceId, encryptionKey, keys.authKey, local, state);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  get(objectId: string): LocalObject | undefined {
    return this.local.get(objectId);
  }

  listByType(type: string): LocalObject[] {
    return [...this.local.values()].filter((record) => record.type === type && !record.deleted);
  }

  /** Every record this client knows about, tombstones included -- for callers (like a `Remote` adapter) that need to distinguish deletes from live records themselves rather than have them filtered out. */
  listAll(): LocalObject[] {
    return [...this.local.values()];
  }

  /** Create or edit a record. Queued locally; call `sync()` to publish it. */
  upsert(objectId: string, type: string, payload: unknown): void {
    upsertObject(this.local, this.deviceId, objectId, type, payload);
  }

  /**
   * Tombstone a record. Queued locally like `upsert`; call `sync()` to
   * publish it. `payload` may carry caller-specific tombstone metadata (e.g.
   * a deletion timestamp another layer's semantics need) -- the protocol's
   * own `deleted` flag, not this field, is what other devices act on.
   */
  delete(objectId: string, payload: unknown = null): void {
    removeObject(this.local, this.deviceId, objectId, payload);
  }

  /**
   * Run one pull/resolve/push cycle, then persist the resulting local state.
   * Persistence happens even if the network round trip throws, so local
   * edits already queued are never lost to a crash mid-cycle -- only what
   * actually reached the store can be marked as no longer pending.
   */
  async sync(): Promise<SyncResult> {
    try {
      const result = await syncOnce({
        store: this.store,
        encryptionKey: this.encryptionKey,
        authKey: this.authKey,
        deviceId: this.deviceId,
        local: this.local,
        state: this.state,
      });
      this.state = result.state;
      return result;
    } finally {
      await saveLocalObjects(this.local);
      await saveSyncState(this.state);
    }
  }
}
