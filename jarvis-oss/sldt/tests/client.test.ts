/**
 * `SldtClient` composition: identity + persistence + sync engine, exercised
 * as an app would actually call it -- two "devices" each with their own
 * IndexedDB (faked) sharing one `InMemoryStore`, and a restart scenario
 * that proves persistence, not just the in-memory engine, is doing its job.
 *
 *     npx tsx tests/client.test.ts
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { resetConnectionForTests } from "../src/browserStore.js";
import { SldtClient, generateDeviceId } from "../src/client.js";
import { formatRecoveryCode, generateDatasetId, generateSecret, parseRecoveryCode, type Identity } from "../src/identity.js";
import { InMemoryStore } from "../src/store.js";
import { check, summarize } from "./_harness.js";

/**
 * Each simulated "device" needs its own IndexedDB, but `fake-indexeddb/auto`
 * installs one shared global. Swapping in a fresh `IDBFactory` per device
 * before constructing its client is what actually isolates them --
 * otherwise "device B" would silently read device A's persisted rows.
 */
function freshIndexedDb(): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetConnectionForTests();
}

async function main() {
  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  const store = new InMemoryStore();

  // --- recovery code really is reconstructible identity ---
  const code = formatRecoveryCode(identity);
  const reparsed = parseRecoveryCode(code);
  check("recovery code reconstructs the exact identity used to build it", reparsed.datasetId === identity.datasetId && reparsed.secret === identity.secret);

  // --- device A creates a client, makes an edit, syncs ---
  freshIndexedDb();
  const deviceAId = generateDeviceId();
  const clientA = await SldtClient.create({ identity, store, deviceId: deviceAId });
  clientA.upsert("task-1", "task", { title: "buy milk" });
  const firstSync = await clientA.sync();
  check("first client publishes its pending edit", firstSync.pushed.includes("task-1"));
  check("upserted object is readable back from the client", (clientA.get("task-1")?.payload as { title: string }).title === "buy milk");

  // --- device B, fresh IndexedDB, pulls it ---
  freshIndexedDb();
  const clientB = await SldtClient.create({ identity, store });
  check("a fresh device gets its own generated deviceId", clientB.getDeviceId() !== deviceAId);
  const bSync = await clientB.sync();
  check("second device pulls the first device's object", bSync.pulled.includes("task-1"));
  check("listByType surfaces the pulled record", clientB.listByType("task").some((r) => r.objectId === "task-1"));

  // --- restart: a NEW client instance on device A's own IndexedDB must resume, not start over ---
  // (freshIndexedDb() above already swapped globalThis.indexedDB to device B's;
  // swap back is unnecessary since we only need to prove *some* client, given
  // a persisted store, resumes rather than re-publishing everything.)
  const clientBAgain = await SldtClient.create({ identity, store, deviceId: clientB.getDeviceId() });
  check(
    "a new client instance on the same (persisted) IndexedDB resumes state rather than starting empty",
    clientBAgain.get("task-1")?.payload !== undefined,
  );
  const resyncResult = await clientBAgain.sync();
  check("resuming a client with nothing new to push/pull is a no-op sync", resyncResult.pushed.length === 0 && resyncResult.pulled.length === 0);

  // --- delete propagates through the façade too ---
  clientA.delete("task-1");
  await clientA.sync();
  await clientBAgain.sync();
  check("a delete through the façade tombstones the object on the peer", clientBAgain.get("task-1")?.deleted === true);
  check("listByType excludes deleted records", !clientBAgain.listByType("task").some((r) => r.objectId === "task-1"));

  summarize("client.test.ts");
}

main();
