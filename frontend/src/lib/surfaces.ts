/**
 * Which instrument panel the interface should become.
 *
 * The idea: JARVIS should not always show the same dashboard. What is on screen
 * follows what is being asked. The mechanism is deliberately small — no
 * intent-classification layer, no second channel — because the decision has
 * already been made by the time the answer exists. The model reached for a
 * tool; the tool says what its result looks like.
 *
 *     "what's the weather"      -> get_weather        -> surface "weather"
 *     "what do I have tomorrow" -> get_dashboard(...) -> surface "schedule"
 *     "what are my tasks"       -> get_dashboard(...) -> surface "tasks"
 *
 * Every tool result already carried a `display` payload that the UI captured
 * and never rendered. This gives that payload a grammar rather than inventing a
 * parallel path: `surface` names the panel, the rest is that panel's data.
 *
 * The same descriptor arrives over both transports — SSE for typed turns, the
 * websocket for spoken ones — so asking out loud reshapes the screen exactly as
 * typing does. That matters more than the typed case: this is a voice-first
 * assistant, and panels that only appeared for people who type would be
 * backwards.
 */

export type SurfaceKind =
  | "weather"
  | "schedule"
  | "tasks"
  | "memory"
  | "search"
  | "confirm";

export const SURFACE_KINDS: SurfaceKind[] = [
  "weather",
  "schedule",
  "tasks",
  "memory",
  "search",
  "confirm",
];

/** A tool result's `display` payload, once we know it names a surface. */
export interface SurfaceDescriptor {
  kind: SurfaceKind;
  /** The tool that produced it, for the panel's provenance line. */
  tool: string;
  /** Everything else the tool sent. Panel-specific. */
  data: Record<string, unknown>;
  /** Rises on every new descriptor, so repeats of the same panel re-animate. */
  seq: number;
}

function isSurfaceKind(value: unknown): value is SurfaceKind {
  return typeof value === "string" && (SURFACE_KINDS as string[]).includes(value);
}

let counter = 0;

/**
 * Read a surface out of a tool result, or null if it does not name one.
 *
 * Most tools do not. Adding a task should not hijack the screen — the board is
 * already visible and the row simply appears. Only tools that answer a question
 * with something worth *looking* at claim a surface.
 */
export function readSurface(
  toolName: string,
  display: unknown,
): SurfaceDescriptor | null {
  if (!display || typeof display !== "object") return null;
  const payload = display as Record<string, unknown>;
  if (!isSurfaceKind(payload.surface)) return null;

  counter += 1;
  return {
    kind: payload.surface,
    tool: toolName,
    data: payload,
    seq: counter,
  };
}

/**
 * A surface named by intent rather than by a tool result.
 *
 * The backend reads the user's own words before the model runs, so the panel
 * opens while JARVIS is still thinking. Carries no data — the panel reads live
 * dashboard state, which is what makes it interactive rather than a snapshot.
 */
/**
 * Kinds that may be opened from intent, before any tool has run.
 *
 * Tasks, schedule and memory draw from dashboard state the page already holds,
 * so they open complete. Weather has no local store and opens empty, which is
 * fine *provided the panel says so* — `WeatherSurface` renders a fetching
 * state rather than running `Math.round` over `undefined`, which is what put
 * `NaN` in every field.
 *
 * `confirm` is deliberately absent and must stay absent. It is a safety
 * surface: it exists to show exactly which records a tool is about to delete,
 * and a version of it conjured from keywords — with no list, no count, and no
 * tool behind it — would be a deletion warning about nothing. It opens only on
 * a real tool result.
 *
 * `search` is absent for a plainer reason: there is nothing to show and no
 * shape to promise until results exist.
 */
const INTENT_READY: SurfaceKind[] = ["tasks", "schedule", "memory", "weather"];

export function intentSurface(
  kind: string,
  data: Record<string, unknown> = {},
): SurfaceDescriptor | null {
  if (!isSurfaceKind(kind)) return null;
  if (!INTENT_READY.includes(kind)) return null;
  counter += 1;
  return { kind, tool: "intent", data, seq: counter };
}

/** Weather icon vocabulary, kept small so a panel picks between drawings. */
export type WeatherIcon =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "showers"
  | "snow"
  | "thunder";

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface WeatherData {
  location: string;
  place: string;
  temperature: number;
  feels_like: number;
  humidity: number;
  wind_speed: number;
  wind_direction: number;
  precipitation: number;
  pressure: number;
  condition: string;
  icon: WeatherIcon;
  is_day: boolean;
  units: { temperature: string; wind: string };
  sunrise: string | null;
  sunset: string | null;
  forecast: {
    date: string;
    high: number;
    low: number;
    rain_chance: number;
    condition: string;
    icon: WeatherIcon;
  }[];
}

/** Human label for a surface, used in the panel chrome. */
export const SURFACE_TITLE: Record<SurfaceKind, string> = {
  weather: "Conditions",
  search: "Research",
  schedule: "Schedule",
  tasks: "Task board",
  memory: "Memory",
  confirm: "Confirm deletion",
};


/**
 * A deletion, shown before it happens and again while it happens.
 *
 * This kind exists because of a real loss, and it is worth stating plainly.
 * Asked to delete three tasks named "File the tax return", the model called
 * `bulk_delete_tasks` with `scope="open"`. The tool refused and said, in
 * words, that this would delete all 19 open tasks. The model then told the
 * user "3 tasks named 'File the tax return' will be deleted", got a yes, and
 * nineteen went.
 *
 * The consent was real. The number it was given was not. A count that reaches
 * a person through a sentence the model composes is a channel the model can
 * get wrong — and did. The tool now makes the model quote the count back
 * before it will act, which closes it in code; this panel closes it visually,
 * by rendering the tool's own number and the tool's own list. A mis-composed
 * sentence cannot argue with nineteen rows on a screen.
 */
export interface ConfirmPayload {
  surface: "confirm";
  stage: "pending" | "done" | "cancelled";
  action: "delete";
  record_type: "task" | "event" | "idea" | "memory";
  /** The tool's own count. Authoritative, and may exceed `items.length`. */
  count: number;
  items: Array<{
    id: number | null;
    title: string;
    subtitle?: string | null;
    meta?: string | null;
  }>;
  scope?: string | null;
  matching?: string | null;
  /** Ids actually deleted. Present once `stage` is "done". */
  removed?: number[];
  remaining?: number | null;
}

export function readConfirm(data: Record<string, unknown>): ConfirmPayload {
  const items = Array.isArray(data.items) ? data.items : [];
  const removed = Array.isArray(data.removed) ? data.removed : [];
  const stage = data.stage === "done" || data.stage === "cancelled" ? data.stage : "pending";

  return {
    surface: "confirm",
    stage,
    action: "delete",
    record_type: (typeof data.record_type === "string"
      ? data.record_type
      : "task") as ConfirmPayload["record_type"],
    count: typeof data.count === "number" ? data.count : items.length,
    items: items.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof row.id === "number" ? row.id : null,
        title: String(row.title ?? "Untitled"),
        subtitle: row.subtitle == null ? null : String(row.subtitle),
        meta: row.meta == null ? null : String(row.meta),
      };
    }),
    scope: data.scope == null ? null : String(data.scope),
    matching: data.matching == null ? null : String(data.matching),
    removed: removed.filter((value): value is number => typeof value === "number"),
    remaining: typeof data.remaining === "number" ? data.remaining : null,
  };
}
