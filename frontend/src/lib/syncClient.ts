/**
 * Client-side sync against the Supabase mirror.
 *
 * A port of `backend/app/services/sync.py`, deliberately preserving its
 * semantics rather than reinventing them — that engine is already proven
 * against 32 tests including a live round trip, and two implementations that
 * disagree about conflict resolution would corrupt data in ways that only show
 * up days later.
 *
 * The invariants both sides share:
 *
 *   identity     `uid`, never the local integer id (device-local, collides)
 *   conflicts    last-write-wins on `updated_at` (client clock)
 *   pull cursor  `synced_at` (server clock — immune to device clock skew)
 *   deletes      published as tombstones, or the next pull resurrects them
 *   watermarks   namespaced per remote, so switching backends re-pulls in full
 *
 * What differs is only the storage underneath: SQLite there, IndexedDB here.
 */

import {
  SYNCED_TABLES,
  type SyncRow,
  type SyncedTable,
  type Tombstone,
  applyRemoteTombstone,
  getMeta,
  isAvailable,
  clearPending,
  listRows,
  listPending,
  listTombstones,
  mergeRows,
  project,
  setMeta,
} from "@/lib/localdb";

/** Supabase caps a REST response at 1000 rows; page rather than truncate. */
const PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------
//
// Held in localStorage and entered once at first run, rather than inlined at
// build time. Two reasons: the credentials never end up inside the shipped APK,
// and pointing the app at a different project (or later, a VPS) is a settings
// change instead of a rebuild.

const URL_KEY = "jarvis.supabaseUrl";
const KEY_KEY = "jarvis.supabaseKey";

export interface SupabaseConfig {
  url: string;
  key: string;
}

export function getSupabaseConfig(): SupabaseConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const url = window.localStorage.getItem(URL_KEY)?.trim();
    const key = window.localStorage.getItem(KEY_KEY)?.trim();
    return url && key ? { url: url.replace(/\/$/, ""), key } : null;
  } catch {
    return null;
  }
}

export function setSupabaseConfig(config: SupabaseConfig | null): void {
  if (!config) {
    window.localStorage.removeItem(URL_KEY);
    window.localStorage.removeItem(KEY_KEY);
    return;
  }
  window.localStorage.setItem(URL_KEY, config.url.trim().replace(/\/$/, ""));
  window.localStorage.setItem(KEY_KEY, config.key.trim());
}

/**
 * Local wall-clock time as `YYYY-MM-DDTHH:MM:SS`.
 *
 * Matches `backend/app/core/timeutil.py` exactly. Not `toISOString()`, which
 * returns UTC with a `Z` — that would sort against the backend's local-time
 * strings incorrectly and quietly corrupt every last-write-wins decision.
 */
export function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Stable short id for a remote, used to namespace watermarks.
 *
 *  A cursor is a token in one remote's clock and means nothing anywhere else;
 *  reusing it after switching backends would silently skip every row written
 *  before it. FNV-1a is plenty here — this needs to be stable, not secure. */
