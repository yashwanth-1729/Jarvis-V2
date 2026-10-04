import { API_BASE } from "@/lib/api";
import { fetchFocus, type FocusItem, type FocusMode } from "@/lib/focus";
import { listRows, type SyncRow } from "@/lib/localdb";

export interface NativeAlarm {
  id: string;
  title: string;
  body: string;
  triggerAt: number;
  weekly: boolean;
  /**
   * What the card is about, so it is labelled exactly: the schedule kind
   * (COLLEGE, ROUTINE, SESSION), or LOCKIN / CHECKIN for serious mode.
   */
  kind?: string;
  /** A Lock-in's mode: "session" puts Start on the card, "quick" puts Done. */
  mode?: FocusMode;
}

/**
 * `window.JarvisNotifications`, attached by MainActivity.kt on Android. The
 * optional members arrived with Lock-in nudges, so an older APK lacks them.
 */
export interface NativeNotificationBridge {
  syncSchedules(json: string): number;
  syncTasks(json: string): number;
  syncReminders(json: string): number;
  firedReminders(): string;
  acknowledgeFiredReminders(json: string): number;
  /** Replace every `lockin:` alarm. */
  syncLockins?(json: string): number;
  /** Replace every `checkin:` alarm. */
  syncCheckins?(json: string): number;
  /**
   * The notification Start / Done / Check in tap waiting for the page, as JSON
   * `{"verb","uid","occurrence"}`, or "" when there is none. Reading it clears
   * it; see lib/notificationActions.ts.
   */
  takeAction?(): string;
}

declare global {
  interface Window {
    JarvisNotifications?: NativeNotificationBridge;
  }
}

interface ReminderRow {
  id: number;
  text: string;
  due_at: string;
  /** Set only on the early-notice row of a default reminder — see backend/app/llm/tools.py. */
  target_at?: string | null;
  fired_at?: string | null;
}

/**
 * The alarm body a reminder row should show.
 *
 * Mirrors `_reminder_announcement_text` in `backend/app/services/scheduler.py`:
 * a row with `target_at` set is the early half of a default (non-instant)
 * reminder, and the gap between `due_at` (when this alarm fires) and
 * `target_at` (what it's actually about) is the real lead time — computed
 * rather than assumed 15, since the backend clamps it when the target was too
 * close to give the full lead.
 */
function reminderAlarmBody(row: ReminderRow): string {
  if (!row.target_at) return row.text;
  const due = new Date(row.due_at).getTime();
  const target = new Date(row.target_at).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(target)) return row.text;
  const lead = Math.round((target - due) / 60_000);
  if (lead <= 0) return row.text;
  const spoken = new Date(row.target_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `In ${lead} minute${lead === 1 ? "" : "s"}, at ${spoken}: ${row.text}`;
}

export interface NotificationPolicy {
  version: number;
  enabled: boolean;
  deadline_tasks: boolean;
  college: boolean;
  routine: boolean;
  blocks: boolean;
  reminders: boolean;
  /** Lock-in nudges when a serious block starts, and the evening check-in. */
  serious: boolean;
  include: string[];
  exclude: string[];
}

const POLICY_STORAGE_KEY = "jarvis_notification_policy_v1";
const DEFAULT_POLICY: NotificationPolicy = {
  version: 1,
  enabled: true,
  deadline_tasks: true,
  college: false,
  routine: false,
  blocks: false,
  reminders: false,
  serious: true,
  include: [],
  exclude: [],
};

export function normalizePolicy(value: unknown): NotificationPolicy {
  const source = value && typeof value === "object" ? value as Partial<NotificationPolicy> : {};
  const boolean = (key: keyof NotificationPolicy) =>
    typeof source[key] === "boolean" ? source[key] as boolean : DEFAULT_POLICY[key] as boolean;
  const strings = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
  const exclude = strings(source.exclude);
  return {
    version: 1,
    enabled: boolean("enabled"),
    deadline_tasks: boolean("deadline_tasks"),
    college: boolean("college"),
    routine: boolean("routine"),
    blocks: boolean("blocks"),
    reminders: boolean("reminders"),
    serious: boolean("serious"),
    include: strings(source.include).filter((item) => !exclude.includes(item)),
    exclude,
  };
}

async function loadPolicy(): Promise<NotificationPolicy> {
  let cached = DEFAULT_POLICY;
  try {
    const raw = localStorage.getItem(POLICY_STORAGE_KEY);
    if (raw) cached = normalizePolicy(JSON.parse(raw));
  } catch {
    // A malformed cache should never prevent alarm reconciliation.
  }
  try {
    const response = await fetch(`${API_BASE}/api/notifications/policy`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return cached;
    const current = normalizePolicy(await response.json());
    localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(current));
    return current;
  } catch {
    return cached;
  }
}

