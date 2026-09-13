/**
 * `SldtRemote` (src/lib/sldtRemote.ts) exercised through the real client
 * path: `syncClient.ts`'s `syncOnce(remote)` against real `localdb.ts` rows,
 * with an SLDT `InMemoryStore` standing in for the network and a raw SLDT
 * peer (the bare `sync.ts` primitives, no IndexedDB) standing in for a
 * second device -- proving the adapter really is a drop-in `Remote`, not
 * just something that type-checks.
 *
 *     npx tsx tests/sldtRemote.test.ts
 */

import "fake-indexeddb/auto";

import { clearAll, deleteRow, getRow, listRows, putRows } from "@/lib/localdb";
import { syncOnce, type SyncResult } from "@/lib/syncClient";
import { SldtRemote } from "@/lib/sldtRemote";
import {
  deriveKeys,
  generateDatasetId,
  generateSecret,
  importAesKey,
  initialSyncState,
  InMemoryStore,
  remove as sldtRemove,
  syncOnce as sldtSyncOnce,
  upsert as sldtUpsert,
  type Identity,
  type LocalObjectSet,
  type Store,
  type SyncState,
} from "../../jarvis-oss/sldt/src/index.js";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
}

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return `00000000-0000-4000-8000-${String(uidCounter).padStart(12, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A second device, using SLDT's bare primitives directly -- no IndexedDB, no façade, just the same protocol the adapter itself is built on. */
class RawPeer {
  local: LocalObjectSet = new Map();
  state: SyncState = initialSyncState();
  constructor(
    private readonly store: Store,
    private readonly encryptionKey: CryptoKey,
    private readonly authKey: Uint8Array,
    private readonly deviceId: string,
  ) {}

  upsert(table: string, row: { uid: string }): void {
    sldtUpsert(this.local, this.deviceId, `${table}:${row.uid}`, table, row);
  }

  delete(table: string, uidValue: string, deletedAt: string): void {
    sldtRemove(this.local, this.deviceId, `${table}:${uidValue}`, { deletedAt });
  }

  async sync(): Promise<SyncResult2> {
    const result = await sldtSyncOnce({
      store: this.store,
      encryptionKey: this.encryptionKey,
      authKey: this.authKey,
      deviceId: this.deviceId,
      local: this.local,
      state: this.state,
    });
    this.state = result.state;
    return result;
  }
}
type SyncResult2 = Awaited<ReturnType<typeof sldtSyncOnce>>;

async function main() {
  await clearAll();

  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  const store: Store = new InMemoryStore();
  const keys = await deriveKeys(identity);
  const encryptionKey = await importAesKey(keys.encryptionKey);

  const remote = await SldtRemote.create(identity, store, "device-frontend");
  const peer = new RawPeer(store, encryptionKey, keys.authKey, "device-peer");

  // --- this device's local edit reaches the SLDT store ---
  const task = { uid: uid(), title: "Finish SLDT wiring", priority: "HIGH", status: "PENDING", created_at: nowIso(), updated_at: nowIso() };
  await putRows("tasks", [task]);

  let result: SyncResult = await syncOnce(remote);
  check("push through SldtRemote reports no error", result.error === null, String(result.error));
  check("task was reported pushed", (result.pushed.tasks ?? 0) === 1);

  const peerSync1 = await peer.sync();
  check("a raw SLDT peer can decrypt what the adapter published", peerSync1.pulled.includes(`tasks:${task.uid}`));
  check(
    "the decrypted payload matches the original row",
    (peer.local.get(`tasks:${task.uid}`)?.payload as { title: string }).title === "Finish SLDT wiring",
  );

  // --- a raw peer's edit arrives in localdb through the same adapter ---
  const peerTask = { uid: uid(), title: "From the peer device", priority: "LOW", status: "PENDING", created_at: nowIso(), updated_at: nowIso() };
  peer.upsert("tasks", peerTask);
  await peer.sync();

  result = await syncOnce(remote);
  check("pull through SldtRemote reports no error", result.error === null, String(result.error));
  const localAfterPull = await getRow("tasks", peerTask.uid);
  check("the peer's task landed in this device's localdb", localAfterPull?.uid === peerTask.uid);
  check("its fields survived the round trip", localAfterPull?.title === "From the peer device");

  // --- delete, this device -> peer ---
  await deleteRow("tasks", task.uid, nowIso());
  result = await syncOnce(remote);
  check("delete push through SldtRemote reports no error", result.error === null, String(result.error));

  const peerSync2 = await peer.sync();
  check("the peer receives the tombstone", peer.local.get(`tasks:${task.uid}`)?.deleted === true);
  check("the tombstone pull is reported", peerSync2.pulled.includes(`tasks:${task.uid}`));

  // --- delete, peer -> this device ---
  peer.delete("tasks", peerTask.uid, nowIso());
  await peer.sync();
  result = await syncOnce(remote);
  check("tombstone pull through SldtRemote reports no error", result.error === null, String(result.error));
  const afterRemoteDelete = await getRow("tasks", peerTask.uid);
  check("a peer's delete removes the row from this device's localdb", afterRemoteDelete === undefined);

  const remaining = await listRows("tasks");
  check("only genuinely live rows remain locally", remaining.every((r) => r.uid !== task.uid && r.uid !== peerTask.uid));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