function remoteId(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

export interface Remote {
  id: string;
  fetchRows(table: string, since: string | null): Promise<[SyncRow[], string | null]>;
  pushRows(table: string, rows: SyncRow[]): Promise<void>;
  fetchTombstones(since: string | null): Promise<[Tombstone[], string | null]>;
  pushTombstones(rows: Tombstone[]): Promise<void>;
}

/** PostgREST over `fetch`, mirroring `SupabaseAdapter` on the backend. */
export class SupabaseRemote implements Remote {
  readonly id: string;
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(config: SupabaseConfig) {
    this.base = `${config.url}/rest/v1`;
    this.id = remoteId(this.base);
    this.headers = {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    };
  }

  private async fetchPaged<T>(table: string, since: string | null): Promise<[T[], string | null]> {
    const rows: T[] = [];
    let cursor = since;
    for (;;) {
      const params = new URLSearchParams({
        select: "*",
        order: "synced_at.asc",
        limit: String(PAGE_SIZE),
      });
      if (cursor) params.set("synced_at", `gt.${cursor}`);

      const response = await fetch(`${this.base}/${table}?${params}`, { headers: this.headers });
      if (!response.ok) {
        throw new Error(`${response.status} GET ${table}: ${(await response.text()).slice(0, 200)}`);
      }
      const page = (await response.json()) as Array<T & { synced_at: string }>;
      if (!page.length) break;
      rows.push(...page);
      cursor = page[page.length - 1].synced_at;
      // A short page means the table is exhausted. Breaking only on an empty
      // page would spin forever if the server ignored the filter.
      if (page.length < PAGE_SIZE) break;
    }
    return [rows, cursor];
  }

  private async upsert(table: string, rows: unknown[]): Promise<void> {
    if (!rows.length) return;
    for (let start = 0; start < rows.length; start += PAGE_SIZE) {
      const response = await fetch(`${this.base}/${table}`, {
        method: "POST",
        headers: { ...this.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(start, start + PAGE_SIZE)),
      });
      if (!response.ok) {
        throw new Error(
          `${response.status} POST ${table}: ${(await response.text()).slice(0, 200)}`,
        );
      }
    }
  }

  fetchRows(table: string, since: string | null) {
    return this.fetchPaged<SyncRow>(table, since);
  }

  fetchTombstones(since: string | null) {
    return this.fetchPaged<Tombstone>("sync_tombstones", since);
  }

  pushRows(table: string, rows: SyncRow[]) {
    // Projected to a fixed column set first. PostgREST rejects a bulk insert
    // whose objects have differing keys (PGRST102, "All object keys must
    // match"), and rows written by different code paths over months do differ.
    // It only bites when one array contains both shapes — which a
    // first-contact push, sending every row at once, guarantees.
    return this.upsert(
      table,
      rows.map((row) => project(table as SyncedTable, row)),
    );
  }

  /**
   * Delete rows upstream by uid, one table at a time.
   *
   * PostgREST takes `uid=in.(a,b,c)`; values are quoted because a uid may
   * legally contain a comma and an unquoted list would split on it.
   */
  private async remove(table: string, uids: string[]): Promise<void> {
    if (!uids.length) return;
    for (let start = 0; start < uids.length; start += PAGE_SIZE) {
      const batch = uids.slice(start, start + PAGE_SIZE);
      const list = batch.map((uid) => `"${uid.replace(/"/g, '""')}"`).join(",");
      const response = await fetch(`${this.base}/${table}?uid=in.(${list})`, {
        method: "DELETE",
        headers: { ...this.headers, Prefer: "return=minimal" },
      });
      if (!response.ok) {
        throw new Error(
          `${response.status} DELETE ${table}: ${(await response.text()).slice(0, 200)}`,
        );
      }
    }
  }

  async pushTombstones(rows: Tombstone[]) {
    // Recording the tombstone was never enough, and this is the bug that made
    // deleted tasks come back every time the app restarted.
    //
    // A tombstone published to `sync_tombstones` tells other devices to delete
    // their copy. It does nothing to the row itself, which sat in Supabase's
    // `tasks` table untouched — so the very next pull fetched it again and
    // merged it straight back into the local store. Measured on the device:
    // the board went to 3 tasks after a deletion and back to 38 seven seconds
    // later, then 42. The delete was working perfectly and being undone by the
    // sync that was supposed to publish it.
    //
    // So the row is deleted upstream as well. The tombstone still matters --
    // it is what tells a peer that already holds the row to drop it, and what
    // stops a peer's stale copy from re-creating it -- but it is now a
    // notification of a deletion rather than the whole of one.
    await this.upsert("sync_tombstones", rows);

    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row.uid);
      byTable.set(row.table_name, list);
    }
    for (const [table, uids] of byTable) {
      await this.remove(table, uids);
    }
  }
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

export interface SyncResult {
  pushed: Record<string, number>;
  pulled: Record<string, number>;
  deletedLocally: number;
  skipped: string | null;
  error: string | null;
  at: string;
}

function emptyResult(): SyncResult {
  return { pushed: {}, pulled: {}, deletedLocally: 0, skipped: null, error: null, at: nowIso() };
}

export function moved(result: SyncResult): number {
  const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return total(result.pushed) + total(result.pulled);
}

export function summarize(result: SyncResult): string {
  if (result.skipped) return `Not synced — ${result.skipped}`;
  if (result.error) return `Sync failed — ${result.error}`;
  if (!moved(result) && !result.deletedLocally) return "Already up to date";
  const parts: string[] = [];
  const describe = (label: string, counts: Record<string, number>) => {
    const entries = Object.entries(counts).filter(([, n]) => n > 0);
    if (entries.length) parts.push(`${label} ${entries.map(([t, n]) => `${n} ${t}`).join(", ")}`);
  };
  describe("pushed", result.pushed);
  describe("pulled", result.pulled);
  if (result.deletedLocally) parts.push(`removed ${result.deletedLocally} deleted elsewhere`);
  return parts.join("; ");
}

const stateKey = (remote: Remote, direction: string, name: string) =>
  `${direction}:${remote.id}:${name}`;

/**
 * How far back a pull re-reads before its stored cursor.
 *
 * `synced_at` is Postgres `now()`, which is *transaction start* time — and
 * transactions do not commit in start order. A write that began at
 * 10:00:00.000 but committed slowly lands after one that began at
 * 10:00:00.050 and committed instantly. A cursor advanced to the later stamp
 * would step straight over the earlier row and never see it again.
 *
 * Re-reading a few seconds of already-seen rows closes that window, and costs
 * nothing: the merge is idempotent, so re-examined rows are no-ops.
 */
