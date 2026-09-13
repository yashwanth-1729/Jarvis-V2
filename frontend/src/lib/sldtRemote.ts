/**
 * A `Remote` (see `syncClient.ts`) backed by SLDT instead of Supabase.
 *
 * Not wired into anything yet -- no existing file imports this one, so the
 * shipping app's behavior is unchanged by its presence. This exists to prove
 * out the actual integration point: `syncClient.ts`'s `push()`/`pull()`
 * functions already only ever touch a `Remote` through this exact interface
 * (`fetchRows`/`pushRows`/`fetchTombstones`/`pushTombstones`), so an SLDT
 * account can become a working alternative to a Supabase project by
 * constructing this class and passing it to `syncOnce(remote)` /
 * `startAutoSync` wherever the app decides to offer that choice -- a UI
 * decision (a settings toggle, a build-time flag) deliberately left for
 * whoever wires this in, not made here.
 *
 * The shape mismatch this adapter bridges: `syncClient.ts`'s `push()` calls
 * `pushRows`/`pushTombstones` once per table, expecting each call to be an
 * independent, cheap network round trip (true for Supabase's REST API).
 * SLDT's actual unit of network work is one atomic manifest cycle covering
 * every pending local change at once. So writes here are buffered into the
 * in-memory `SldtClient` (no network), and the *first* subsequent read
 * (`fetchRows`/`fetchTombstones`, called only after every push call has
 * already happened -- see `syncOnce`'s push-then-pull order) triggers the one
 * real `client.sync()` cycle, whose result every other read call that round
 * reuses.
 */

import { SYNCED_TABLES, type SyncRow, type Tombstone } from "@/lib/localdb";
import type { Remote } from "@/lib/syncClient";
import {
  SldtClient,
  type Identity,
  type LocalObject,
  type Store,
  type SyncResult as SldtSyncResult,
} from "../../../jarvis-oss/sldt/src/index.js";

/** `objects/<table>:<uid>.enc` on the wire -- namespaces every JARVIS row type in the same SLDT dataset without colliding across tables. */
function objectId(table: string, uid: string): string {
  return `${table}:${uid}`;
}

function parseObjectId(id: string): { table: string; uid: string } | null {
  const separator = id.indexOf(":");
  if (separator < 0) return null;
  return { table: id.slice(0, separator), uid: id.slice(separator + 1) };
}

/** Tombstones need a `deleted_at` the base protocol doesn't carry on its own `deleted` flag -- kept here, in the payload, purely for this adapter's own bookkeeping. */
interface TombstonePayload {
  deletedAt: string;
}

/** Zero-padded so lexicographic string comparison (what `syncClient.ts` uses for cursors) agrees with numeric order -- "10" must sort after "9", not before it. */
function revisionCursor(revision: number): string {
  return String(revision).padStart(12, "0");
}

export class SldtRemote implements Remote {
  readonly id: string;
  private readonly client: SldtClient;
  private syncPromise: Promise<SldtSyncResult> | null = null;

  private constructor(client: SldtClient, datasetId: string) {
    this.client = client;
    this.id = `sldt:${datasetId}`;
  }

  static async create(identity: Identity, store: Store, deviceId?: string): Promise<SldtRemote> {
    const client = await SldtClient.create({ identity, store, deviceId });
    return new SldtRemote(client, identity.datasetId);
  }

  // -------------------------------------------------------------------
  // Push phase: buffer only. syncClient.ts's push() calls these once per
  // table, then once for tombstones, all before any fetch* call happens.
  // -------------------------------------------------------------------

  async pushRows(table: string, rows: SyncRow[]): Promise<void> {
    this.invalidateCachedCycle();
    for (const row of rows) {
      this.client.upsert(objectId(table, row.uid), table, row);
    }
  }

  async pushTombstones(rows: Tombstone[]): Promise<void> {
    this.invalidateCachedCycle();
    for (const tomb of rows) {
      const payload: TombstonePayload = { deletedAt: tomb.deleted_at };
      this.client.delete(objectId(tomb.table_name, tomb.uid), payload);
    }
  }

  /**
   * A new push phase means new buffered edits that any previously cached
   * sync result doesn't reflect. `syncOnce`'s push-then-pull order means
   * this always runs before the round's first `fetchRows` call, so it's
   * safe to drop the cache unconditionally here rather than track dirtiness.
   */
  private invalidateCachedCycle(): void {
    this.syncPromise = null;
  }

  // -------------------------------------------------------------------
  // Pull phase: the first fetch* call of a round runs the one real sync
  // cycle; every subsequent call this round reuses its result.
  // -------------------------------------------------------------------

  private ensureSynced(): Promise<SldtSyncResult> {
    if (!this.syncPromise) {
      this.syncPromise = this.client.sync();
    }
    return this.syncPromise;
  }

  async fetchRows(table: string, _since: string | null): Promise<[SyncRow[], string | null]> {
    const result = await this.ensureSynced();
    const rows: SyncRow[] = [];
    for (const objId of result.pulled) {
      const parsed = parseObjectId(objId);
      if (!parsed || parsed.table !== table) continue;
      const record = this.client.get(objId);
      if (record && !record.deleted) rows.push(record.payload as SyncRow);
    }
    return [rows, revisionCursor(result.state.lastSyncedManifestRevision)];
  }

  async fetchTombstones(_since: string | null): Promise<[Tombstone[], string | null]> {
    const result = await this.ensureSynced();
    const tombstones: Tombstone[] = [];
    for (const objId of result.pulled) {
      const parsed = parseObjectId(objId);
      if (!parsed || !SYNCED_TABLES.includes(parsed.table as (typeof SYNCED_TABLES)[number])) continue;
      const record = this.client.get(objId);
      if (record?.deleted) {
        tombstones.push({
          table_name: parsed.table,
          uid: parsed.uid,
          deleted_at: (record.payload as TombstonePayload | null)?.deletedAt ?? new Date().toISOString(),
        });
      }
    }
    // `pull()` in syncClient.ts always calls fetchTombstones last, after every
    // table's fetchRows -- see its own comment ("Tombstones apply *after*
    // rows"). That makes this the reliable end-of-round marker: invalidating
    // here, not just inside pushRows/pushTombstones, is what makes a
    // pull-only round (nothing locally pending, so push* is never called at
    // all) still run a fresh sync cycle instead of replaying a stale cached
    // one forever. A round that pushed something already invalidated on the
    // way in; this covers the round that pushed nothing.
    this.invalidateCachedCycle();
    return [tombstones, revisionCursor(result.state.lastSyncedManifestRevision)];
  }
}

/** Type-only re-export so a caller building a store doesn't need its own import path into jarvis-oss/sldt. */
export type { LocalObject };
