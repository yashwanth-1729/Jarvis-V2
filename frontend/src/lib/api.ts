import type {
  Brief,
  ChatStreamEvent,
  DashboardState,
  HistoryMessage,
  TaskStatus,
  ToggleTaskResponse,
} from "@/types";

/** Backend port. Must match JARVIS_PORT in `backend/.env`. */
const BACKEND_PORT = process.env.NEXT_PUBLIC_API_PORT ?? "8000";

/** Where a user-chosen backend address is remembered. */
export const API_BASE_STORAGE_KEY = "jarvis.apiBase";

/**
 * Where the backend lives, resolved in this order:
 *
 * 1. A value the user saved at runtime (`localStorage`).
 * 2. `NEXT_PUBLIC_API_BASE`, if set — an explicit build-time override.
 * 3. Otherwise, the *page's own hostname* on the backend port.
 *
 * Deriving it from the page is what makes the browser app work unchanged on
 * `localhost` and from a phone on the LAN. A hardcoded LAN IP cannot: these
 * values are inlined at build time, so a DHCP address change silently freezes
 * a dead address into the bundle and every request fails with "cannot reach
 * the backend" until someone rebuilds.
 *
 * The runtime override exists for the packaged apps. Inside Capacitor the page
 * is served from `localhost`, so rule 3 would look for a backend *on the
 * phone*, where there is none — and rule 2 would bake in an address that dies
 * at the next DHCP lease. Only a value the user can change without a rebuild
 * survives both.
 */
/**
 * True inside a Tauri desktop or Android shell.
 *
 * Matters because hostname derivation is meaningless there: Tauri v2 serves the
 * bundled app from `tauri.localhost`, so rule 3 below would resolve the backend
 * to `http://tauri.localhost:8000` — a host that does not exist. The runtime on
 * the device listens on loopback, so that is the only sane default.
 */
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return (
    "__TAURI_INTERNALS__" in w ||
    "__TAURI__" in w ||
    window.location.hostname.endsWith("tauri.localhost")
  );
}

function resolveApiBase(): string {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(API_BASE_STORAGE_KEY)?.trim();
      if (saved) return saved.replace(/\/$/, "");
    } catch {
      // Private mode or a locked-down webview: fall through to the defaults.
    }
  }

  const configured = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (configured) return configured.replace(/\/$/, "");

  // Packaged app: the runtime is on this device, on loopback. Never derived
  // from the page's host, which is a Tauri-internal name.
  if (isNativeShell()) return `http://127.0.0.1:${BACKEND_PORT}`;

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
  }
  // Server-render pass; no request is actually issued from here.
  return `http://127.0.0.1:${BACKEND_PORT}`;
}

/**
 * Point the app at a different backend and reload.
 *
 * Reloading rather than mutating `API_BASE` is deliberate: the constant is read
 * at module load by callers all over the app, so a live edit would leave half
 * of them talking to the old address.
 */
export function setApiBase(base: string): void {
  const cleaned = base.trim().replace(/\/$/, "");
  if (cleaned) {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, cleaned);
  } else {
    window.localStorage.removeItem(API_BASE_STORAGE_KEY);
  }
  window.location.reload();
}

export const API_BASE = resolveApiBase();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      `Cannot reach the JARVIS backend at ${API_BASE}. Is it running?`,
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(await describeFailure(response), response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* Thin verbs over `request`, so callers editing records do not each rebuild the
 * same fetch options and forget one. Exported for `lib/records.ts`. */

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export async function apiDelete(path: string): Promise<void> {
  await request<void>(path, { method: "DELETE" });
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (detail) return JSON.stringify(detail);
  } catch {
    /* not JSON — fall through */
  }
  return `${response.status} ${response.statusText}`;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether this runtime expects the *client* to own the user's data.
 *
 * True on mobile, where IndexedDB is authoritative and the backend is only the
 * AI runtime; false on the desktop, where the backend owns SQLite and syncs it
 * itself. Asked rather than inferred from the platform, so the answer stays
 * correct whichever build points at whichever runtime.
 *
 * Returns false when unreachable — the safe default, since a client with no
 * runtime falls back to its local store anyway.
 */
export async function fetchClientOwnsData(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const health = (await response.json()) as {
      details?: { client_owned_data?: boolean };
    };
    return health.details?.client_owned_data === true;
  } catch {
    return false;
  }
}

export function fetchDashboard(): Promise<DashboardState> {
  return request<DashboardState>("/api/dashboard");
}

export function regenerateBrief(): Promise<Brief> {
  return request<Brief>("/api/briefs/generate", { method: "POST" });
}

export function toggleTask(
  taskId: number,
  status?: TaskStatus,
): Promise<ToggleTaskResponse> {
  return request<ToggleTaskResponse>("/api/tasks/toggle", {
    method: "POST",
    body: JSON.stringify({ task_id: taskId, status: status ?? null }),
  });
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

export function fetchChatHistory(limit = 100): Promise<HistoryMessage[]> {
  return request<HistoryMessage[]>(`/api/chat/history?limit=${limit}`);
}

export function clearChatHistory(): Promise<void> {
  return request<void>("/api/chat/history", { method: "DELETE" });
}

/**
 * POST a message and yield agent events as they arrive.
 *
 * `EventSource` cannot issue a POST, so this reads the SSE frames off the
 * response body directly. Frames are separated by a blank line; a partial frame
 * at the end of a chunk stays in the buffer until the rest arrives.
 */
export async function* streamChat(
  message: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!response.ok) {
    throw new ApiError(await describeFailure(response), response.status);
  }
  if (!response.body) {
    throw new ApiError("The server returned an empty stream.", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  // A local WebView has no proxy timeout to rescue a stalled vendor request.
  // Bound each silent read so a lost connection cannot leave the composer in
  // "Working…" forever. The backend has its own whole-turn ceiling as well.
  const readWithDeadline = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ApiError("JARVIS stopped receiving data from Sarvam. Please retry.", 504)),
            80_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    while (true) {
      const { done, value } = await readWithDeadline();
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }

    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    // Releasing the lock lets an aborted/timed-out fetch tear the connection
    // down cleanly instead of leaving a provider request detached in Python.
    reader.releaseLock();
  }
}

function parseFrame(raw: string): ChatStreamEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let event = "message";
  const dataLines: string[] = [];

  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (!dataLines.length) return null;

  try {
    return {
      type: event,
      data: JSON.parse(dataLines.join("\n")),
    } as unknown as ChatStreamEvent;
  } catch {
    return null;
  }
}
