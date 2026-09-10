/**
 * Local writes.
 *
 * Every change lands in IndexedDB first and is marked pending, then reaches
 * other devices whenever a sync next runs. Nothing here waits on the network,
 * so editing works identically with Supabase down, the backend down, or both.
 *
 * Semantics deliberately match `backend/app/db/crud.py`, because the same
 * record can be edited from either side and the two must not disagree about
 * what an edit means. In particular: completing a task *removes* it, because
 * the board holds outstanding work only.
 */

import { numericId } from "@/lib/localDashboard";
import {
  type SyncRow,
  type SyncedTable,
  deleteRow,
  listRows,
  putRows,
} from "@/lib/localdb";
import { nowIso } from "@/lib/syncClient";
import type { TaskStatus } from "@/types";

/**
 * Find a row by the numeric id the UI carries.
 *
 * The UI's types use `id: number` because the desktop backend assigns one, but
 * synced rows are keyed on `uid`. `numericId` is a pure function of the uid, so
 * this reverses it by scanning — fine over a table of tens of rows, and it
 * avoids maintaining a second index that could drift.
 */
async function findByNumericId(
  table: SyncedTable,
  id: number,
): Promise<SyncRow | undefined> {
  const rows = await listRows(table);
  return rows.find((row) => numericId(row.uid) === id);
}

/**
 * A record's identity, as the UI happens to be holding it.
 *
 * A string is a `uid` and is looked up directly. A number is the derived id,
 * which now equals `numericId(uid)` on both sides — the backend's working copy
 * assigns rowids from the same hash since a reseed used to renumber every row
 * and leave the screen addressing records that no longer had those numbers.
 * Both resolve to the same row; the uid just skips the scan.
 */
export type RecordRef = number | string;

async function findByRef(
  table: SyncedTable,
  ref: RecordRef,
): Promise<SyncRow | undefined> {
  if (typeof ref === "string") {
    const rows = await listRows(table);
    return rows.find((row) => row.uid === ref);
  }
  return findByNumericId(table, ref);
}

export interface LocalToggleResult {
  /** True when the task was removed rather than updated. */
  cleared: boolean;
  uid: string;
}

/**
 * Move a task to `next`, locally.
 *
 * Completing clears the task off the board and leaves a tombstone, mirroring
 * `update_task_status`. Without the tombstone the next pull would faithfully
 * restore a task the user just finished.
 */
export async function toggleTaskLocally(
  id: number,
  next: TaskStatus,
): Promise<LocalToggleResult | null> {
  const row = await findByNumericId("tasks", id);
  if (!row) return null;

  const stamp = nowIso();

  if (next === "COMPLETED") {
    await deleteRow("tasks", row.uid, stamp);
    return { cleared: true, uid: row.uid };
  }

  await putRows("tasks", [{ ...row, status: next, updated_at: stamp }]);
  return { cleared: false, uid: row.uid };
}

/** Edit arbitrary fields on a synced row, stamping and queueing it. */
export async function updateRowLocally(
  table: SyncedTable,
  ref: RecordRef,
  changes: Record<string, unknown>,
): Promise<SyncRow | null> {
  const row = await findByRef(table, ref);
  if (!row) return null;
  const updated: SyncRow = { ...row, ...changes, updated_at: nowIso() };
  await putRows(table, [updated]);
  return updated;
}

/** Delete a row and publish the deletion. */
export async function deleteRowLocally(
  table: SyncedTable,
  ref: RecordRef,
): Promise<boolean> {
  const row = await findByRef(table, ref);
  if (!row) return false;
  await deleteRow(table, row.uid, nowIso());
  return true;
}

/**
 * Apply a change the agent produced.
 *
 * On mobile the runtime has no database of its own, so a tool that modifies
 * user data returns the intended operation rather than performing it. This is
 * where that operation is actually applied — one funnel, so agent edits and
 * hand edits queue for sync by exactly the same path.
 */
export type AgentOperation =
  | { op: "upsert"; table: SyncedTable; row: SyncRow }
  | { op: "delete"; table: SyncedTable; uid: string };

export async function applyAgentOperation(operation: AgentOperation): Promise<void> {
  const stamp = nowIso();
  if (operation.op === "delete") {
    await deleteRow(operation.table, operation.uid, stamp);
    return;
  }
  await putRows(operation.table, [{ ...operation.row, updated_at: stamp }]);
}