/** The last `/api/focus` items, for when the backend is still starting or gone. */
const FOCUS_CACHE_KEY = "jarvis_focus_items_cache_v1";
const FOCUS_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Serious items, saved on every answer so that a backend that is still
 * starting (Python boots with the app on the phone) costs nothing: the last
 * answer stands in. Empty when there has never been one.
 */
async function loadFocusItems(): Promise<Partial<FocusItem>[]> {
  try {
    const { items } = await withTimeout(fetchFocus(), FOCUS_TIMEOUT_MS);
    if (Array.isArray(items)) {
      try {
        localStorage.setItem(FOCUS_CACHE_KEY, JSON.stringify(items));
      } catch {
        // Storage full or blocked: this answer still counts.
      }
      return items;
    }
  } catch {
    // Not answering yet: fall back to the saved copy.
  }
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(FOCUS_CACHE_KEY) ?? "[]");
    return Array.isArray(cached) ? cached as Partial<FocusItem>[] : [];
  } catch {
    return [];
  }
}

type PolicyCategory = "deadline_tasks" | "college" | "routine" | "blocks" | "reminders" | "serious";

function allowed(policy: NotificationPolicy, id: string, category: PolicyCategory): boolean {
  if (!policy.enabled || policy.exclude.includes(id)) return false;
  return policy.include.includes(id) || policy[category];
}

function scheduleCategory(row: SyncRow): PolicyCategory {
  return row.kind === "COLLEGE" ? "college" : row.kind === "ROUTINE" ? "routine" : "blocks";
}

/** COLLEGE and ROUTINE rows repeat weekly; a SESSION (a Block) is one dated slot. */
function isWeekly(row: SyncRow): boolean {
  return row.kind === "COLLEGE" || row.kind === "ROUTINE";
}

