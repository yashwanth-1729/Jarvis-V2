/**
 * "What goes in your week?": the person lists what they want or need to do
 * and drags how much of the week each one gets (1-10 points, or MAX); the
 * HOLO gateway's planner (GPT-6 Luna) turns that into one timetable, with or
 * without free blocks, and rebuilds it from their feedback.
 *
 * Day numbers are 0 = Monday … 6 = Sunday on both sides: the gateway's
 * convention is the app's own `day_of_week` (types/index.ts), so nothing is
 * converted at the boundary.
 */
import { HOLO_GATEWAY_URL } from "@/lib/publicAuth";
import type { LifeStage } from "@/lib/profile";
import { TONES, type Tone } from "./content";
import { minutesOf, type BlockSpec } from "./weekPlan";

export type Phase = "morning" | "afternoon" | "evening" | "night";

/** Points per activity: 1-10, and 11 means MAX. */
export const POINTS_MIN = 1;
export const POINTS_MAX = 11;
export const DEFAULT_POINTS = 5;
/** What the planner calls the breathing room it leaves. */
export const FREE_TIME = "Free time";

export interface PlannedBlock {
  activity: string;
  day: number;
  start: string;
  end: string;
  phase: Phase;
  /** Breathing room, not a task: drawn calm, never tweaked or locked in. */
  free?: boolean;
}

export interface Busy {
  label: string;
  days: number[];
  start: string;
  end: string;
}

export interface PlanWeekRequest {
  wake: string;
  sleep: string;
  chronotype?: "early" | "night";
  stage?: string;
  exam?: string | null;
  goals?: string[];
  interests?: string[];
  busy?: Busy | null;
  /** true leaves free blocks in the week; false is a strict timetable. */
  freeTime: boolean;
  activities: Array<{ name: string; points: number }>;
  previous?: PlannedBlock[] | null;
  feedback?: Array<{ activity: string; change: "less" | "more" }>;
  comment?: string | null;
}

export interface PlanWeekResponse {
  blocks: PlannedBlock[];
  summary: string;
  perActivity: Array<{ activity: string; timesPerWeek: number; minutesPerSession: number }>;
}

export interface PlanActivity {
  name: string;
  /** 1-10, or 11 for MAX. */
  points: number;
}

/** The week step's own state, kept in the onboarding draft. */
export interface WeekState {
  /** "manual" is the template builder (the fallback). */
  mode: "auto" | "manual";
  /** Fixed hours (school, college, work); null until first changed. */
  hours: { off: boolean; days: number[]; start: string; end: string } | null;
  activities: PlanActivity[];
  /** Free blocks (true) or a strict timetable (false); null until answered. */
  freeTime: boolean | null;
  plan: PlanWeekResponse | null;
  tweaks: number;
  /** The plan is in the schedule; it can no longer be rebuilt here. */
  saved: boolean;
}

export const EMPTY_WEEK: WeekState = { mode: "auto", hours: null, activities: [], freeTime: null, plan: null, tweaks: 0, saved: false };
export const MAX_TWEAKS = 5;
export const MAX_ACTIVITIES = 10;

export function clampPoints(value: number): number {
  return Math.min(POINTS_MAX, Math.max(POINTS_MIN, Math.round(Number.isFinite(value) ? value : DEFAULT_POINTS)));
}

/* -------------------------------------------------------------- names */

const EMOJI: Record<string, string> = {
  "Gym": "🏋️",
  "Study / revision": "📚",
  "DSA / coding": "💻",
  "Reading": "📖",
  "Meditation": "🧘",
  "Language practice": "🗣️",
  "Music practice": "🎸",
  "Content creation": "🎥",
  "Sports": "⚽",
  "Side project": "🛠️",
  "Walk": "🚶",
  "Journaling": "✍️",
  "Mock test": "📝",
  "Interview prep": "🎤",
  "Skill building": "🧠",
  "Yoga": "🤸",
  "Photography": "📸",
  "Art practice": "🎨",
  "Learn AI": "🤖",
  "Chill time": "🎮",
  [FREE_TIME]: "🌿",
};

const DEFAULTS = ["Gym", "Study / revision", "DSA / coding", "Reading", "Walk"];

