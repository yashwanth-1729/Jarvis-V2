/**
 * "Your week, your rules": the person says what they want in their week, how
 * much each thing matters and (optionally) how often; the HOLO gateway's
 * planner (GPT-6 Luna) turns that into one timetable, and rebuilds it from
 * their feedback.
 *
 * Day numbers are 0 = Monday … 6 = Sunday on both sides: the gateway's
 * convention is the app's own `day_of_week` (types/index.ts), so nothing is
 * converted at the boundary.
 */
import { HOLO_GATEWAY_URL } from "@/lib/publicAuth";
import type { LifeStage } from "@/lib/profile";
import { TONES, type Tone } from "./content";
import { minutesOf, type BlockSpec } from "./weekPlan";

export type Frequency = "daily" | "6x" | "5x" | "4x" | "3x" | "2x" | "1x";
export type Importance = 1 | 2 | 3 | 4 | 5;
export type Phase = "morning" | "afternoon" | "evening" | "night";

export interface PlannedBlock {
  activity: string;
  day: number;
  start: string;
  end: string;
  phase: Phase;
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
  activities: Array<{ name: string; importance: Importance; frequency?: Frequency | null }>;
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
  emoji: string;
  importance: Importance;
  frequency: Frequency | null;
}

/** The week step's own state, kept in the onboarding draft. */
export interface WeekState {
  /** "manual" is the template builder (the fallback). */
  mode: "auto" | "manual";
  /** Fixed hours (school, college, work); null until first shown. */
  hours: { off: boolean; days: number[]; start: string; end: string } | null;
  activities: PlanActivity[];
  /** Goal-based picks were added once already. */
  seeded: boolean;
  plan: PlanWeekResponse | null;
  tweaks: number;
  /** The plan is in the schedule; it can no longer be rebuilt here. */
  saved: boolean;
}

export const EMPTY_WEEK: WeekState = { mode: "auto", hours: null, activities: [], seeded: false, plan: null, tweaks: 0, saved: false };
export const MAX_TWEAKS = 5;
export const MAX_ACTIVITIES = 10;

export const FREQUENCIES: Array<{ value: Frequency | null; label: string }> = [
  { value: null, label: "Auto" },
  { value: "daily", label: "Daily" },
  { value: "5x", label: "5×" },
  { value: "3x", label: "3×" },
  { value: "2x", label: "2×" },
  { value: "1x", label: "1×" },
];

/* ---------------------------------------------------------- suggestions */

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
};

const DEFAULTS = ["Gym", "Study / revision", "DSA / coding", "Reading", "Meditation", "Language practice", "Music practice", "Content creation", "Sports", "Side project", "Walk", "Journaling"];

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
  "Gaming": "Chill time",
  "Anime": "Chill time",
  "K-drama": "Chill time",
};

export function emojiFor(name: string): string {
  const key = Object.keys(EMOJI).find((item) => item.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  return key ? EMOJI[key] : "✨";
}

function unique(items: string[]): string[] {
  return items.filter((item, index) => items.indexOf(item) === index);
}

/** What their goals point at: the picks made for them up front. */
export function goalActivities(goals: string[]): string[] {
  return unique(goals.flatMap((goal) => (goal.startsWith("Crack ") ? ["Study / revision", "Mock test"] : FROM_GOAL[goal] ?? [])));
}

/** Chips to offer: from their goals, then interests, then the usual. */
export function suggestions(goals: string[], interests: string[]): string[] {
  return unique([
    ...goalActivities(goals),
    ...interests.map((interest) => FROM_INTEREST[interest]).filter((item): item is string => Boolean(item)),
    ...DEFAULTS,
  ]);
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

/** Keep only well-formed blocks; the model's output is checked, not trusted. */
function cleanResponse(data: unknown): PlanWeekResponse {
  const source = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
    .map((item) => (item && typeof item === "object" ? item : {}) as Record<string, unknown>)
    .filter((item) =>
      typeof item.activity === "string" && item.activity.trim() &&
      Number.isInteger(item.day) && Number(item.day) >= 0 && Number(item.day) <= 6 &&
      typeof item.start === "string" && CLOCK.test(item.start) &&
      typeof item.end === "string" && CLOCK.test(item.end) && item.start !== item.end,
    )
    .map((item) => ({
      activity: String(item.activity).trim().slice(0, 40),
      day: Number(item.day),
      start: String(item.start),
      end: String(item.end),
      phase: PHASES.includes(item.phase as Phase) ? (item.phase as Phase) : phaseOf(String(item.start)),
    }));
  const perActivity = (Array.isArray(source.perActivity) ? source.perActivity : [])
    .map((item) => (item && typeof item === "object" ? item : {}) as Record<string, unknown>)
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
  if (plan.blocks.length === 0) throw new PlanError("That plan came back empty. Try again?", response.status, "empty", true);
  return plan;
}

/* ------------------------------------------------------------- the plan */

export function toneFor(name: string, activities: PlanActivity[]): Tone {
  const index = activities.findIndex((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (index >= 0) return TONES[index % TONES.length];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

/**
 * The plan as schedule entries: fixed hours first, then one group per
 * (activity, start, end) with every day it falls on. Each group becomes one
 * weekly entry per day, and one row in the Lock-in step.
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
    const key = `${block.activity.toLocaleLowerCase()}|${block.start}|${block.end}`;
    let group = byKey.get(key);
    if (!group) {
      group = { template: "planned", name: block.activity, emoji: emojiFor(block.activity), tone: toneFor(block.activity, activities), kind: "ROUTINE", days: [], start: block.start, end: block.end };
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

/** Per-activity totals: the planner's own numbers, or counted from the blocks. */
export function activityTotals(plan: PlanWeekResponse): Array<{ activity: string; timesPerWeek: number; minutesPerSession: number }> {
  const counted = new Map<string, { activity: string; count: number; minutes: number }>();
  for (const block of plan.blocks) {
    const key = block.activity.toLocaleLowerCase();
    let length = minutesOf(block.end) - minutesOf(block.start);
    if (length <= 0) length += 1440;
    const entry = counted.get(key) ?? { activity: block.activity, count: 0, minutes: 0 };
    entry.count += 1;
    entry.minutes += length;
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
