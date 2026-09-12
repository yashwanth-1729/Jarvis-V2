/**
 * IndexedDB persistence, exercised without a browser via fake-indexeddb --
 * same technique `frontend/tests/sync.test.ts` uses for `localdb.ts`.
 *
 *     npx tsx tests/browserStore.test.ts
 */

import "fake-indexeddb/auto";

import {
  clearAllForTests,
  loadDatasetId,
  loadDeviceId,
  loadLocalObjects,
  loadSyncState,
  saveDatasetId,
  saveDeviceId,
  saveLocalObject,
  saveLocalObjects,
  saveSyncState,
} from "../src/browserStore.js";
import type { LocalObject } from "../src/sync.js";
import { check, summarize } from "./_harness.js";

function makeObject(objectId: string, revision: number): LocalObject {
  return {
    objectId,
    revision,
    deviceId: "device-a",
    type: "task",
    deleted: false,
    payload: { title: `task ${objectId}` },
    pending: true,
    storeVersion: null,
    knownHash: null,
  };
}

async function main() {
  await clearAllForTests();

  check("no sync state before anything is saved", (await loadSyncState()) === null);
  check("no datasetId before anything is saved", (await loadDatasetId()) === null);

  const obj1 = makeObject("task-1", 1);
  await saveLocalObject(obj1);
  const loaded = await loadLocalObjects();
  check("a saved object round-trips", loaded.get("task-1")?.objectId === "task-1");
  check("payload round-trips through IndexedDB", (loaded.get("task-1")?.payload as { title: string }).title === "task task-1");

  const obj1Updated = { ...obj1, revision: 2, payload: { title: "edited" } };
  const obj2 = makeObject("task-2", 1);
  const batch = new Map([
    ["task-1", obj1Updated],
    ["task-2", obj2],
  ]);
  await saveLocalObjects(batch);
  const afterBatch = await loadLocalObjects();
  check("batch save updates an existing record", afterBatch.get("task-1")?.revision === 2);
  check("batch save adds a new record", afterBatch.has("task-2"));
  check("batch save does not duplicate entries", afterBatch.size === 2);

  await saveSyncState({ lastSyncedManifestRevision: 7 });
  check("sync state round-trips", (await loadSyncState())?.lastSyncedManifestRevision === 7);

  await saveDatasetId("dataset-abc");
  await saveDeviceId("device-a");
  check("datasetId round-trips", (await loadDatasetId()) === "dataset-abc");
  check("deviceId round-trips", (await loadDeviceId()) === "device-a");

  await clearAllForTests();
  const afterClear = await loadLocalObjects();
  check("clearAllForTests wipes objects", afterClear.size === 0);
  check("clearAllForTests wipes meta", (await loadSyncState()) === null);

  summarize("browserStore.test.ts");
}

main();
