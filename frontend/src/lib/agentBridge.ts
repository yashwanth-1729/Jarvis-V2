/**
 * Keeps the agent's database in step with the client's.
 *
 * On the phone the user's data lives in IndexedDB, but the agent's tools read
 * and write the backend's SQLite and have no notion of that. Left alone the two
 * drift apart immediately: the assistant confirms it added a task, and the task
 * never appears on the board.
 *
 * So SQLite is treated as a *working copy* rather than a second source of
 * truth:
 *
 *   seed   before the agent runs, give it the user's actual rows so it can
 *          answer questions about them
 *   drain  after the agent runs, take back whatever it changed and apply it
 *          here, where it is queued for Supabase like any other local edit
 *
 * The important consequence is that agent edits and hand edits reach Supabase
 * by exactly the same path. Nothing about the sync engine has to know the agent
 * exists.
 *
 * Desktop does none of this: there SQLite *is* the user's data, the backend
 * syncs it upstream itself, and the endpoints refuse.
 */

import { API_BASE } from "@/lib/api";
import {
  SYNCED_TABLES,
  type SyncRow,
  type SyncedTable,
  applyRemoteTombstone,
  expireBlocks,
  expireMemories,
  listRows,
  mergeAgentRows,
} from "@/lib/localdb";
import { nowIso } from "@/lib/syncClient";

/** Where the provider key is remembered on this device. */
export const PROVIDER_KEY_STORAGE = "jarvis.providerKey";

interface DrainResponse {
  upserts: Partial<Record<SyncedTable, SyncRow[]>>;
  deletes: Array<{ table_name: string; uid: string; deleted_at: string }>;
}

/** Applied counts from one drain, for logging and tests. */
export interface AgentChanges {
  applied: number;
  removed: number;
}

async function post<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    // 409 is the backend saying it owns its own data — the desktop case, and
    // not an error worth surfacing.
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // The bridge is an optimisation over a store that already works. A backend
    // that is absent, slow or older than this client must not break editing.
    return null;
  }
}

/**
 * Hand the agent a working copy of the user's data.
 *
 * Called once the backend becomes reachable, and again after anything that
 * changes data outside the agent's view — otherwise it would answer from a
 * snapshot taken at launch.
 */
export async function seedAgentStore(): Promise<boolean> {
  return serializeBridge(async () => {
  await drainChanges();
  await expireBlocks();
  await expireMemories();
  const payload: Record<string, SyncRow[]> = {};
  for (const table of SYNCED_TABLES) {
    payload[table] = await listRows(table);
  }
  return (await post<{ seeded: unknown }>("/api/local/seed", payload)) !== null;
  });
}

/**
 * Take back whatever the agent changed and apply it locally.
 *
 * Accepted writes remain pending and reach Supabase on the next sync. The
 * working copy is disposable, so an older row is refused rather than replacing
 * a newer IndexedDB edit made by hand.
 */
export async function drainAgentStore(): Promise<AgentChanges> {
  return serializeBridge(drainChanges);
}

let bridgeQueue: Promise<unknown> = Promise.resolve();
function serializeBridge<T>(work: () => Promise<T>): Promise<T> {
  const next = bridgeQueue.then(work, work);
  bridgeQueue = next.catch(() => undefined);
  return next;
}

async function drainChanges(): Promise<AgentChanges> {
  const result: AgentChanges = { applied: 0, removed: 0 };
  const payload = await post<DrainResponse>("/api/local/drain");
  if (!payload) return result;

  for (const table of SYNCED_TABLES) {
    const rows = payload.upserts?.[table];
    if (rows?.length) {
      result.applied += await mergeAgentRows(table, rows);
    }
  }

  for (const tomb of payload.deletes ?? []) {
    if (!SYNCED_TABLES.includes(tomb.table_name as SyncedTable)) continue;
    await applyRemoteTombstone({...tomb, deleted_at: tomb.deleted_at || nowIso()});
    result.removed += 1;
  }

  return result;
}


export function getProviderKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PROVIDER_KEY_STORAGE)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Hand the local runtime its provider key.
 *
 * A packaged app ships no `.env`, so the backend starts with no credentials and
 * every call to the assistant fails until it is given one. The key is entered
 * once in settings and sent on each connect — the client is the only place it
 * is stored, and the runtime holds it in memory for the life of the process.
 *
 * Sending an empty key is meaningful: it clears whatever the runtime had, which
 * is what "remove my key" has to do.
 */
export async function sendProviderKey(): Promise<boolean> {
  const result = await post<{ configured: boolean }>("/api/local/credentials", {
    sarvam_api_key: getProviderKey(),
  });
  return result?.configured ?? false;
}
