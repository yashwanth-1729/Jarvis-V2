/**
 * Settings and session state for using SLDT instead of Supabase as this
 * device's sync backend. Mirrors `syncClient.ts`'s own Supabase config
 * pattern (localStorage, entered once, never baked into a build) for
 * everything that isn't the account secret.
 *
 * What's persisted in localStorage, and why each one is safe to:
 *   - which backend is selected, the dataset id (public -- it names the
 *     dataset, not the secret), the repo/branch/path prefix, and (for the
 *     "direct" write mode only) the GitHub PAT itself -- this is exactly
 *     the same trust level `syncClient.ts` already gives the Supabase
 *     service key on this same device, and its blast radius is much
 *     smaller than the SLDT secret below: a leaked PAT only grants write
 *     access to encrypted garbage, not a way to read any of it.
 *
 * What's deliberately NOT persisted:
 *   - the SLDT recovery code's secret half. This is what actually derives
 *     the encryption and auth keys for every record -- unlike the PAT, a
 *     leaked secret decrypts everything. Kept in memory only, cleared on
 *     reload; the user re-enters (or re-pastes) the full recovery code
 *     once per session. This is the deliberate security/usability
 *     tradeoff the SLDT design calls for, not an oversight -- see
 *     jarvis-oss/sldt/README.md's threat model notes.
 */

import {
  createDirectGitHubStore,
  createGitHubStore,
  formatRecoveryCode,
  generateDatasetId,
  generateSecret,
  parseRecoveryCode,
  type Identity,
  type Store,
} from "../../../jarvis-oss/sldt/src/index.js";
import { SldtRemote } from "@/lib/sldtRemote";
import type { Remote } from "@/lib/syncClient";

export type SyncBackend = "supabase" | "sldt";
export type SldtWriteMode = "direct" | "proxy";

const BACKEND_KEY = "jarvis.syncBackend";
const DATASET_ID_KEY = "jarvis.sldt.datasetId";
const REPO_KEY = "jarvis.sldt.repo";
const BRANCH_KEY = "jarvis.sldt.branch";
const PATH_PREFIX_KEY = "jarvis.sldt.pathPrefix";
const WRITE_MODE_KEY = "jarvis.sldt.writeMode";
const PROXY_URL_KEY = "jarvis.sldt.proxyUrl";
const DIRECT_TOKEN_KEY = "jarvis.sldt.directToken";

const DEFAULT_PATH_PREFIX = "sldt/";
const DEFAULT_BRANCH = "main";

export interface SldtSettings {
  datasetId: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  writeMode: SldtWriteMode;
  /** Required when writeMode is "proxy". */
  proxyUrl: string | null;
  /** Required when writeMode is "direct". Same trust level as the Supabase key -- see module doc. */
  directToken: string | null;
}

function available(): boolean {
  return typeof window !== "undefined";
}

function readItem(key: string): string | null {
  if (!available()) return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string | null): void {
  if (!available()) return;
  try {
    if (value === null || value === "") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Best-effort, matching setSupabaseConfig's own lack of a fallback --
    // a device without usable localStorage has bigger problems than this.
  }
}

export function getSyncBackend(): SyncBackend {
  return readItem(BACKEND_KEY) === "sldt" ? "sldt" : "supabase";
}

export function setSyncBackend(backend: SyncBackend): void {
  writeItem(BACKEND_KEY, backend === "sldt" ? "sldt" : null);
}

export function getSldtSettings(): SldtSettings | null {
  const datasetId = readItem(DATASET_ID_KEY);
  const repo = readItem(REPO_KEY);
  if (!datasetId || !repo) return null;
  const writeMode: SldtWriteMode = readItem(WRITE_MODE_KEY) === "direct" ? "direct" : "proxy";
  return {
    datasetId,
    repo,
    branch: readItem(BRANCH_KEY) ?? DEFAULT_BRANCH,
    pathPrefix: readItem(PATH_PREFIX_KEY) ?? DEFAULT_PATH_PREFIX,
    writeMode,
    proxyUrl: readItem(PROXY_URL_KEY),
    directToken: readItem(DIRECT_TOKEN_KEY),
  };
}

export function setSldtSettings(settings: SldtSettings): void {
  writeItem(DATASET_ID_KEY, settings.datasetId);
  writeItem(REPO_KEY, settings.repo);
  writeItem(BRANCH_KEY, settings.branch);
  writeItem(PATH_PREFIX_KEY, settings.pathPrefix);
  writeItem(WRITE_MODE_KEY, settings.writeMode);
  writeItem(PROXY_URL_KEY, settings.writeMode === "proxy" ? settings.proxyUrl : null);
  writeItem(DIRECT_TOKEN_KEY, settings.writeMode === "direct" ? settings.directToken : null);
}

export function clearSldtSettings(): void {
  writeItem(DATASET_ID_KEY, null);
  writeItem(REPO_KEY, null);
  writeItem(BRANCH_KEY, null);
  writeItem(PATH_PREFIX_KEY, null);
  writeItem(WRITE_MODE_KEY, null);
  writeItem(PROXY_URL_KEY, null);
  writeItem(DIRECT_TOKEN_KEY, null);
}