const FROM_GOAL: Record<string, string[]> = {
  "Finish the syllabus": ["Study / revision"],
  "A mock test every week": ["Mock test"],
  "Top my semester": ["Study / revision"],
  "Ace my boards": ["Study / revision"],
  "Get into a top college": ["Study / revision"],
  "Land an internship": ["DSA / coding", "Interview prep"],
  "Get placed": ["DSA / coding", "Interview prep"],
  "Get promoted": ["Skill building"],
  "Switch to a better job": ["Interview prep", "Skill building"],
  "Leave work at work": ["Walk"],
  "Grow my channel": ["Content creation"],
  "Post consistently": ["Content creation"],
  "Land a brand deal": ["Content creation"],
  "Get fit": ["Gym"],
  "Build a side project": ["Side project"],
  "Learn to code": ["DSA / coding"],
  "Read 12 books": ["Reading"],
  "Less screen time": ["Walk"],
  "Learn a new skill": ["Skill building"],
  "Start a business": ["Side project"],
  "Stress less": ["Meditation"],
  "Learn a language": ["Language practice"],
};

const FROM_INTEREST: Record<string, string> = {
  "Gym": "Gym",
  "Coding": "DSA / coding",
  "Music": "Music practice",
  "Cricket": "Sports",
  "Football": "Sports",
  "Books": "Reading",
  "Yoga": "Yoga",
  "Photography": "Photography",
  "Art & design": "Art practice",
  "Startups": "Side project",
  "AI": "Learn AI",
};

export function emojiFor(name: string): string {
  const key = Object.keys(EMOJI).find((item) => item.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  return key ? EMOJI[key] : "✨";
}

function unique(items: string[]): string[] {
  return items.filter((item, index) => items.indexOf(item) === index);
}

/** Two or three "e.g." examples for the input, from their goals and interests. */
export function examples(goals: string[], interests: string[]): string[] {
  return unique([
    ...goals.flatMap((goal) => (goal.startsWith("Crack ") ? ["Study / revision"] : FROM_GOAL[goal] ?? [])),
    ...interests.map((interest) => FROM_INTEREST[interest]).filter((item): item is string => Boolean(item)),
    ...DEFAULTS,
  ]).slice(0, 3);
}

/* -------------------------------------------------------------- hours */

export function needsHours(stage: LifeStage | null): boolean {
  return stage === "school" || stage === "college" || stage === "working";
}

export function hoursLabel(stage: LifeStage | null): string {
  return stage === "school" ? "School" : stage === "working" ? "Work" : "College";
}

export function defaultHours(stage: LifeStage | null): NonNullable<WeekState["hours"]> {
  return stage === "working"
    ? { off: false, days: [0, 1, 2, 3, 4], start: "09:30", end: "18:30" }
    : { off: false, days: [0, 1, 2, 3, 4], start: "09:00", end: "16:00" };
}

/** The fixed hours as shown: what they set, or the stage's defaults. */
export function hoursOf(week: WeekState, stage: LifeStage | null): NonNullable<WeekState["hours"]> {
  return week.hours ?? defaultHours(stage);
}

/** The busy block sent to the planner and saved, or null. */
export function busyOf(week: WeekState, stage: LifeStage | null): Busy | null {
  const hours = hoursOf(week, stage);
  if (!needsHours(stage) || hours.off || hours.days.length === 0 || !hours.start || !hours.end) return null;
  return { label: hoursLabel(stage), days: [...hours.days].sort((a, b) => a - b), start: hours.start, end: hours.end };
}

/* ------------------------------------------------------------- gateway */

export class PlanError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fallback: boolean) {
    super(message);
  }
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHASES: Phase[] = ["morning", "afternoon", "evening", "night"];

export function phaseOf(start: string): Phase {
  const minutes = minutesOf(start);
  if (minutes >= 4 * 60 && minutes < 12 * 60) return "morning";
  if (minutes >= 12 * 60 && minutes < 17 * 60) return "afternoon";
  if (minutes >= 17 * 60 && minutes < 21 * 60) return "evening";
  return "night";
}

