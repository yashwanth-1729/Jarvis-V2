import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The backend stores naive local-time ISO strings. `new Date("2026-01-05T09:00:00")`
 * is parsed by every browser as *local* time (no trailing Z), which is exactly
 * what we want — but a value that already carries an offset must be left alone.
 */
export function parseLocal(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today 14:30", "Tomorrow 09:00", "Fri 12 Jun 17:00" */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseLocal(value);
  if (!date) return "No date";

  const dayDelta = Math.round((startOfDay(date) - startOfDay(new Date())) / DAY_MS);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (dayDelta === 0) return `Today ${time}`;
  if (dayDelta === 1) return `Tomorrow ${time}`;
  if (dayDelta === -1) return `Yesterday ${time}`;

  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} ${time}`;
}

export function formatTime(value: string | null | undefined): string {
  const date = parseLocal(value);
  if (!date) return "--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDayHeading(value: string | null | undefined): string {
  const date = parseLocal(value);
  if (!date) return "Undated";
  const dayDelta = Math.round((startOfDay(date) - startOfDay(new Date())) / DAY_MS);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** "in 2h", "3d overdue", "now" */
export function relativeLabel(value: string | null | undefined): string | null {
  const date = parseLocal(value);
  if (!date) return null;

  const diffMs = date.getTime() - Date.now();
  const overdue = diffMs < 0;
  const abs = Math.abs(diffMs);

  if (abs < 60_000) return "now";

  let label: string;
  if (abs < 3_600_000) label = `${Math.floor(abs / 60_000)}m`;
  else if (abs < DAY_MS) label = `${Math.floor(abs / 3_600_000)}h`;
  else label = `${Math.floor(abs / DAY_MS)}d`;

  return overdue ? `${label} overdue` : `in ${label}`;
}

export function isOverdue(value: string | null | undefined): boolean {
  const date = parseLocal(value);
  return date !== null && date.getTime() < Date.now();
}

export function splitTags(tags: string): string[] {
  return tags
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Group schedule events into day buckets, preserving chronological order. */
export function groupByDay<T extends { time_start: string }>(
  events: T[],
): { heading: string; key: string; items: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const event of events) {
    const key = event.time_start.slice(0, 10);
    const list = buckets.get(key);
    if (list) list.push(event);
    else buckets.set(key, [event]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      heading: formatDayHeading(items[0].time_start),
      items: [...items].sort((a, b) => (parseLocal(a.time_start)?.getTime() ?? Infinity) - (parseLocal(b.time_start)?.getTime() ?? Infinity)),
    }));
}