export const PULL_OVERLAP_SECONDS = 5;

/** Cursors that are safe to do date arithmetic on.
 *
 *  Checked by shape rather than by `Date.parse` returning a number, because
 *  `Date.parse` is far too permissive: it reads `"000000000012"` as a *year*
 *  rather than rejecting it, so a non-timestamp cursor would silently become a
 *  1970 date and filter out every row. */
const ISO_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function rewind(cursor: string | null): string | null {
  if (!cursor || !ISO_CURSOR.test(cursor)) return cursor ?? null;
  const moment = Date.parse(cursor);
  if (Number.isNaN(moment)) return cursor;
  return new Date(moment - PULL_OVERLAP_SECONDS * 1000).toISOString();
}

async function push(remote: Remote, result: SyncResult): Promise<void> {
  // The pending set records what this *device* has not published, which is not
  // the same as what a *given remote* has never seen. Pointing the app at a
  // fresh backend — a VPS replacing Supabase, a new project — would otherwise
  // leave it permanently empty: every row was already published, just to
  // somewhere else. First contact therefore publishes everything once.
  const bootKey = stateKey(remote, "bootstrapped", "all");
  const firstContact = (await getMeta(bootKey)) === null;

  for (const table of SYNCED_TABLES) {
    const rows = firstContact ? await listRows(table) : await listPending(table);
    result.pushed[table] = rows.length;
    if (!rows.length) continue;

    await remote.pushRows(table, rows);
    // Marks are cleared only for rows that still look exactly as they did when
    // read; anything edited mid-flight stays queued for the next round.
    await clearPending(
      table,
      rows.map((row) => ({ uid: row.uid, updated_at: String(row.updated_at) })),
    );
  }

  // Recorded only after every table published cleanly, so a round that failed
  // part-way retries the full bootstrap rather than assuming it finished.
  if (firstContact) await setMeta(bootKey, nowIso());

  const tombKey = stateKey(remote, "push", "tombstones");
  const tombstones = await listTombstones(await getMeta(tombKey));
  if (tombstones.length) {
    await remote.pushTombstones(tombstones);
    await setMeta(tombKey, tombstones[tombstones.length - 1].deleted_at);
  }
}

async function pull(remote: Remote, result: SyncResult): Promise<void> {
  for (const table of SYNCED_TABLES) {
    const key = stateKey(remote, "pull", table);
    const stored = await getMeta(key);
    const [rows, cursor] = await remote.fetchRows(table, rewind(stored));
    result.pulled[table] = await mergeRows(table, rows);
    // Never let the stored cursor move backwards: the rewind widens the read,
    // it does not roll the cursor back.
    if (cursor && (stored === null || String(cursor) > String(stored))) {
      await setMeta(key, cursor);
    }
  }

  // Tombstones apply *after* rows, so a row edited and then deleted elsewhere
  // ends up deleted rather than resurrected by its own update.
  const tombKey = stateKey(remote, "pull", "tombstones");
  const storedTomb = await getMeta(tombKey);
  const [tombs, cursor] = await remote.fetchTombstones(rewind(storedTomb));
  for (const tomb of tombs) {
    if (await applyRemoteTombstone(tomb)) result.deletedLocally += 1;
  }
  if (cursor && (storedTomb === null || String(cursor) > String(storedTomb))) {
    await setMeta(tombKey, cursor);
  }
}

/**
 * Run one push + pull round. Never throws.
 *
 * Sync is a convenience layered over a local store that already works. An
 * unreachable Supabase — offline, throttled, misconfigured — must leave the app
 * fully usable rather than surfacing an error the user cannot act on.
 */
export async function syncOnce(remote?: Remote): Promise<SyncResult> {
  const result = emptyResult();

  if (!isAvailable()) {
    result.skipped = "local storage unavailable";
    return result;
  }
  if (!remote) {
    const config = getSupabaseConfig();
    if (!config) {
      result.skipped = "Supabase not configured";
      return result;
    }
    remote = new SupabaseRemote(config);
  }

  try {
    // Push first: publish what this device knows before accepting remote
    // state, so a fresh local edit is not overwritten by a stale remote copy.
    await push(remote, result);
    await pull(remote, result);
    await setMeta("lastSyncAt", result.at);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** When the last successful sync finished, or null if it never has. */
export async function lastSyncAt(): Promise<string | null> {
  if (!isAvailable()) return null;
  try {
    return await getMeta("lastSyncAt");
  } catch {
    return null;
  }
}

/** "3 hours ago" / "just now" — for the non-blocking launch banner. */
export function describeAge(iso: string | null): string {
  if (!iso) return "never synced";
  const then = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return "never synced";

  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