function record(item: unknown): Record<string, unknown> {
  return (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
}

/** Keep only well-formed blocks; the model's output is checked, not trusted. */
function cleanResponse(data: unknown): PlanWeekResponse {
  const source = record(data);
  const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
    .map(record)
    .filter((item) =>
      typeof item.activity === "string" && item.activity.trim() &&
      Number.isInteger(item.day) && Number(item.day) >= 0 && Number(item.day) <= 6 &&
      typeof item.start === "string" && CLOCK.test(item.start) &&
      typeof item.end === "string" && CLOCK.test(item.end) && item.start !== item.end,
    )
    .map((item): PlannedBlock => {
      const free = item.free === true;
      return {
        activity: free ? FREE_TIME : String(item.activity).trim().slice(0, 40),
        day: Number(item.day),
        start: String(item.start),
        end: String(item.end),
        phase: PHASES.includes(item.phase as Phase) ? (item.phase as Phase) : phaseOf(String(item.start)),
        ...(free ? { free: true } : {}),
      };
    });
  const perActivity = (Array.isArray(source.perActivity) ? source.perActivity : [])
    .map(record)
    .filter((item) => typeof item.activity === "string")
    .map((item) => ({
      activity: String(item.activity),
      timesPerWeek: Math.max(0, Math.round(Number(item.timesPerWeek) || 0)),
      minutesPerSession: Math.max(0, Math.round(Number(item.minutesPerSession) || 0)),
    }));
  return { blocks, summary: typeof source.summary === "string" ? source.summary.slice(0, 400) : "", perActivity };
}

function friendlyError(status: number, code: string): PlanError {
  if (code === "free_pool_exhausted") return new PlanError("My free brainpower's tapped out for today. Back at midnight, or set it up yourself.", status, code, true);
  if (status === 429 || code === "rate_limited") return new PlanError("Whoa, too many tries. Give it a minute, or set it up yourself.", status, code || "rate_limited", true);
  if (status === 400 || code === "invalid_request") return new PlanError("Something in that didn't add up. Change a thing or two and try again.", status, code || "invalid_request", false);
  return new PlanError("The planner's having a moment. Try again, or set it up yourself.", status, code || "upstream", true);
}

/** POST /v1/plan/week. Throws a PlanError with a message ready to show. */
export async function planWeek(request: PlanWeekRequest, token: string | null, signal?: AbortSignal): Promise<PlanWeekResponse> {
  if (!HOLO_GATEWAY_URL) throw new PlanError("The planner isn't connected in this build. Set it up yourself for now.", 0, "not_configured", true);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${HOLO_GATEWAY_URL}/v1/plan/week`, { method: "POST", headers, body: JSON.stringify(request), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new PlanError("Stopped.", 0, "aborted", false);
    throw new PlanError("Can't reach my planner right now. Check your connection, or set it up yourself.", 0, "unreachable", true);
  }
  const data = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
  if (!response.ok) throw friendlyError(response.status, data?.error?.code ?? "");
  const plan = cleanResponse(data);
  if (!plan.blocks.some((block) => !block.free)) throw new PlanError("That plan came back empty. Try again?", response.status, "empty", true);
  return plan;
}

/** The plan being tweaked, as sent back: real blocks only, never free time. */
export function previousOf(plan: PlanWeekResponse): PlannedBlock[] {
  return plan.blocks.filter((block) => !block.free).map(({ activity, day, start, end, phase }) => ({ activity, day, start, end, phase }));
}

/* --------------------------------------------------------------- drafts */

/**
 * The week state from a saved draft, whatever version wrote it. Older drafts
 * rated importance 1-5 (and had a frequency); that becomes points × 2.
 */
export function normalizeWeek(raw: unknown): WeekState {
  const source = record(raw);
  const activities = (Array.isArray(source.activities) ? source.activities : [])
    .map(record)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ").slice(0, 40) : "",
      points: clampPoints(typeof item.points === "number" ? item.points : typeof item.importance === "number" ? item.importance * 2 : DEFAULT_POINTS),
    }))
    .filter((item) => item.name && item.name.toLocaleLowerCase() !== FREE_TIME.toLocaleLowerCase())
    .slice(0, MAX_ACTIVITIES);
  const hoursSource = source.hours ? record(source.hours) : null;
  const hours =
    hoursSource && Array.isArray(hoursSource.days) && typeof hoursSource.start === "string" && typeof hoursSource.end === "string"
      ? {
          off: hoursSource.off === true,
          days: hoursSource.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6),
          start: hoursSource.start,
          end: hoursSource.end,
        }
      : null;
  const plan = source.plan ? cleanResponse(source.plan) : null;
  return {
    mode: source.mode === "manual" ? "manual" : "auto",
    hours,
    activities,
    freeTime: typeof source.freeTime === "boolean" ? source.freeTime : null,
    plan: plan && plan.blocks.length ? plan : null,
    tweaks: Number.isInteger(source.tweaks) ? Math.min(MAX_TWEAKS, Math.max(0, Number(source.tweaks))) : 0,
    saved: source.saved === true,
  };
}

/* ------------------------------------------------------------- the plan */

export function toneFor(name: string, activities: PlanActivity[]): Tone {
  if (name.toLocaleLowerCase() === FREE_TIME.toLocaleLowerCase()) return "mint";
  const index = activities.findIndex((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (index >= 0) return TONES[index % TONES.length];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

/**
 * The plan as schedule entries: fixed hours first, then one group per
 * (activity, start, end) with every day it falls on. Each group becomes one
 * weekly entry per day. Free time is saved too (as "Free time"), but its
 * groups are marked so the Lock-in step never offers them.
 */
export function planGroups(plan: PlanWeekResponse, busy: Busy | null, stage: LifeStage | null, activities: PlanActivity[]): BlockSpec[] {
  const groups: BlockSpec[] = [];
  if (busy) {
    groups.push({
      template: stage === "working" ? "work" : "college",
      name: busy.label,
      emoji: stage === "working" ? "💼" : stage === "school" ? "🎒" : "🎓",
      tone: "sky",
      kind: stage === "working" ? "ROUTINE" : "COLLEGE",
      days: busy.days,
      start: busy.start,
      end: busy.end,
    });
  }
  const byKey = new Map<string, BlockSpec>();
  for (const block of [...plan.blocks].sort((a, b) => a.day - b.day || minutesOf(a.start) - minutesOf(b.start))) {
    const name = block.free ? FREE_TIME : block.activity;
    const key = `${block.free ? "free" : "plan"}|${name.toLocaleLowerCase()}|${block.start}|${block.end}`;
    let group = byKey.get(key);
    if (!group) {
      group = block.free
        ? { template: "free", name: FREE_TIME, emoji: emojiFor(FREE_TIME), tone: "mint", kind: "ROUTINE", days: [], start: block.start, end: block.end }
        : { template: "planned", name, emoji: emojiFor(name), tone: toneFor(name, activities), kind: "ROUTINE", days: [], start: block.start, end: block.end };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.days.includes(block.day)) group.days.push(block.day);
  }
  return groups;
}

/** Same entry, for matching what is already saved. */
export function groupKey(spec: { name: string; kind: string; start: string; end: string }): string {
  return `${spec.name.toLocaleLowerCase()}|${spec.kind}|${spec.start}|${spec.end}`;
}

function minutesLong(block: PlannedBlock): number {
  const length = minutesOf(block.end) - minutesOf(block.start);
  return length <= 0 ? length + 1440 : length;
}

/** Per-activity totals (free time left out): the planner's numbers, or counted. */
export function activityTotals(plan: PlanWeekResponse): Array<{ activity: string; timesPerWeek: number; minutesPerSession: number }> {
  const counted = new Map<string, { activity: string; count: number; minutes: number }>();
  for (const block of plan.blocks) {
    if (block.free) continue;
    const key = block.activity.toLocaleLowerCase();
    const entry = counted.get(key) ?? { activity: block.activity, count: 0, minutes: 0 };
    entry.count += 1;
    entry.minutes += minutesLong(block);
    counted.set(key, entry);
  }
  return [...counted.values()].map((entry) => {
    const reported = plan.perActivity.find((item) => item.activity.toLocaleLowerCase() === entry.activity.toLocaleLowerCase());
    return {
      activity: entry.activity,
      timesPerWeek: reported?.timesPerWeek || entry.count,
      minutesPerSession: reported?.minutesPerSession || Math.round(entry.minutes / entry.count),
    };
  });
}

/** How much free time the plan leaves: blocks and hours per week. */
export function freeTotals(plan: PlanWeekResponse): { blocks: number; hours: number } {
  const free = plan.blocks.filter((block) => block.free);
  const minutes = free.reduce((sum, block) => sum + minutesLong(block), 0);
  return { blocks: free.length, hours: Math.round((minutes / 60) * 10) / 10 };
}
