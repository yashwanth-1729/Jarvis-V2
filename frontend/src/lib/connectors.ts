/**
 * Connectors on the client: the Google connector and user-added MCP servers.
 *
 * Kept deliberately apart from the record sync (`syncClient.ts`): those tables
 * are mirrored into the agent's database by `agentBridge.ts` and rendered by
 * the dashboard, and a connector is neither. The data set is a handful of
 * rows, so it gets its own tiny sync -- read the whole remote table, keep the
 * newer copy of each row by `updated_at`, publish what this device has newer
 * -- with a `deleted` flag in place of tombstones.
 *
 * Secrets travel sealed (`connectorCrypto.ts`); only this device can open
 * them. The runtime receives definitions plus opened secrets on each connect
 * (`/api/connectors/configure`) and keeps them in memory only, the same rule
 * as the provider keys in `sendProviderKey`.
 */

import { API_BASE } from "@/lib/api";
import { WrongPassphrase, open, seal } from "@/lib/connectorCrypto";
import { getSupabaseConfig } from "@/lib/syncClient";

const STORE_KEY = "jarvis.connectors.v1";
const REMOTE_TABLE = "connectors";

export type ConnectorKind = "google" | "mcp";
export type GoogleService = "gmail" | "calendar" | "drive";

export interface GoogleConfig {
  client_id: string;
  services: GoogleService[];
  email?: string;
}
export interface GoogleSecret {
  client_secret: string;
  refresh_token?: string;
}

export interface McpConfig {
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  disabled_tools: string[];
}
export interface McpSecret {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ConnectorRow {
  uid: string;
  kind: ConnectorKind;
  name: string;
  /** JSON of GoogleConfig | McpConfig -- nothing secret. */
  config: string;
  /** Sealed GoogleSecret | McpSecret, or null. */
  secret: string | null;
  deleted: boolean;
  updated_at: string;
}

// ------------------------------------------------------------------ local store
export function listConnectors(includeDeleted = false): ConnectorRow[] {
  if (typeof window === "undefined") return [];
  try {
    const rows = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "[]") as ConnectorRow[];
    return includeDeleted ? rows : rows.filter((row) => !row.deleted);
  } catch {
    return [];
  }
}

function writeAll(rows: ConnectorRow[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(rows));
  } catch {
    // Quota or private mode: connectors will not persist on this device.
  }
}

export function upsertConnector(row: Omit<ConnectorRow, "updated_at" | "deleted"> & { deleted?: boolean }): ConnectorRow {
  const saved: ConnectorRow = { deleted: false, ...row, updated_at: new Date().toISOString() };
  const rows = listConnectors(true).filter((r) => r.uid !== saved.uid);
  writeAll([...rows, saved]);
  return saved;
}

export function removeConnector(uid: string): void {
  const rows = listConnectors(true).map((r) =>
    r.uid === uid
      ? { ...r, deleted: true, secret: null, config: "{}", updated_at: new Date().toISOString() }
      : r,
  );
  writeAll(rows);
}

export function newUid(): string {
  return crypto.randomUUID();
}

export function parseConfig<T>(row: ConnectorRow): T {
  try {
    return JSON.parse(row.config) as T;
  } catch {
    return {} as T;
  }
}

export async function openSecret<T>(row: ConnectorRow): Promise<T | null> {
  if (!row.secret) return null;
  return open<T>(row.secret);
}

export { seal };

// ------------------------------------------------------------------------- sync
export interface ConnectorSyncResult {
  pulled: number;
  pushed: number;
  error?: string;
  skipped?: string;
}

/**
 * One round against Supabase. Never throws. A missing `connectors` table is
 * reported, not fatal: connectors still work on this device without sync.
 */
