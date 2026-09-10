import { API_BASE } from "@/lib/api";
import { listRows, type SyncRow } from "@/lib/localdb";

interface NativeAlarm {
  id: string;
  title: string;
  body: string;
  triggerAt: number;
  weekly: boolean;
}

interface NativeNotificationBridge {
  syncSchedules(json: string): number;
  syncTasks(json: string): number;
  syncReminders(json: string): number;
  firedReminders(): string;
  acknowledgeFiredReminders(json: string): number;
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
  fired_at?: string | null;
}

interface NotificationPolicy {
  version: number;
  enabled: boolean;
  deadline_tasks: boolean;
  college: boolean;
  routine: boolean;
  blocks: boolean;
  reminders: boolean;
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
  include: [],
  exclude: [],
};

function normalizePolicy(value: unknown): NotificationPolicy {
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

type PolicyCategory = "deadline_tasks" | "college" | "routine" | "blocks" | "reminders";

function allowed(policy: NotificationPolicy, id: string, category: PolicyCategory): boolean {
  if (!policy.enabled || policy.exclude.includes(id)) return false;
  return policy.include.includes(id) || policy[category];
}

function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
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

function scheduleAlarm(row: SyncRow, now: Date): NativeAlarm | null {
  const title = String(row.event_name ?? "").trim();
  if (!title || !row.uid) return null;
  const weekly = row.kind === "COLLEGE" || row.kind === "ROUTINE";
  const triggerAt = weekly
    ? nextWeekly(row, now)
    : new Date(String(row.time_start ?? "")).getTime();
  if (triggerAt === null || !Number.isFinite(triggerAt) || triggerAt <= now.getTime()) return null;
  const details = [row.location, row.notes]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  return {
    id: `schedule:${row.uid}`,
    title,
    body: details || (weekly ? "Scheduled now · repeats weekly" : "Scheduled now"),
    triggerAt,
    weekly,
  };
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

/**
 * Copy the phone's authoritative timetable and backend reminders into Android's
 * alarm service. The native plan survives WebView, Python and app shutdown.
 */
export async function syncNativeNotifications(): Promise<boolean> {
  if (typeof window === "undefined" || !window.JarvisNotifications) return false;
  const bridge = window.JarvisNotifications;
  const now = new Date();
  const policy = await loadPolicy();
  const schedules = (await listRows("schedules"))
    .filter((row) => {
      const id = `schedule:${row.uid}`;
      const category: PolicyCategory = row.kind === "COLLEGE"
        ? "college"
        : row.kind === "ROUTINE"
          ? "routine"
          : "blocks";
      return Boolean(row.uid) && allowed(policy, id, category);
    })
    .map((row) => scheduleAlarm(row, now))
    .filter((alarm): alarm is NativeAlarm => alarm !== null);
  bridge.syncSchedules(JSON.stringify(schedules));

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
        body: row.text,
        triggerAt: new Date(row.due_at).getTime(),
        weekly: false,
      }));
    bridge.syncReminders(JSON.stringify(alarms));
  } catch {
    // Keep the last native reminder plan if Python is still starting or absent.
  }
  return true;
}