// ---------------------------------------------------------------------------
// The account secret -- kept for this session only, never in localStorage.
// See the module doc for why this one field is different from everything
// above it.
//
// "Session" here means `sessionStorage`, not a bare in-memory variable.
// The reason is this settings panel's own existing pattern: `save()`
// unconditionally reloads the page after writing settings (so every module
// that reads a config value once at load time picks up the change). A bare
// variable would be wiped by that very reload -- meaning the *first* thing
// that happens after generating a new identity or pairing with a recovery
// code is losing it again, before sync ever gets to run once. `sessionStorage`
// survives a same-tab reload but is cleared when the tab/window (a Tauri
// desktop build's whole app) actually closes -- "re-enter every time you
// relaunch the app" is what the design calls for, not "re-enter every time
// any setting changes."
// ---------------------------------------------------------------------------

const SESSION_SECRET_KEY = "jarvis.sldt.sessionSecret";

export function setSessionSecret(secret: string): void {
  if (!available()) return;
  try {
    window.sessionStorage.setItem(SESSION_SECRET_KEY, secret.trim());
  } catch {
    // Best-effort, matching this module's other storage calls.
  }
}

export function hasSessionSecret(): boolean {
  if (!available()) return false;
  try {
    return !!window.sessionStorage.getItem(SESSION_SECRET_KEY);
  } catch {
    return false;
  }
}

function readSessionSecret(): string | null {
  if (!available()) return null;
  try {
    return window.sessionStorage.getItem(SESSION_SECRET_KEY);
  } catch {
    return null;
  }
}

export function clearSessionSecret(): void {
  if (!available()) return;
  try {
    window.sessionStorage.removeItem(SESSION_SECRET_KEY);
  } catch {
    // Best-effort.
  }
}

/** Generates a brand-new dataset identity. Callers must show the resulting recovery code to the user immediately -- it is never recoverable otherwise. */
export function generateNewIdentity(): { identity: Identity; recoveryCode: string } {
  const identity: Identity = { datasetId: generateDatasetId(), secret: generateSecret() };
  return { identity, recoveryCode: formatRecoveryCode(identity) };
}

/** Parses a pasted recovery code, applying it as this session's secret and returning the dataset id to persist via `setSldtSettings`. */
export function applyRecoveryCode(code: string): { datasetId: string } {
  const identity = parseRecoveryCode(code);
  setSessionSecret(identity.secret);
  return { datasetId: identity.datasetId };
}

/**
 * Builds a `Remote` for the current settings, or null if SLDT isn't fully
 * configured yet (backend not selected, settings incomplete, or -- the
 * common "just reloaded the app" case -- the secret hasn't been re-entered
 * this session). Callers should treat null the same as "not configured":
 * skip sync, don't error.
 */
export function buildSldtRemote(): Remote | null {
  if (getSyncBackend() !== "sldt") return null;
  const settings = getSldtSettings();
  if (!settings) return null;
  if (!hasSessionSecret()) return null;
  if (settings.writeMode === "proxy" && !settings.proxyUrl) return null;
  if (settings.writeMode === "direct" && !settings.directToken) return null;

  const identity: Identity = { datasetId: settings.datasetId, secret: readSessionSecret()! };
  const store: Store =
    settings.writeMode === "direct"
      ? createDirectGitHubStore({
          repo: settings.repo,
          branch: settings.branch,
          pathPrefix: settings.pathPrefix,
          token: settings.directToken!,
        })
      : createGitHubStore({
          repo: settings.repo,
          branch: settings.branch,
          pathPrefix: settings.pathPrefix,
          proxyBaseUrl: settings.proxyUrl!,
        });

  // SldtRemote.create is async (it derives keys and loads persisted local
  // state), but callers of buildSldtRemote (useSync's effect) need a Remote
  // synchronously-ish alongside the existing Supabase path. Resolved by
  // handing back a lazy Remote that defers to the real one once ready --
  // every Remote method already returns a Promise, so this costs nothing
  // beyond one extra microtask on first use. The id is computed the same
  // way `SldtRemote` itself computes it (`sldt:<datasetId>`) so pull/push
  // cursors are namespaced per dataset from the very first call, not just
  // once the real remote resolves -- two different SLDT datasets must never
  // share a cursor namespace, or switching between them corrupts both.
  return lazyRemote(`sldt:${identity.datasetId}`, () => SldtRemote.create(identity, store));
}

function lazyRemote(id: string, create: () => Promise<SldtRemote>): Remote {
  let ready: Promise<SldtRemote> | null = null;
  const get = () => (ready ??= create());
  return {
    id,
    async fetchRows(table, since) {
      const remote = await get();
      return remote.fetchRows(table, since);
    },
    async pushRows(table, rows) {
      const remote = await get();
      return remote.pushRows(table, rows);
    },
    async fetchTombstones(since) {
      const remote = await get();
      return remote.fetchTombstones(since);
    },
    async pushTombstones(rows) {
      const remote = await get();
      return remote.pushTombstones(rows);
    },
  };
}
