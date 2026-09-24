import { parseLocal } from "@/lib/utils";

const DAY_MS = 86_400_000;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Monday-first weekday index, matching the backend's `day_of_week`. */
export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days from today to `date` (0 today, 1 tomorrow, -1 yesterday). */
export function dayDelta(date: Date, now = new Date()): number {
  return Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
}

/** "6:30 PM" */
export function clock(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Today, 6:30 PM" · "Tomorrow, 9:00 AM" · "Fri 12 Jun, 5:00 PM" */
export function when(value: string | null | undefined, now = new Date()): string {
  const date = parseLocal(value);
  if (!date) return "No date";
  const delta = dayDelta(date, now);
  const time = clock(date);
  if (delta === 0) return `Today, ${time}`;
  if (delta === 1) return `Tomorrow, ${time}`;
  if (delta === -1) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${time}`;
}

/** "in 25m" · "in 3h" · "2d late" · "now" */
export function relative(value: string | null | undefined, now = Date.now()): string | null {
  const date = parseLocal(value);
  if (!date) return null;
  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "now";
  const label = abs < 3_600_000 ? `${Math.floor(abs / 60_000)}m` : abs < DAY_MS ? `${Math.floor(abs / 3_600_000)}h` : `${Math.floor(abs / DAY_MS)}d`;
  return diff < 0 ? `${label} late` : `in ${label}`;
}

/** Minutes, for "23 min left" style copy. */
export function minutesUntil(target: number, now = Date.now()): number {
  return Math.max(0, Math.round((target - now) / 60_000));
}

/** "1h 20m" · "45m" */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function greeting(date: Date): { hello: string; word: string } {
  const hour = date.getHours();
  if (hour < 5) return { hello: "Up late,", word: "legend" };
  if (hour < 12) return { hello: "Good", word: "morning" };
  if (hour < 17) return { hello: "Good", word: "afternoon" };
  if (hour < 22) return { hello: "Good", word: "evening" };
  return { hello: "Winding", word: "down?" };
}

/** Local naive ISO for a date-time input (`YYYY-MM-DDTHH:MM:00`). */
export function isoLocal(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

/** Quick picks for due dates and reminders. */
export function quickTimes(now = new Date()): Array<{ label: string; value: string }> {
  const at = (days: number, hour: number, minute = 0) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
    return isoLocal(date);
  };
  const inAnHour = new Date(now.getTime() + 60 * 60_000);
  inAnHour.setMinutes(inAnHour.getMinutes() < 30 ? 30 : 60, 0, 0);
  const picks = [{ label: "In 1 hour", value: isoLocal(inAnHour) }];
  if (now.getHours() < 18) picks.push({ label: "Tonight", value: at(0, 19) });
  picks.push({ label: "Tomorrow", value: at(1, 9) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  picks.push({ label: "Next week", value: at(toMonday, 9) });
  return picks;
}
