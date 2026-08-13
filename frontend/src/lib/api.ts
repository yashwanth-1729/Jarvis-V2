import type {
  Brief,
  ChatStreamEvent,
  DashboardState,
  HistoryMessage,
  TaskStatus,
  ToggleTaskResponse,
} from "@/types";

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000"
).replace(/\/$/, "");

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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
    // Releasing the lock lets an aborted fetch tear the connection down cleanly.
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