function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** "YYYY-MM-DD" in local time: how a block's occurrence is keyed. */
function dayKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** "HH:MM" as minutes after midnight, or null. */
function clockMinutes(value: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** "7:00 PM", the way the Plan shows a time. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function nextWeekly(row: SyncRow, now: Date): number | null {
  const day = Number(row.day_of_week);
  const match = /^(\d{1,2}):(\d{2})/.exec(String(row.start_time ?? ""));
  if (!Number.isInteger(day) || day < 0 || day > 6 || !match) return null;
  const candidate = new Date(now);
  candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
  candidate.setDate(candidate.getDate() + ((day - mondayIndex(now) + 7) % 7));
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

/** When a row next starts (strictly after `now`), and whether that repeats weekly. */
function nextStart(row: SyncRow, now: Date): { triggerAt: number; weekly: boolean } | null {
  const weekly = isWeekly(row);
  const triggerAt = weekly
    ? nextWeekly(row, now)
    : new Date(String(row.time_start ?? "")).getTime();
  if (triggerAt === null || !Number.isFinite(triggerAt) || triggerAt <= now.getTime()) return null;
  return { triggerAt, weekly };
}

/**
 * How long a block runs, in minutes, by the Plan's own rules
 * (schedulePolicy.ts): no end means an hour, and a weekly end at or before
 * its start is after midnight. Null when it cannot be told.
 */
function blockMinutes(row: SyncRow): number | null {
  if (isWeekly(row)) {
    const start = clockMinutes(row.start_time);
    if (start === null) return null;
    const end = clockMinutes(row.end_time);
    if (end === null) return 60;
    return end > start ? end - start : end + 24 * 60 - start;
  }
  const start = new Date(String(row.time_start ?? "")).getTime();
  if (!Number.isFinite(start)) return null;
  if (!row.time_end) return 60;
  const end = new Date(String(row.time_end)).getTime();
  return Number.isFinite(end) && end > start ? Math.round((end - start) / 60_000) : null;
}

function scheduleAlarm(row: SyncRow, now: Date): NativeAlarm | null {
  const title = String(row.event_name ?? "").trim();
  if (!title || !row.uid) return null;
  const next = nextStart(row, now);
  if (!next) return null;
  const details = [row.location, row.notes]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  return {
    id: `schedule:${row.uid}`,
    title,
    body: details || (next.weekly ? "Scheduled now · repeats weekly" : "Scheduled now"),
    triggerAt: next.triggerAt,
    weekly: next.weekly,
    kind: String(row.kind ?? ""),
  };
}

/** A serious block's start: "7:00 PM – 8:30 PM · 90 min" on the card. */
function lockinAlarm(row: SyncRow, mode: FocusMode, now: Date): NativeAlarm | null {
  const title = String(row.event_name ?? "").trim();
  if (!title || !row.uid) return null;
  const next = nextStart(row, now);
  if (!next) return null;
  const minutes = blockMinutes(row);
  const start = clock(next.triggerAt);
  return {
    id: `lockin:${row.uid}`,
    title,
    body: minutes && minutes > 0
      ? `${start} – ${clock(next.triggerAt + minutes * 60_000)} · ${minutes} min`
      : start,
    triggerAt: next.triggerAt,
    weekly: next.weekly,
    kind: "LOCKIN",
    mode,
  };
}

/** The check-in: 21:30, or 30 min after a serious block ending after 21:00, never past 23:30. */
const CHECKIN_AT = 21 * 60 + 30;
const CHECKIN_LATE_AFTER = 21 * 60;
const CHECKIN_AFTER_END = 30;
const CHECKIN_LATEST = 23 * 60 + 30;
/** Days ahead, today included, given a check-in. Every sync re-plans them. */
const CHECKIN_DAYS = 7;

function weekdayOf(row: SyncRow): number | null {
  if (row.day_of_week === null || row.day_of_week === undefined || row.day_of_week === "") return null;
  const day = Number(row.day_of_week);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
}

/**
 * When `row`'s occurrence on `day` ends, in minutes after that day's midnight
 * (past 24 h when it runs over midnight), or null when it has none that day.
 * Weekly rows occur by weekday, a SESSION on the date it starts.
 */
function endOnDay(row: SyncRow, day: Date): number | null {
  if (isWeekly(row)) {
    if (weekdayOf(row) !== mondayIndex(day)) return null;
    // A class with no time recorded still makes it a serious day.
    const start = clockMinutes(row.start_time) ?? 0;
    return start + (blockMinutes(row) ?? 0);
  }
  const start = new Date(String(row.time_start ?? ""));
  if (!Number.isFinite(start.getTime()) || dayKey(start) !== dayKey(day)) return null;
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  return Math.round((start.getTime() - midnight) / 60_000) + (blockMinutes(row) ?? 0);
}

/** One evening check-in for each of the next 7 days with a serious block. */
function checkinAlarms(seriousRows: readonly SyncRow[], policy: NotificationPolicy, now: Date): NativeAlarm[] {
  const alarms: NativeAlarm[] = [];
  for (let offset = 0; offset < CHECKIN_DAYS; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const ends = seriousRows
      .map((row) => endOnDay(row, day))
      .filter((end): end is number => end !== null);
    if (!ends.length) continue;
    const id = `checkin:${dayKey(day)}`;
    if (!allowed(policy, id, "serious")) continue;
    const latest = Math.max(...ends);
    const at = latest > CHECKIN_LATE_AFTER ? Math.min(latest + CHECKIN_AFTER_END, CHECKIN_LATEST) : CHECKIN_AT;
    const triggerAt = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(at / 60), at % 60,
    ).getTime();
    if (triggerAt <= now.getTime()) continue;
    alarms.push({
      id,
      title: "Daily check-in",
      body: "How did today go?",
      triggerAt,
      weekly: false,
      kind: "CHECKIN",
    });
  }
  return alarms;
}

export interface SchedulePlan {
  /** `schedule:` alarms, for every row that does not ring as a Lock-in. */
  schedules: NativeAlarm[];
  /** `lockin:` alarms, one per serious block, at its start. */
  lockins: NativeAlarm[];
  /** `checkin:` alarms, one per serious day of the next 7. */
  checkins: NativeAlarm[];
}

/**
 * Turn the timetable into alarms. A serious block (a `/api/focus` item of
 * kind block) rings as a Lock-in instead of its schedule alarm, never both.
 * When `serious` is off for it, or the APK cannot take Lock-ins
 * (`lockinsSupported`), it falls back to its usual category.
 */
export function planScheduleAlarms(
  rows: readonly SyncRow[],
  focusItems: readonly Partial<FocusItem>[],
  policy: NotificationPolicy,
  now: Date,
  lockinsSupported = true,
): SchedulePlan {
  const serious = new Map<string, FocusMode>();
  for (const item of focusItems) {
    if (item?.kind !== "block" || typeof item.uid !== "string" || !item.uid) continue;
    // Every Lock-in is Start, then Stop now (2026-10-04): the card says Start.
    serious.set(item.uid, "session");
  }
  const schedules: NativeAlarm[] = [];
  const lockins: NativeAlarm[] = [];
  for (const row of rows) {
    if (!row.uid) continue;
    const mode = serious.get(row.uid);
    if (mode && lockinsSupported && allowed(policy, `lockin:${row.uid}`, "serious")) {
      const alarm = lockinAlarm(row, mode, now);
      if (alarm) lockins.push(alarm);
      continue;
    }
    if (!allowed(policy, `schedule:${row.uid}`, scheduleCategory(row))) continue;
    const alarm = scheduleAlarm(row, now);
    if (alarm) schedules.push(alarm);
  }
  const seriousRows = rows.filter((row) => Boolean(row.uid) && serious.has(row.uid));
  return { schedules, lockins, checkins: checkinAlarms(seriousRows, policy, now) };
}

async function reconcileFiredReminders(bridge: NativeNotificationBridge): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (JSON.parse(bridge.firedReminders()) as unknown[])
      .map(String)
      .filter((id) => /^reminder:\d+$/.test(id));
  } catch {
    return;
  }
  if (!ids.length) return;
  const response = await fetch(`${API_BASE}/api/reminders/native-fired`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ids.map((id) => Number(id.slice("reminder:".length))) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (response.ok) bridge.acknowledgeFiredReminders(JSON.stringify(ids));
}

