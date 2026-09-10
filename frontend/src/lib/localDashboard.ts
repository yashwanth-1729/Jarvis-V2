/**
 * The dashboard, assembled from IndexedDB.
 *
 * On mobile there is no local database behind the backend — IndexedDB *is* the
 * authoritative store for user data, and the backend is the AI/voice runtime.
 * So the dashboard has to be renderable with nothing running but the app
 * itself: no Python, no Supabase, no network.
 *
 * Everything here mirrors what the backend computes server-side, and the two
 * must agree or the same data would look different depending on which path
 * rendered it:
 *
 *   display fields  `backend/app/db/crud.py::_decorate`
 *   clock format    `backend/app/core/timeutil.py::format_clock`
 *   overdue rule    a due date in the past on a task that is not COMPLETED
 *
 * The one thing it cannot reproduce is the proactive brief: that is written by
 * the model, and there is no model without the backend. Local rendering
 * substitutes a plain factual summary rather than leaving a hole.
 */

import { SYNCED_TABLES, type SyncRow, listRows, expireBlocks, expireMemories } from "@/lib/localdb";
import { decodeMemoryContent } from "@/lib/memory";
import { agendaForDay, chronological } from "@/lib/schedulePolicy";
import type {
  Brief,
  DashboardState,
  GroupedSchedule,
  Idea,
  Memory,
  NotePage,
  ScheduleConflict,
  ScheduleEvent,
  ScheduleKind,
  Task,
  TaskCounts,
} from "@/types";

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const WEEKLY_KINDS: ScheduleKind[] = ["COLLEGE", "ROUTINE"];

/**
 * A stable positive integer for a uid.
 *
 * The UI's types carry `id: number` because the desktop backend assigns one,
 * but that id is device-local and deliberately never synced — rows arriving
 * from Supabase have no id at all. Deriving one from the uid keeps every
 * existing component and prop signature working unchanged, and stays stable
 * across reloads because it is a pure function of the uid.
 */
export function numericId(uid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    hash ^= uid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Kept inside the safe-integer range and away from 0, which some callers
  // treat as "unsaved".
  return (hash % 2_000_000_000) + 1;
}