export async function syncConnectors(): Promise<ConnectorSyncResult> {
  const config = getSupabaseConfig();
  if (!config) return { pulled: 0, pushed: 0, skipped: "Supabase not configured" };
  const base = `${config.url}/rest/v1/${REMOTE_TABLE}`;
  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
  try {
    const response = await fetch(`${base}?select=uid,kind,name,config,secret,deleted,updated_at`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160);
      return { pulled: 0, pushed: 0, error: `${response.status} ${detail}` };
    }
    const remote = (await response.json()) as ConnectorRow[];
    const local = new Map(listConnectors(true).map((row) => [row.uid, row]));
    const remoteByUid = new Map(remote.map((row) => [row.uid, row]));
    let pulled = 0;
    for (const row of remote) {
      const mine = local.get(row.uid);
      if (!mine || row.updated_at > mine.updated_at) {
        local.set(row.uid, { ...row, deleted: Boolean(row.deleted) });
        pulled += 1;
      }
    }
    const outgoing = [...local.values()].filter((row) => {
      const theirs = remoteByUid.get(row.uid);
      return !theirs || row.updated_at > theirs.updated_at;
    });
    if (outgoing.length) {
      const push = await fetch(base, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(outgoing),
        signal: AbortSignal.timeout(15_000),
      });
      if (!push.ok) {
        writeAll([...local.values()]);
        return { pulled, pushed: 0, error: `${push.status} ${(await push.text()).slice(0, 160)}` };
      }
    }
    writeAll([...local.values()]);
    return { pulled, pushed: outgoing.length };
  } catch (error) {
    return { pulled: 0, pushed: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------- runtime hand-off
export interface ConnectorStatus {
  google: { connected: boolean; email?: string; services?: string[]; error?: string };
  mcp: Array<{
    id: string;
    name: string;
    connected: boolean;
    error: string;
    tools: Array<{ name: string; description: string; read_only: boolean; enabled: boolean }>;
  }>;
  tool_count: number;
}

export interface HandOffResult {
  status: ConnectorStatus | null;
  /** Names of connectors whose secret this device could not open. */
  locked: string[];
}

/** Open every secret this device can and give the runtime the live set. */
export async function configureRuntime(): Promise<HandOffResult> {
  const locked: string[] = [];
  let google: Record<string, unknown> | null = null;
  const mcp: Record<string, unknown>[] = [];
  for (const row of listConnectors()) {
    let secret: Record<string, unknown> | null = null;
    try {
      secret = await openSecret<Record<string, unknown>>(row);
    } catch (error) {
      if (error instanceof WrongPassphrase) {
        locked.push(row.name);
        continue;
      }
      throw error;
    }
    if (row.kind === "google") {
      const cfg = parseConfig<GoogleConfig>(row);
      const s = (secret ?? {}) as Partial<GoogleSecret>;
      if (s.refresh_token) {
        google = {
          client_id: cfg.client_id, client_secret: s.client_secret ?? "",
          refresh_token: s.refresh_token, services: cfg.services, email: cfg.email ?? "",
        };
      }
    } else {
      const cfg = parseConfig<McpConfig>(row);
      const s = (secret ?? {}) as McpSecret;
      mcp.push({
        id: row.uid, name: row.name, transport: cfg.transport, url: cfg.url ?? "",
        command: cfg.command ?? "", args: cfg.args ?? [], enabled: cfg.enabled,
        disabled_tools: cfg.disabled_tools ?? [], headers: s.headers ?? {}, env: s.env ?? {},
      });
    }
  }
  try {
    const response = await fetch(`${API_BASE}/api/connectors/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ google, mcp }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: response.ok ? ((await response.json()) as ConnectorStatus) : null, locked };
  } catch {
    return { status: null, locked };
  }
}

/** Sync, then hand the runtime the result. Safe to call on every connect. */
export async function refreshConnectors(): Promise<HandOffResult & { sync: ConnectorSyncResult }> {
  const sync = await syncConnectors();
  const handOff = await configureRuntime();
  return { ...handOff, sync };
}

// --------------------------------------------------------------- google sign-in
export async function startGoogleSignIn(
  clientId: string, clientSecret: string, services: GoogleService[],
): Promise<{ state: string; auth_url: string }> {
  const response = await fetch(`${API_BASE}/api/connectors/google/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, services }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `Sign-in could not start (${response.status}).`);
  }
  return response.json();
}

export interface GoogleSignInOutcome {
  refresh_token: string;
  email: string;
  services: GoogleService[];
}

/** Poll until the browser round-trip finishes (or `signal` aborts). */
export async function waitForGoogleSignIn(state: string, signal: AbortSignal): Promise<GoogleSignInOutcome> {
  while (!signal.aborted) {
    const response = await fetch(
      `${API_BASE}/api/connectors/google/result?state=${encodeURIComponent(state)}`, { signal },
    );
    const body = (await response.json()) as
      | { status: "pending" }
      | { status: "error"; error: string }
      | ({ status: "done" } & GoogleSignInOutcome);
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(body.error);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Sign-in cancelled.");
}

export async function testMcpServer(server: Record<string, unknown>): Promise<{
  ok: boolean; error?: string; tools: Array<{ name: string; description: string; read_only: boolean }>;
}> {
  try {
    const response = await fetch(`${API_BASE}/api/connectors/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return { ok: false, error: `The runtime answered ${response.status}.`, tools: [] };
    return response.json();
  } catch {
    return { ok: false, error: "Could not reach the JARVIS runtime.", tools: [] };
  }
}
