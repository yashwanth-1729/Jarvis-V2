/**
 * "Build your week": templates, and turning a block into real schedule
 * entries through the same path the Plan screen uses (`createEvent` with an
 * `eventDraft`, components/phone/sheets/PlanSheets.tsx). One weekly entry is
 * created per chosen day, because a schedule entry repeats on one weekday.
 *
 * Marking blocks serious for Lock-in needs their uids, which `createEvent`
 * does not return. On the phone (records in IndexedDB) the new rows are found
 * by diffing the store around the writes; where the backend owns the records
 * they are matched in the refreshed dashboard instead.
 */
import { markSerious, snapshotOf, unmarkSerious } from "@/lib/focus";
import { listRows } from "@/lib/localdb";
import { eventDraft } from "@/lib/recordDrafts";
import { createEvent, type RecordsMode } from "@/lib/records";
import type { LifeStage } from "@/lib/profile";
import type { GroupedSchedule, ScheduleEvent } from "@/types";
import type { Tone } from "./content";

export type TemplateId = "college" | "gym" | "study" | "coaching" | "work" | "sleep" | "custom";
export type WeeklyKind = "COLLEGE" | "ROUTINE";

export interface BlockSpec {
  template: TemplateId;
  name: string;
  emoji: string;
  tone: Tone;
  kind: WeeklyKind;
  /** 0 = Monday … 6 = Sunday. */
  days: number[];
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
}

export interface Template extends BlockSpec {
  label: string;
}

/** A block added during onboarding, with the schedule rows it created. */
export interface AddedBlock extends BlockSpec {
  id: string;
  /** One record per day; uid is "" until it can be resolved. */
  records: Array<{ day: number; uid: string }>;
}

export const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS = [0, 1, 2, 3, 4];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** The templates, most relevant first for their stage. */
export function templatesFor(stage: LifeStage | null, rhythm: { wake: string; sleep: string; night: boolean }): Template[] {
  const school = stage === "school";
  const creator = stage === "creator";
  const all: Record<TemplateId, Template> = {
    college: { template: "college", label: school ? "School" : "College", name: school ? "School" : "College", emoji: school ? "🎒" : "🎓", tone: "sky", kind: "COLLEGE", days: WEEKDAYS, start: school ? "08:30" : "09:00", end: school ? "15:30" : "16:00" },
    gym: { template: "gym", label: "Gym", name: "Gym", emoji: "🏋️", tone: "lime", kind: "ROUTINE", days: [0, 2, 4], start: rhythm.night ? "18:30" : "07:00", end: rhythm.night ? "19:30" : "08:00" },
    study: { template: "study", label: "Study", name: "Study", emoji: "📚", tone: "mint", kind: "ROUTINE", days: [0, 1, 2, 3, 4, 5], start: rhythm.night ? "20:00" : "18:00", end: rhythm.night ? "22:00" : "20:00" },
    coaching: { template: "coaching", label: "Coaching", name: "Coaching", emoji: "🧑‍🏫", tone: "amber", kind: "COLLEGE", days: [0, 1, 2, 3, 4, 5], start: "16:00", end: "18:00" },
    work: { template: "work", label: creator ? "Create" : "Work", name: creator ? "Create content" : "Work", emoji: creator ? "🎥" : "💼", tone: "orange", kind: "ROUTINE", days: WEEKDAYS, start: creator ? "11:00" : "09:30", end: creator ? "15:00" : "18:30" },
    sleep: { template: "sleep", label: "Sleep", name: "Sleep", emoji: "😴", tone: "lilac", kind: "ROUTINE", days: EVERY_DAY, start: rhythm.sleep, end: rhythm.wake },
    custom: { template: "custom", label: "Custom", name: "", emoji: "✨", tone: "pink", kind: "ROUTINE", days: [], start: "17:00", end: "18:00" },
  };
  const order: Record<LifeStage | "none", TemplateId[]> = {
    school: ["college", "coaching", "study", "gym", "sleep", "work", "custom"],
    college: ["college", "study", "gym", "coaching", "work", "sleep", "custom"],
    working: ["work", "gym", "study", "sleep", "college", "coaching", "custom"],
    creator: ["work", "gym", "study", "sleep", "college", "coaching", "custom"],
    exam: ["coaching", "study", "sleep", "gym", "college", "work", "custom"],
    none: ["college", "gym", "study", "coaching", "work", "sleep", "custom"],
  };
  return order[stage ?? "none"].map((id) => all[id]);
}

/** "7:00 AM" from "07:00". */
export function clock12(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return match[2] === "00" ? `${hour} ${suffix}` : `${hour}:${match[2]} ${suffix}`;
}

export function minutesOf(value: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

/** "Mon–Fri", "Every day", "M W F". */
export function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "0,1,2,3,4") return "Mon–Fri";
  if (key === "0,1,2,3,4,5") return "Mon–Sat";
  if (key === "5,6") return "Weekends";
  return sorted.map((day) => DAY_NAMES[day].slice(0, 3)).join(" ");
}

function sameClock(a: string | null | undefined, b: string): boolean {
  return a !== null && a !== undefined && minutesOf(a) === minutesOf(b);
}

/**
 * Create one weekly entry per day, one by one, exactly as the Plan sheet
 * saves an entry. Stops at the first failure and reports what did land, so a
 * retry never duplicates the days already created.
 */
