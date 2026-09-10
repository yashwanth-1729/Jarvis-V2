/**
 * Client sync correctness, exercised without a network or a browser.
 *
 * Deliberately mirrors `backend/tests/sync_test.py` case for case. The two
 * implementations have to agree about identity, conflict resolution and
 * deletion, and the cheapest way to keep them honest is to hold them to the
 * same assertions. A divergence here is a data-corruption bug that would
 * otherwise surface days later on a device that had been offline.
 *
 *     npx tsx tests/sync.test.ts
 */

import "fake-indexeddb/auto";

import {
  SYNCED_TABLES,
  type SyncRow,
  type SyncedTable,
  type Tombstone,
  clearAll,
  deleteRow,
  getRow,
  listRows,
  mergeAgentRows,
  putRows,
} from "@/lib/localdb";
import {
  type Remote,
  type SyncResult,
  moved,
  nowIso,
  summarize,
  syncOnce,
} from "@/lib/syncClient";

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

/**
 * In-memory stand-in for the Supabase mirror.
 *
 * Reproduces the two behaviours the client actually depends on: upsert on
 * primary key, and a server-assigned `synced_at` that advances on every write.
 * The counter is zero-padded so lexicographic comparison orders it the way a
 * real timestamp cursor does.
 */
/** Fixed base for the fake server clock, so runs are reproducible. */
const FAKE_EPOCH = Date.UTC(2026, 0, 1);

let fakeRemoteSeq = 0;

class FakeRemote implements Remote {
  // Distinct per instance: two remotes sharing an id would share cursors
  // and bootstrap markers, which is exactly what the per-remote tests deny.
  readonly id = `fake-${(fakeRemoteSeq += 1)}`;
  rows: Record<string, Record<string, SyncRow>> = {};
  tombstones: Record<string, Tombstone & { synced_at: string }> = {};
  private clock = 0;

  constructor() {
    for (const table of SYNCED_TABLES) this.rows[table] = {};
  }

  private stamp(): string {
    // ISO rather than a bare counter: the pull cursor is rewound by a real time
    // delta before each fetch, and a counter would skip that path entirely and
    // leave the overlap window untested. The counter survives as a millisecond
    // offset purely to guarantee monotonicity.
    this.clock += 1;
    return new Date(FAKE_EPOCH + this.clock).toISOString();
  }

  /** Backdate a row's `synced_at`, as a slow transaction does.
   *
   *  Postgres stamps `now()` at transaction *start*, and transactions do not
   *  commit in start order, so a write that began earlier can become visible
   *  after one that began later. A cursor already past it would step over the
   *  row forever. */
  commitLate(table: string, uid: string, secondsEarlier: number): void {
    const row = this.rows[table][uid] as SyncRow & { synced_at: string };
    row.synced_at = new Date(Date.parse(row.synced_at) - secondsEarlier * 1000).toISOString();
  }

  private after<T extends { synced_at: string }>(
    items: T[],
    since: string | null,
  ): [T[], string | null] {
    const fresh = items
      .filter((r) => since === null || r.synced_at > since)
      .sort((a, b) => a.synced_at.localeCompare(b.synced_at));
    return [fresh, fresh.length ? fresh[fresh.length - 1].synced_at : since];
  }

  async fetchRows(table: string, since: string | null) {
    return this.after(Object.values(this.rows[table] ?? {}) as never[], since) as [
      SyncRow[],
      string | null,
    ];
  }

  async fetchTombstones(since: string | null) {
    return this.after(Object.values(this.tombstones), since) as [Tombstone[], string | null];
  }

  async pushRows(table: string, rows: SyncRow[]) {
    for (const row of rows) {
      const existing = this.rows[table][row.uid];
      // Mirrors the `keep_newer_write` trigger on the real mirror. Without it
      // the fake would be more permissive than production and the tests would
      // pass on a lie.
      if (existing && String(row.updated_at) <= String(existing.updated_at)) continue;
      this.rows[table][row.uid] = { ...row, synced_at: this.stamp() };
    }
  }

