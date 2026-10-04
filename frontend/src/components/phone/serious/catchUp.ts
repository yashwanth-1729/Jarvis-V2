/**
 * Catch-up, client side ("a plan that bends", 2026-10-04).
 *
 * - **Busy time:** the schedule lives on the device, so the backend's planner
 *   (services/replan.py) gets what is already booked on the coming days from
 *   here.
 * - **Saving:** each chosen catch-up becomes a real dated block, marked serious
 *   in the missed one's mode, so it shows on Today with Start and gets the
 *   Lock-in nudge.
 * - **Settling:** the missed occurrences it covers are recorded as "moved", and
 *   the ones let go as "dropped". Either way they stop being offered. The
 *   skips still count in the stats.
 */
import { apiPost } from "@/lib/api";
import {
  markSerious,
  settleCatchUp,
  type BusySlot,
  type CatchUpPlan,
  type CatchUpSession,
  type MissedBlock,
  type OccurrenceRef,
} from "@/lib/focus";
import { listRows } from "@/lib/localdb";
import { eventDraft } from "@/lib/recordDrafts";
import { createEvent, type RecordsMode } from "@/lib/records";
import { parseLocal } from "@/lib/utils";
import type { GroupedSchedule, ScheduleEvent } from "@/types";
import { dayKey } from "./SeriousContext";

export const OPEN_CATCH_UP = "jarvis-open-catch-up";
export const OPEN_CHECK_IN = "jarvis-open-check-in";

/** Open the catch-up sheet from anywhere (Today's card, the check-in). */
export function openCatchUp(): void {
  window.dispatchEvent(new Event(OPEN_CATCH_UP));
}

/** Open the evening check-in; `speak` when its notification opened it, so JARVIS says it. */
export function openCheckIn(options: { speak?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHECK_IN, { detail: options }));
}

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;

/** "7 PM", "7:30 PM" from "19:00", "19:30". */
export function spoken(clock: string): string {
  const [h, m] = clock.split(":").map(Number);
  const hour = h % 24;
  return `${hour % 12 || 12}${m ? `:${two(m)}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Thu" (or "Today"/"Tomorrow") for a YYYY-MM-DD date. */
export function dayName(date: string, now: Date): string {
  if (date === dayKey(now)) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date === dayKey(tomorrow)) return "Tomorrow";
  const parsed = new Date(`${date}T12:00:00`);
  return WEEKDAY_SHORT[(parsed.getDay() + 6) % 7];
}

/** "Tue's DSA": how a missed block is named in a sentence. */
export function missedLabel(miss: Pick<MissedBlock, "weekday" | "title">): string {
  return `${WEEKDAY_SHORT[miss.weekday] ?? "Earlier"}'s ${miss.title}`;
}

/** Everything booked from `from`'s day for `days` days. */
export function busyFor(schedule: GroupedSchedule | null | undefined, from: Date, days = 7): BusySlot[] {
  if (!schedule) return [];
  const first = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(first);
  last.setDate(first.getDate() + days);
  const out: BusySlot[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    const weekday = (day.getDay() + 6) % 7;
    for (const event of [...schedule.college, ...schedule.routine]) {
      if (event.day_of_week !== weekday || !event.start_time) continue;
      out.push({ date: dayKey(day), start: event.start_time.slice(0, 5), end: event.end_time ? event.end_time.slice(0, 5) : null });
    }
  }
  for (const event of schedule.session) {
    const start = parseLocal(event.time_start);
    if (!start || start < first || start >= last) continue;
    const end = parseLocal(event.time_end);
    out.push({
      date: dayKey(start),
      start: hhmm(start),
      end: !end ? null : dayKey(end) === dayKey(start) ? hhmm(end) : "24:00",
    });
  }
  return out;
}

const ref = (value: OccurrenceRef): OccurrenceRef => ({ uid: value.uid, occurrence: value.occurrence });

/** Save one catch-up as a dated block, serious in the missed one's mode. Returns its uid. */
async function saveSession(mode: RecordsMode, session: CatchUpSession, missed: MissedBlock | undefined): Promise<string> {
  const end = session.end === "24:00" ? "23:59" : session.end;
  const timeStart = `${session.date}T${session.start}:00`;
  const timeEnd = `${session.date}T${end}:00`;
  const draft = eventDraft({
    event_name: session.title,
    kind: "SESSION",
    time_start: timeStart,
    time_end: timeEnd,
    notes: missed ? `Catch-up for ${missedLabel(missed)}` : "Catch-up",
  });
  let uid: string | null | undefined = null;
  if (mode.local) {
    const before = new Set((await listRows("schedules")).map((row) => row.uid));
    await createEvent(mode, draft);
    const rows = await listRows("schedules");
    uid = rows.find(
      (row) => !before.has(row.uid) && row.event_name === draft.event_name && String(row.time_start ?? "").slice(0, 16) === timeStart.slice(0, 16),
    )?.uid;
  } else {
    uid = (await apiPost<ScheduleEvent>("/api/schedule", draft)).uid;
  }
  if (!uid) throw new Error("The catch-up was saved but couldn't be found to lock it in.");
  await markSerious(uid, {
    kind: "block",
    mode: session.covers?.mode ?? missed?.mode ?? "session",
    title: session.title,
    block_kind: "SESSION",
    day_of_week: null,
    start_time: null,
    end_time: null,
    time_start: timeStart,
    time_end: timeEnd,
  });
  return uid;
}

/**
 * Save the kept sessions, then settle the whole plan: covered misses are
 * moved; misses whose session was unticked, or that didn't fit, are let go. A
 * session that fails to save leaves its miss on the list, to try again.
 */
export async function applyCatchUp(mode: RecordsMode, plan: CatchUpPlan, keep: ReadonlySet<number>): Promise<{ saved: number; failed: number }> {
  const byKey = new Map(plan.missed.map((miss) => [`${miss.uid}|${miss.occurrence}`, miss]));
  const moved: OccurrenceRef[] = [];
  const dropped: OccurrenceRef[] = [];
  let saved = 0;
  let failed = 0;
  for (const [index, session] of plan.sessions.entries()) {
    const missed = session.covers ? byKey.get(`${session.covers.uid}|${session.covers.occurrence}`) : undefined;
    if (!keep.has(index)) {
      if (session.covers) dropped.push(ref(session.covers));
      continue;
    }
    try {
      await saveSession(mode, session, missed);
      saved += 1;
      if (session.covers) moved.push(ref(session.covers));
    } catch {
      failed += 1;
    }
  }
  for (const miss of plan.left) dropped.push(ref(miss));
  if (moved.length || dropped.length) await settleCatchUp(moved, dropped);
  return { saved, failed };
}

/** Let every missed one go: a clean slate, without the stats pretending. */
export function letGo(missed: MissedBlock[]): Promise<{ recorded: number }> {
  return settleCatchUp([], missed.map(ref));
}