async function syncOnce(bridge: NativeNotificationBridge): Promise<boolean> {
  const [policy, focusItems] = await Promise.all([loadPolicy(), loadFocusItems()]);
  const rows = await listRows("schedules");
  // Taken after the awaits: an alarm that came due while they ran would
  // otherwise be booked as just missed and ring a second time.
  const now = new Date();
  const plan = planScheduleAlarms(rows, focusItems, policy, now, typeof bridge.syncLockins === "function");
  bridge.syncSchedules(JSON.stringify(plan.schedules));
  try {
    bridge.syncLockins?.(JSON.stringify(plan.lockins));
    bridge.syncCheckins?.(JSON.stringify(plan.checkins));
  } catch {
    // Lock-in nudges are extra: never let them stop deadlines and reminders.
  }

  const tasks = (await listRows("tasks"))
    .filter((row) => row.status !== "COMPLETED" && row.due_date && row.uid)
    .filter((row) => allowed(policy, `task:${row.uid}`, "deadline_tasks"))
    .map((row): NativeAlarm | null => {
      const triggerAt = new Date(String(row.due_date)).getTime();
      const title = String(row.title ?? "").trim();
      if (!title || !Number.isFinite(triggerAt) || triggerAt <= now.getTime()) return null;
      return {
        id: `task:${row.uid}`,
        title: "Task due",
        body: title,
        triggerAt,
        weekly: false,
      };
    })
    .filter((alarm): alarm is NativeAlarm => alarm !== null);
  bridge.syncTasks(JSON.stringify(tasks));

  try {
    await reconcileFiredReminders(bridge);
    const response = await fetch(`${API_BASE}/api/reminders`, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) return true;
    const reminders = (await response.json()) as ReminderRow[];
    const alarms: NativeAlarm[] = reminders
      .filter((row) => !row.fired_at && Number.isFinite(new Date(row.due_at).getTime()))
      .filter((row) => allowed(policy, `reminder:${row.id}`, "reminders"))
      .map((row) => ({
        id: `reminder:${row.id}`,
        title: "JARVIS reminder",
        body: reminderAlarmBody(row),
        triggerAt: new Date(row.due_at).getTime(),
        weekly: false,
      }));
    bridge.syncReminders(JSON.stringify(alarms));
  } catch {
    // Keep the last native reminder plan if Python is still starting or absent.
  }
  return true;
}

let inFlight: Promise<boolean> | null = null;
let again = false;

/**
 * Copy the phone's authoritative timetable and backend reminders into Android's
 * alarm service. The native plan survives WebView, Python and app shutdown.
 *
 * One run at a time: a call during a run makes it run once more at the end,
 * so a slow, older run can never land after a newer one.
 */
export function syncNativeNotifications(): Promise<boolean> {
  if (typeof window === "undefined" || !window.JarvisNotifications) return Promise.resolve(false);
  if (inFlight) {
    again = true;
    return inFlight;
  }
  const bridge = window.JarvisNotifications;
  inFlight = (async () => {
    try {
      let result: boolean;
      do {
        again = false;
        result = await syncOnce(bridge);
      } while (again);
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
