/**
 * End-to-end sync engine, two simulated devices sharing one `InMemoryStore`.
 * Covers the scenarios the SLDT design calls out explicitly: first-publish,
 * cross-device pull, concurrent-edit tiebreaking, delete propagation,
 * wrong-key rejection, and corruption detection.
 *
 *     npx tsx tests/sync.test.ts
 */

import { resolveConflict } from "../src/conflict.js";
import { importAesKey } from "../src/crypto.js";
import { deriveKeys, generateDatasetId, generateSecret, type Identity } from "../src/identity.js";
import { InMemoryStore, type Store, type StoredObject } from "../src/store.js";
import {
  initialSyncState,
  remove,
  syncOnce,
  upsert,
  type LocalObjectSet,
  type SyncState,
} from "../src/sync.js";
import { check, summarize } from "./_harness.js";

interface Device {
  id: string;
  local: LocalObjectSet;
  state: SyncState;
  encryptionKey: CryptoKey;
  authKey: Uint8Array;
}

async function makeDevice(id: string, identity: Identity, store: InMemoryStore): Promise<Device & { store: InMemoryStore }> {
  const keys = await deriveKeys(identity);
  return {
    id,
    local: new Map(),
    state: initialSyncState(),
    encryptionKey: await importAesKey(keys.encryptionKey),
    authKey: keys.authKey,
    store,
  };
}

async function sync(device: Device & { store: InMemoryStore }) {
  const result = await syncOnce({
    store: device.store,
    encryptionKey: device.encryptionKey,
    authKey: device.authKey,
    deviceId: device.id,
    local: device.local,
    state: device.state,
  });
  device.state = result.state;
  return result;
}

async function main() {
  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  const store = new InMemoryStore();

  const a = await makeDevice("device-a", identity, store);
  const b = await makeDevice("device-b", identity, store);

  // --- first device publishes ---
  upsert(a.local, a.id, "task-1", "task", { title: "buy milk" });
  const firstSync = await sync(a);
  check("first device push publishes the object", firstSync.pushed.includes("task-1"));
  check("first device push starts the manifest at revision 1", a.state.lastSyncedManifestRevision === 1);

  // --- cross-device pull ---
  const bFirstSync = await sync(b);
  check("second device pulls the first device's object", bFirstSync.pulled.includes("task-1"));
  check("pulled object has the right payload", (b.local.get("task-1")?.payload as { title: string }).title === "buy milk");

  // --- concurrent edit, deterministic tiebreak ---
  upsert(a.local, a.id, "task-1", "task", { title: "buy milk (A's edit)" });
  upsert(b.local, b.id, "task-1", "task", { title: "buy milk (B's edit)" });

  await sync(a); // A pushes first, uncontested
  const bConflictSync = await sync(b); // B's edit at the same revision as A's -- must resolve deterministically

  const expectedWinner = resolveConflict(
    { revision: 2, deviceId: a.id },
    { revision: 2, deviceId: b.id },
  );
  const bFinal = b.local.get("task-1");
  check(
    "conflicting equal-revision edits resolve to the deterministic winner",
    expectedWinner.deviceId === b.id
      ? (bFinal?.payload as { title: string }).title === "buy milk (B's edit)"
      : (bFinal?.payload as { title: string }).title === "buy milk (A's edit)",
  );

  // Converge: A syncs again and must end up agreeing with B on the winner.
  await sync(b); // ensure B's resolution (if it won) is actually pushed
  await sync(a);
  const aFinal = a.local.get("task-1");
  check(
    "both devices converge to the same content after both have synced again",
    JSON.stringify(aFinal?.payload) === JSON.stringify(bFinal?.payload) && aFinal?.revision === bFinal?.revision,
  );

  // --- delete propagation ---
  remove(a.local, a.id, "task-1");
  await sync(a);
  await sync(b);
  check("a tombstone deletes the object on the peer device", b.local.get("task-1")?.deleted === true);
  check("the tombstone entry is retained, not erased, in local state", b.local.has("task-1"));

  // A device that comes back online after the delete must not resurrect it.
  const c = await makeDevice("device-c", identity, store);
  const cSync = await sync(c);
  check("a fresh device pulls the tombstone, not the deleted content", c.local.get("task-1")?.deleted === true);
  check("tombstone pull is reported like any other pull", cSync.pulled.includes("task-1"));

  // --- wrong key rejection ---
  const otherIdentity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  const wrongKeyDevice = await makeDevice("device-wrong-key", otherIdentity, store);
  let wrongKeyRejected = false;
  try {
    await sync(wrongKeyDevice);
  } catch (error) {
    wrongKeyRejected = (error as Error).name === "TamperDetected";
  }
  check("a device with the wrong keys is rejected, not silently desynced", wrongKeyRejected);

  // --- corruption detection ---
  upsert(a.local, a.id, "task-2", "task", { title: "call the bank" });
  await sync(a);
  await sync(b); // b now has task-2 locally, uncorrupted

  const stored = await store.get("objects/task-2.enc");
  if (stored) {
    const corrupted = stored.content.slice();
    corrupted[corrupted.length - 1] ^= 0xff; // flip a bit in the stored ciphertext
    // Overwrite directly at the storage layer, simulating bit rot/tampering
    // the client never caused -- bypass the client CAS path entirely.
    await (store as unknown as { objects: Map<string, { content: Uint8Array; version: string }> }).objects.set(
      "objects/task-2.enc",
      { content: corrupted, version: stored.version },
    );
  }

  const d = await makeDevice("device-d", identity, store);
  const dSync = await sync(d);
  check("a corrupted object is reported, not silently accepted", dSync.corrupted.includes("task-2"));
  check("a corrupted object does not end up in local state as valid data", !d.local.get("task-2")?.pending);

  // --- bootstrap race: a manifest read that stales-out as "doesn't exist yet" ---
  //
  // Caught live against the real GitHub API: the Contents API's read path can
  // lag its own write path, so a device's very first `store.get(manifest)`
  // can come back null even though another device already published --
  // indistinguishable, from this device's point of view, from a genuine
  // two-devices-bootstrap-at-once race. Either way `publishFirstManifest`'s
  // own manifest CAS write then loses to the manifest that's already there,
  // and that loss has to be a "retry the whole cycle" signal like any other
  // lost CAS race -- not an unhandled throw.
  const freshStore = new InMemoryStore();
  const e = await makeDevice("device-e", identity, freshStore);
  upsert(e.local, e.id, "task-3", "task", { title: "first device" });
  await sync(e); // establishes the manifest for real

  let staleReadServed = false;
  const staleOnceStore: Store = {
    async get(path: string): Promise<StoredObject | null> {
      if (path === "manifest.json" && !staleReadServed) {
        staleReadServed = true;
        return null; // exactly the false "not found" a lagging read would produce
      }
      return freshStore.get(path);
    },
    put: (path: string, content: Uint8Array, expectedVersion: string | null) =>
      freshStore.put(path, content, expectedVersion),
  };

  const f = await makeDevice("device-f", identity, freshStore);
  const fResult = await syncOnce({
    store: staleOnceStore,
    encryptionKey: f.encryptionKey,
    authKey: f.authKey,
    deviceId: f.id,
    local: f.local,
    state: f.state,
    retryBackoffMs: () => 0, // no reason for a unit test to wait on real backoff timing
  });
  check("a stale 'no manifest yet' read does not crash the sync cycle", fResult !== undefined);
  check("the device recovers and pulls the manifest that was actually there", fResult.pulled.includes("task-3"));
  check("the stale read was actually exercised by this test", staleReadServed);

  summarize("sync.test.ts");
}

main();
