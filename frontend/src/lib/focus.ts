/**
 * Serious mode, client side (backend: services/focus.py, /api/focus).
 *
 * Like reminders, serious marks and their start/finish log live in each
 * device's own backend database, so these calls are the same on desktop and
 * phone and never touch the record store.
 */

import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import type { ScheduleEvent, Task } from "@/types";

export type FocusMode = "session" | "quick";

export interface FocusItem {
  uid: string;
  kind: "task" | "block";
  mode: FocusMode;
  title: string;
  block_kind: string | null;
  day_of_week: number | null;
  start_time: string | null;
  end_time: string | null;
  time_start: string | null;
  time_end: string | null;
  due_date: string | null;
  created_at: string;
}

export interface FocusEvent {
  id: number;
  item_uid: string;
  title: string;
  /** A date (YYYY-MM-DD) for a block, "once" for a task. */
  occurrence: string;
  /** "moved": a catch-up session covers this missed one; "dropped": let go. */
  status: "running" | "done" | "moved" | "dropped";
  started_at: string | null;
  finished_at: string | null;
  minutes: number | null;
}

export interface FocusDay {
  date: string;
  done: number;
  skipped: number;
  minutes: number;
}

export interface FocusStats {
  days: number;
  done: number;
  skipped: number;
  rate: number | null;
  minutes: number;
  streak: number;
  best_streak: number;
  perfect_days: number;
  today: { done: number; skipped: number; pending: number };
  series: FocusDay[];
  items: Array<{ uid: string; title: string; done: number; skipped: number }>;
  running: FocusEvent | null;
}

export function fetchFocus(): Promise<{ items: FocusItem[]; events: FocusEvent[] }> {
  return apiGet("/api/focus");
}

/** A serious block whose time passed this week with no Done (services/replan.py). */
export interface MissedBlock {
  uid: string;
  title: string;
  mode: FocusMode;
  occurrence: string;
  /** 0 = Monday. */
  weekday: number;
  start: string | null;
  end: string | null;
  minutes: number;
}

export interface CatchUpSession {
  title: string;
  date: string;
  start: string;
  end: string;
  minutes: number;
  /** The missed occurrence this session makes up for. */
  covers: { uid: string; occurrence: string; mode: FocusMode } | null;
}

export interface CatchUpPlan {
  missed: MissedBlock[];
  sessions: CatchUpSession[];
  /** Missed ones nothing could be fitted for. */
  left: MissedBlock[];
  message: string;
  /** "ai": GPT-6 Luna's plan, checked; "basic": the plain placer; "none": nothing to place. */
  source: "ai" | "basic" | "none";
}

/** Already booked on a coming day, so catch-ups land in free time. */
export interface BusySlot {
  date: string;
  start: string;
  end: string | null;
}

export interface OccurrenceRef {
  uid: string;
  occurrence: string;
}

export function fetchMissed(): Promise<{ missed: MissedBlock[] }> {
  return apiGet("/api/focus/missed");
}

export function proposeCatchUp(busy: BusySlot[]): Promise<CatchUpPlan> {
  return apiPost("/api/focus/catchup", { busy });
}

export function settleCatchUp(moved: OccurrenceRef[], dropped: OccurrenceRef[]): Promise<{ recorded: number }> {
  return apiPost<{ recorded: number }>("/api/focus/catchup/settle", { moved, dropped }).then(announce);
}

export function fetchFocusStats(days = 30): Promise<FocusStats> {
  return apiGet(`/api/focus/stats?days=${days}`);
}

/** What the backend keeps about a record so it can judge skips on its own. */
export function snapshotOf(record: { task: Task } | { block: ScheduleEvent }, mode: FocusMode) {
  if ("task" in record) {
    return { kind: "task" as const, mode, title: record.task.title, due_date: record.task.due_date };
  }
  const block = record.block;
  return {
    kind: "block" as const,
    mode,
    title: block.event_name,
    block_kind: block.kind,
    day_of_week: block.day_of_week,
    start_time: block.start_time ?? null,
    end_time: block.end_time ?? null,
    time_start: block.time_start,
    time_end: block.time_end,
  };
}

export function markSerious(uid: string, snapshot: ReturnType<typeof snapshotOf>): Promise<FocusItem> {
  return apiPut<FocusItem>(`/api/focus/items/${encodeURIComponent(uid)}`, snapshot).then(announce);
}

export function unmarkSerious(uid: string): Promise<void> {
  return apiDelete(`/api/focus/items/${encodeURIComponent(uid)}`).then(announce);
}

export function startFocus(uid: string, occurrence?: string): Promise<FocusEvent> {
  return apiPost<FocusEvent>(`/api/focus/items/${encodeURIComponent(uid)}/start`, { occurrence: occurrence ?? null }).then(announce);
}

export function finishFocus(uid: string, occurrence?: string): Promise<FocusEvent> {
  return apiPost<FocusEvent>(`/api/focus/items/${encodeURIComponent(uid)}/done`, { occurrence: occurrence ?? null }).then(announce);
}

export function resetFocus(uid: string, occurrence?: string): Promise<{ removed: number }> {
  return apiPost<{ removed: number }>(`/api/focus/items/${encodeURIComponent(uid)}/reset`, { occurrence: occurrence ?? null }).then(announce);
}

/** Every change tells the whole app (Today, Tasks, Lock-in, the Lock-in bar). */
function announce<T>(value: T): T {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FOCUS_CHANGED));
  return value;
}

/**
 * A task ticked off anywhere (the board, Today, voice) counts for serious
 * mode too. Fire and forget: for a task that is not serious the backend
 * answers 404, which is fine.
 */
export function noteTaskDone(task: Task): void {
  if (!task.uid) return;
  void finishFocus(task.uid).then(focusChanged, () => undefined);
}

/** Fired after serious-mode state changes outside the Lock-in screen. */
export const FOCUS_CHANGED = "jarvis-focus-changed";

function focusChanged(): void {
  window.dispatchEvent(new Event(FOCUS_CHANGED));
}

/**
 * The finish toast's Undo takes a serious task's Done back too (Lock-in
 * records it at once, before the board commits). A no-op for other tasks.
 */
export function noteTaskUndone(task: Task): void {
  if (!task.uid) return;
  void resetFocus(task.uid).then(focusChanged, () => undefined);
}