/** `'18:30'` -> `'6:30 PM'`. Matches `format_clock` exactly. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value));
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return "";
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function weekdayName(index: number | null | undefined): string {
  if (index === null || index === undefined || index < 0 || index > 6) return "";
  return WEEKDAYS[index];
}

/** Local-time `YYYY-MM-DD` for a Date. Never `toISOString`, which is UTC. */
function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Monday-based weekday, matching the backend's 0 = Monday convention. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function toTask(row: SyncRow): Task {
  return {
    id: numericId(row.uid),
    uid: row.uid,
    title: String(row.title ?? ""),
    category: String(row.category ?? "GENERAL"),
    priority: (row.priority as Task["priority"]) ?? "MEDIUM",
    status: (row.status as Task["status"]) ?? "PENDING",
    due_date: (row.due_date as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function toSchedule(row: SyncRow): ScheduleEvent {
  const kind = ((row.kind as ScheduleKind) ?? "SESSION") satisfies ScheduleKind;

  let dayName = "";
  let displayStart = "";
  let displayEnd = "";

  if (WEEKLY_KINDS.includes(kind)) {
    dayName = weekdayName(row.day_of_week as number | null);
    displayStart = formatClock(row.start_time as string | null);
    displayEnd = formatClock(row.end_time as string | null);
  } else {
    const start = row.time_start ? new Date(String(row.time_start)) : null;
    const end = row.time_end ? new Date(String(row.time_end)) : null;
    if (start && !Number.isNaN(start.getTime())) {
      dayName = weekdayName(mondayIndex(start));
      displayStart = formatClock(
        `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
      );
    }
    if (end && !Number.isNaN(end.getTime())) {
      displayEnd = formatClock(
        `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
      );
    }
  }

  return {
    id: numericId(row.uid),
    uid: row.uid,
    event_name: String(row.event_name ?? ""),
    kind,
    time_start: (row.time_start as string | null) ?? null,
    time_end: (row.time_end as string | null) ?? null,
    day_of_week: (row.day_of_week as number | null) ?? null,
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    day_name: dayName,
    display_start: displayStart,
    display_end: displayEnd,
    window: displayEnd ? `${displayStart} - ${displayEnd}` : displayStart,
  };
}

function toIdea(row: SyncRow): Idea {
  return {
    page_uid: row.page_uid as string | null,
    id: numericId(row.uid),
    uid: row.uid,
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    tags: String(row.tags ?? ""),
    status: (row.status as Idea["status"]) ?? "DRAFT",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function toMemory(row: SyncRow): Memory {
  const decoded = decodeMemoryContent(row.content, {
    category: row.category,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  });
  return {
    expires_at: row.expires_at as string | null,
    id: numericId(row.uid),
    uid: row.uid,
    key_concept: String(row.key_concept ?? ""),
    category: row.category === "PRIVATE" ? "LONG_TERM" : (row.category as Memory["category"]) ?? "LONG_TERM",
    content: decoded.body,
    memory_type: decoded.metadata.type,
    memory_status: decoded.metadata.status,
    confidence: decoded.metadata.confidence,
    importance: decoded.metadata.importance,
    source_kind: decoded.metadata.source_kind,
    source_ref: decoded.metadata.source_ref,
    valid_from: decoded.metadata.valid_from,
    supersedes_uid: decoded.metadata.supersedes_uid,
    pinned: decoded.metadata.pinned,
    evidence_count: decoded.metadata.evidence_count,
    tags: decoded.metadata.tags,
    revision_count: decoded.metadata.history.length,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

/** Minutes past midnight, for overlap comparison. */
function minutes(clock: string | null): number | null {
  if (!clock) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Weekly entries that collide.
 *
 * Only weekly kinds are compared: two one-off sessions overlapping is a
 * genuine possibility but needs date arithmetic the backend already does, and
 * the recurring timetable is where collisions actually bite.
 */
function findConflicts(events: ScheduleEvent[]): ScheduleConflict[] {
  const weekly = events.filter(
    (e) => WEEKLY_KINDS.includes(e.kind) && e.day_of_week !== null && e.start_time,
  );
  const conflicts: ScheduleConflict[] = [];

  for (let i = 0; i < weekly.length; i++) {
    for (let j = i + 1; j < weekly.length; j++) {
      const a = weekly[i];
      const b = weekly[j];
      if (a.day_of_week !== b.day_of_week) continue;

      const aStart = minutes(a.start_time);
      const bStart = minutes(b.start_time);
      if (aStart === null || bStart === null) continue;
      // A missing end time is treated as a one-hour block, matching how the
      // backend reasons about an unbounded entry.
      const aEnd = minutes(a.end_time) ?? aStart + 60;
      const bEnd = minutes(b.end_time) ?? bStart + 60;

      if (aStart < bEnd && bStart < aEnd) {
        conflicts.push({
          a_id: a.id,
          b_id: b.id,
          a_label: a.event_name,
          b_label: b.event_name,
          detail: `${a.day_name}, ${a.window} overlaps ${b.window}`,
        });
      }
    }
  }
  return conflicts;
}

/** A factual stand-in for the model-written brief. */
function localBrief(tasks: Task[], today: ScheduleEvent[], overdue: number): Brief {
  const open = tasks.filter((t) => t.status !== "COMPLETED");
  const bullets: string[] = [];

  if (overdue) bullets.push(`${overdue} overdue task${overdue === 1 ? "" : "s"}`);
  if (open.length) bullets.push(`${open.length} open task${open.length === 1 ? "" : "s"}`);
  if (today.length) {
    bullets.push(`${today.length} scheduled today — next is ${today[0].event_name}`);
  }
  if (!bullets.length) bullets.push("Nothing outstanding.");

  return {
    id: null,
    summary_text: bullets.join(" · "),
    urgent_count: overdue,
    generated_at: null,
    bullets,
  };
}

/**
 * Build the whole dashboard from local storage.
 *
 * Reads only — never touches the network, so it resolves in a frame or two and
 * is safe to call before anything else has started.
 */
export async function localDashboard(): Promise<DashboardState> {
  await expireBlocks();
  await expireMemories();
  const [taskRows, scheduleRows, memoryRows, ideaRows, pageRows] = await Promise.all(
    SYNCED_TABLES.map((table) => listRows(table)),
  );

  const tasks = taskRows.map(toTask);
  const schedules = scheduleRows.map(toSchedule);
  const ideas = ideaRows.map(toIdea);
  const memories = memoryRows.map(toMemory);

  const now = new Date();
  const todayKey = dateKey(now);
  const todayIndex = mondayIndex(now);

  const counts: TaskCounts = {
    PENDING: tasks.filter((t) => t.status === "PENDING").length,
    IN_PROGRESS: tasks.filter((t) => t.status === "IN_PROGRESS").length,
    COMPLETED: tasks.filter((t) => t.status === "COMPLETED").length,
    OVERDUE: tasks.filter(
      (t) => t.status !== "COMPLETED" && t.due_date !== null && t.due_date < todayKey,
    ).length,
  };

  const startsToday = (event: ScheduleEvent) =>
    WEEKLY_KINDS.includes(event.kind)
      ? event.day_of_week === todayIndex
      : Boolean(event.time_start?.startsWith(todayKey));

  const byClock = (a: ScheduleEvent, b: ScheduleEvent) =>
    (a.start_time ?? a.time_start ?? "").localeCompare(b.start_time ?? b.time_start ?? "");

  const today = agendaForDay(schedules, now);

  // One-off sessions inside the next week, plus every weekly block — the same
  // horizon the backend's `upcoming_schedule` uses.
  const horizon = new Date(now.getTime() + 7 * 86_400_000);
  const upcoming = Array.from({length: 7}, (_, offset) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return agendaForDay(schedules, day);
  }).flat().filter(event => new Date(event.time_end || event.time_start || "").getTime() > now.getTime()).sort(chronological);

  const schedule: GroupedSchedule = {
    college: schedules.filter((e) => e.kind === "COLLEGE").sort(byClock),
    routine: schedules.filter((e) => e.kind === "ROUTINE").sort(byClock),
    session: schedules.filter((e) => e.kind === "SESSION").sort(chronological),
    conflicts: findConflicts(schedules),
  };

  return {
    generated_at: new Date().toISOString(),
    counts,
    brief: localBrief(tasks, today, counts.OVERDUE),
    tasks,
    today,
    upcoming,
    schedule,
    ideas,
    memories,
    note_pages: pageRows as unknown as NotePage[],
  };
}