  async pushTombstones(rows: Tombstone[]) {
    for (const row of rows) {
      this.tombstones[`${row.table_name}:${row.uid}`] = { ...row, synced_at: this.stamp() };
    }
  }

  /** Write directly, bypassing the newer-wins guard, to stage states the real
   *  server would refuse — so the *client's* own guard is tested alone. */
  seed(table: string, row: SyncRow): void {
    this.rows[table][row.uid] = { ...row, synced_at: this.stamp() };
  }

  seedTombstone(table: string, uid: string, deletedAt: string): void {
    this.tombstones[`${table}:${uid}`] = {
      table_name: table,
      uid,
      deleted_at: deletedAt,
      synced_at: this.stamp(),
    };
  }
}

let uidCounter = 0;
function makeRow(extra: Record<string, unknown> = {}): SyncRow {
  uidCounter += 1;
  const stamp = nowIso();
  return {
    uid: `00000000-0000-4000-8000-${String(uidCounter).padStart(12, "0")}`,
    created_at: stamp,
    updated_at: stamp,
    ...extra,
  };
}

/** Wipe local state but keep the remote — stands in for a second device. */
async function becomeOtherDevice(): Promise<void> {
  await clearAll();
}

async function main(): Promise<number> {
  console.log("\n== local writes land and read back ==");
  const task = makeRow({ title: "Finish the sync client", priority: "HIGH", status: "PENDING" });
  const idea = makeRow({ title: "Publish SLDT", description: "after testing" });
  const event = makeRow({ event_name: "DSA revision", kind: "ROUTINE", day_of_week: 2 });
  const memory = makeRow({ key_concept: "preferred editor", content: "Neovim" });

  await putRows("tasks", [task]);
  await putRows("ideas", [idea]);
  await putRows("schedules", [event]);
  await putRows("memories", [memory]);

  check("task stored", (await listRows("tasks")).length === 1);
  check("uids are distinct", new Set([task.uid, idea.uid, event.uid, memory.uid]).size === 4);

  console.log("\n== push publishes local work ==");
  const remote = new FakeRemote();
  let result: SyncResult = await syncOnce(remote);
  check("push reported no error", result.error === null, String(result.error));
  check("task reached the remote", task.uid in remote.rows.tasks);
  check("schedule reached the remote", event.uid in remote.rows.schedules);
  check("memory reached the remote", memory.uid in remote.rows.memories);
  check("idea reached the remote", idea.uid in remote.rows.ideas);

  console.log("\n== another device pulls the same state ==");
  await becomeOtherDevice();
  check("second device starts empty", (await listRows("tasks")).length === 0);

  result = await syncOnce(remote);
  check("pull reported no error", result.error === null, String(result.error));
  const pulled = await listRows("tasks");
  check("task arrived", pulled.some((t) => t.uid === task.uid), JSON.stringify(pulled));
  check("title survived the round trip", pulled.some((t) => t.title === "Finish the sync client"));
  check("schedule arrived", (await listRows("schedules")).length === 1);
  check("memory arrived", (await listRows("memories")).length === 1);

  console.log("\n== syncing twice changes nothing ==");
  const before = (await listRows("tasks")).length;
  await syncOnce(remote);
  check("no duplicate rows", (await listRows("tasks")).length === before);

  console.log("\n== last write wins, and only when it really is later ==");
  const local = (await listRows("tasks"))[0];
  await putRows("tasks", [
    { ...local, title: "Edited locally, later", updated_at: "2098-01-01T00:00:00" },
  ]);
  remote.seed("tasks", {
    ...(remote.rows.tasks[task.uid] as SyncRow),
    title: "Stale remote edit",
    updated_at: "2020-01-01T00:00:00",
  });
  await syncOnce(remote);
  check(
    "older remote edit does not clobber a newer local one",
    (await getRow("tasks", task.uid))?.title === "Edited locally, later",
    String((await getRow("tasks", task.uid))?.title),
  );

  remote.seed("tasks", {
    ...(remote.rows.tasks[task.uid] as SyncRow),
    title: "Newer remote edit",
    updated_at: "2099-01-01T00:00:00",
  });
  await syncOnce(remote);
  check(
    "newer remote edit does land",
    (await getRow("tasks", task.uid))?.title === "Newer remote edit",
  );

  console.log("\n== deletes propagate instead of resurrecting ==");
  const doomed = makeRow({ title: "Delete me" });
  await putRows("tasks", [doomed]);
  await syncOnce(remote);
  check("doomed task published", doomed.uid in remote.rows.tasks);

  await deleteRow("tasks", doomed.uid, nowIso());
  check("delete removed it locally", (await getRow("tasks", doomed.uid)) === undefined);

  await syncOnce(remote);
  check("tombstone published", `tasks:${doomed.uid}` in remote.tombstones);

  await becomeOtherDevice();
  await syncOnce(remote);
  const surviving = new Set((await listRows("tasks")).map((t) => t.uid));
  check(
    "deleted task does not come back on the other device",
    !surviving.has(doomed.uid),
    `still present in ${[...surviving]}`,
  );
  check("the other tasks did survive", surviving.has(task.uid));

  console.log("\n== a row edited after its delete is kept ==");
  const revived = makeRow({ title: "Brought back" });
  await putRows("tasks", [revived]);
  remote.seedTombstone("tasks", revived.uid, "2020-01-01T00:00:00");
  await syncOnce(remote);
  check(
    "stale tombstone does not delete a newer row",
    (await getRow("tasks", revived.uid)) !== undefined,
  );

  console.log("\n== stale rows cannot resurrect a local deletion ==");
  const protectedRow = makeRow({ title: "Stay deleted", updated_at: "2028-01-01T00:00:00" });
  await putRows("tasks", [protectedRow]);
  await deleteRow("tasks", protectedRow.uid, "2028-01-02T00:00:00");
  remote.seed("tasks", {...protectedRow, updated_at: "2028-01-01T12:00:00"});
  await syncOnce(remote);
  check("an older pulled copy stays deleted", (await getRow("tasks", protectedRow.uid)) === undefined);

  const deliberateReturn = {...protectedRow, title: "Deliberately returned", updated_at: "2028-01-03T00:00:00"};
  await putRows("tasks", [deliberateReturn]);
  await syncOnce(remote);
  check("a later intentional edit can recreate it", (await getRow("tasks", protectedRow.uid))?.title === "Deliberately returned");

  console.log("\n== the disposable agent copy cannot overwrite newer phone data ==");
  const bridged = makeRow({ title: "Edited on phone", updated_at: "2032-01-02T00:00:00" });
  await putRows("tasks", [bridged]);
  const staleAgentCount = await mergeAgentRows("tasks", [
    { ...bridged, title: "Old agent snapshot", updated_at: "2032-01-01T00:00:00" },
  ]);
  check("older agent row is refused", staleAgentCount === 0);
  check("newer phone edit survives", (await getRow("tasks", bridged.uid))?.title === "Edited on phone");
  const freshAgentCount = await mergeAgentRows("tasks", [
    { ...bridged, title: "New agent edit", updated_at: "2032-01-03T00:00:00" },
  ]);
  check("newer agent row is accepted", freshAgentCount === 1);
  check("accepted agent edit is visible", (await getRow("tasks", bridged.uid))?.title === "New agent edit");

  console.log("\n== watermarks are per-remote ==");
  const other = new FakeRemote();
  const fresh = await syncOnce(other);
  check(
    "a different remote re-pushes in full rather than trusting a foreign cursor",
    (fresh.pushed.tasks ?? 0) > 0,
    JSON.stringify(fresh.pushed),
  );

  console.log("\n== a clock moving backwards still publishes ==");
  const backdated = makeRow({ title: "Written before the clock was corrected" });
  await putRows("tasks", [backdated]);
  await syncOnce(remote);
  // An ordinary NTP correction: the next edit carries an *earlier* stamp than
  // one already sent. A high-water-mark cursor would sort it below the mark and
  // never send it again. Whether the server then accepts it is a separate
  // question — what matters is that it was queued.
  await putRows("tasks", [
    { ...backdated, title: "Edited after the correction", updated_at: "2020-02-02T02:02:02" },
  ]);
  const afterSkew = await syncOnce(remote);
  check(
    "an edit stamped in the past is still queued and sent",
    (afterSkew.pushed.tasks ?? 0) > 0,
    "a timestamp watermark would have sorted it below the mark and skipped it",
  );

  console.log("\n== rows sharing one timestamp all publish ==");
  const twinA = makeRow({ title: "Same second, first", updated_at: "2027-03-03T03:03:03" });
  const twinB = makeRow({ title: "Same second, second", updated_at: "2027-03-03T03:03:03" });
  await putRows("tasks", [twinA, twinB]);
  await syncOnce(remote);
  check(
    "neither row is lost to a timestamp collision",
    twinA.uid in remote.rows.tasks && twinB.uid in remote.rows.tasks,
  );

  console.log("\n== a late-committing row is not stepped over ==");
  await becomeOtherDevice();
  await syncOnce(remote); // cursor advances to the newest synced_at
  remote.seed("tasks", {
    uid: "late-commit-0001",
    title: "Began early, committed late",
    created_at: "2026-05-05T05:05:05",
    updated_at: "2026-05-05T05:05:05",
  });
  // Stamped *behind* the cursor the last pull reached, exactly as a slow
  // Postgres transaction appears. Only the overlap window finds it.
  remote.commitLate("tasks", "late-commit-0001", 2);
  await syncOnce(remote);
  check(
    "a row stamped behind the cursor is still pulled",
    (await getRow("tasks", "late-commit-0001")) !== undefined,
    "the overlap window did not cover the commit-order gap",
  );

  console.log("\n== two devices editing one row converge ==");
  const contended = makeRow({ title: "Contended" });
  await putRows("tasks", [contended]);
  await syncOnce(remote);
  // The other device edits and publishes first, with the later stamp.
  remote.seed("tasks", {
    ...(remote.rows.tasks[contended.uid] as SyncRow),
    title: "Device B",
    updated_at: "2030-01-01T00:00:00",
  });
  // This device edits too, but its stamp is older.
  await putRows("tasks", [
    { ...contended, title: "Device A", updated_at: "2029-01-01T00:00:00" },
  ]);
  await syncOnce(remote);
  const settledLocal = (await getRow("tasks", contended.uid))?.title;
  const settledRemote = remote.rows.tasks[contended.uid].title;
  check(
    "both sides settle on the same version",
    settledLocal === "Device B" && settledRemote === "Device B",
    `local=${String(settledLocal)} remote=${String(settledRemote)}`,
  );

  console.log("\n== edits made offline publish on reconnect ==");
  const offline: Remote = {
    id: remote.id, // same remote, temporarily unreachable
    async fetchRows() {
      throw new Error("offline");
    },
    async pushRows() {
      throw new Error("offline");
    },
    async fetchTombstones() {
      throw new Error("offline");
    },
    async pushTombstones() {
      throw new Error("offline");
    },
  };
  const onTheTrain = makeRow({ title: "Written on a train" });
  await putRows("tasks", [onTheTrain]);
  const failedRound = await syncOnce(offline);
  check("an unreachable remote is reported, not thrown", failedRound.error !== null);
  await syncOnce(remote);
  check(
    "it publishes once the connection returns",
    onTheTrain.uid in remote.rows.tasks,
  );

  console.log("\n== sync stays out of the way when unconfigured ==");
  const idle = await syncOnce();
  check("skipped rather than threw", idle.skipped !== null, JSON.stringify(idle));
  check("reported no error", idle.error === null, String(idle.error));
  check("summary reads cleanly", summarize(idle).includes("Not synced"), summarize(idle));

  console.log("\n== reporting ==");
  check("moved() counts real movement", moved(fresh) > 0, String(moved(fresh)));

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