export async function createBlock(
  mode: RecordsMode,
  spec: BlockSpec,
  onDay?: (day: number) => void,
): Promise<{ records: AddedBlock["records"]; error: string | null }> {
  const before = mode.local ? await existingUids() : null;
  const created: number[] = [];
  let error: string | null = null;
  for (const day of [...spec.days].sort((a, b) => a - b)) {
    try {
      const draft = eventDraft({
        event_name: spec.name,
        kind: spec.kind,
        day_of_week: String(day),
        start_time: spec.start,
        end_time: spec.end,
      });
      await createEvent(mode, draft);
      created.push(day);
      onDay?.(day);
    } catch (problem) {
      error = problem instanceof Error ? problem.message : "Couldn't save that one.";
      break;
    }
  }
  const records = created.map((day) => ({ day, uid: "" }));
  if (before) {
    try {
      const rows = await listRows("schedules");
      for (const row of rows) {
        if (before.has(row.uid) || row.event_name !== spec.name || row.kind !== spec.kind) continue;
        const slot = records.find((record) => record.day === Number(row.day_of_week) && !record.uid);
        if (slot) slot.uid = row.uid;
      }
    } catch {
      // Resolved later from the dashboard instead.
    }
  }
  return { records, error };
}

async function existingUids(): Promise<Set<string> | null> {
  try {
    return new Set((await listRows("schedules")).map((row) => row.uid));
  } catch {
    return null;
  }
}

/** Fill in uids the store diff could not, from the dashboard's schedule. */
export function resolveRecords(block: AddedBlock, schedule: GroupedSchedule | null | undefined): AddedBlock["records"] {
  if (block.records.every((record) => record.uid) || !schedule) return block.records;
  const taken = new Set(block.records.map((record) => record.uid).filter(Boolean));
  const pool = [...schedule.college, ...schedule.routine]
    .filter((event) => event.uid && event.event_name === block.name && event.kind === block.kind && sameClock(event.start_time, block.start))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return block.records.map((record) => {
    if (record.uid) return record;
    const match = pool.find((event) => event.day_of_week === record.day && !taken.has(event.uid ?? ""));
    if (!match?.uid) return record;
    taken.add(match.uid);
    return { ...record, uid: match.uid };
  });
}

/** The record as Lock-in sees it: the real one when the dashboard has it. */
function blockEvent(block: AddedBlock, record: { day: number; uid: string }, schedule: GroupedSchedule | null | undefined): ScheduleEvent {
  const real = schedule ? [...schedule.college, ...schedule.routine].find((event) => event.uid === record.uid) : undefined;
  if (real) return real;
  return {
    id: 0,
    uid: record.uid,
    event_name: block.name,
    kind: block.kind,
    day_of_week: record.day,
    start_time: block.start,
    end_time: block.end,
    time_start: null,
    time_end: null,
    location: null,
    notes: null,
    created_at: "",
    day_name: DAY_NAMES[record.day],
    display_start: clock12(block.start),
    display_end: clock12(block.end),
    window: `${clock12(block.start)} - ${clock12(block.end)}`,
  };
}

/**
 * Make every entry of the picked blocks serious (Start → Done), and release
 * any that were marked on an earlier pass but are no longer picked.
 * Returns the uids now marked, and how many could not be.
 */
export async function lockIn(
  picked: AddedBlock[],
  previously: string[],
  schedule: GroupedSchedule | null | undefined,
): Promise<{ marked: string[]; missing: number; failed: number }> {
  const marked: string[] = [];
  let missing = 0;
  let failed = 0;
  for (const block of picked) {
    for (const record of block.records) {
      if (!record.uid) {
        missing += 1;
        continue;
      }
      try {
        await markSerious(record.uid, snapshotOf({ block: blockEvent(block, record, schedule) }, "session"));
        marked.push(record.uid);
      } catch {
        failed += 1;
      }
    }
  }
  for (const uid of previously) {
    if (!marked.includes(uid)) await unmarkSerious(uid).catch(() => undefined);
  }
  return { marked, missing, failed };
}

/** One bar in the mini week preview. */
export interface WeekBar {
  key: string;
  /** The column it is drawn in. */
  day: number;
  /** The weekday the entry belongs to (differs for the after-midnight part). */
  from: number;
  top: number;
  height: number;
  tone: Tone;
  block: string;
}

/** Bars for the mini week: an overnight entry spills into the next day. */
export function weekBars(blocks: Array<BlockSpec & { id: string }>): WeekBar[] {
  const bars: WeekBar[] = [];
  for (const block of blocks) {
    const start = minutesOf(block.start);
    let end = minutesOf(block.end);
    if (end <= start) end += 1440;
    for (const day of block.days) {
      const pieces: Array<[number, number, number]> = end > 1440 ? [[day, start, 1440], [(day + 1) % 7, 0, end - 1440]] : [[day, start, end]];
      pieces.forEach(([column, from, to], index) => {
        if (to <= from) return;
        bars.push({
          key: `${block.id}-${day}-${index}`,
          day: column,
          top: (from / 1440) * 100,
          height: Math.max(2.5, ((to - from) / 1440) * 100),
          from: day,
          tone: block.tone,
          block: block.id,
        });
      });
    }
  }
  return bars;
}
