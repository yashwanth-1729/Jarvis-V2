/**
 * The onboarding's answers while they are being given, a resumable draft of
 * them, and the final `OnboardingProfile`.
 *
 * The draft lives in localStorage so a phone that kills the WebView mid-way
 * (a call, a trip to Settings) brings the person back to the same screen with
 * the blocks they already added, instead of creating them twice. It is
 * removed when onboarding finishes.
 */
import type { Chronotype, LanguagePref, LifeStage, OnboardingProfile, Vibe } from "@/lib/profile";
import { normalizeWeek, type WeekState } from "./planWeek";
import type { AddedBlock } from "./weekPlan";

export interface Answers {
  name: string;
  callMe: string;
  vibe: Vibe | null;
  stage: LifeStage | null;
  exam: string | null;
  /** Typed when the exam is "Other". */
  examOther: string;
  /** YYYY-MM-DD or "". */
  examDate: string;
  interests: string[];
  goals: string[];
  enemy: string | null;
  wake: string;
  sleep: string;
  chronotype: Chronotype | null;
  language: LanguagePref | null;
}

export const EMPTY: Answers = {
  name: "",
  callMe: "",
  vibe: null,
  stage: null,
  exam: null,
  examOther: "",
  examDate: "",
  interests: [],
  goals: [],
  enemy: null,
  wake: "07:00",
  sleep: "23:30",
  chronotype: null,
  language: null,
};

/**
 * The week is four calm screens before the plan (2026-10-04): hours (only
 * with school, college or work), week (the list), weight (the meters) and
 * freetime (then build). The manual builder uses "week" alone.
 */
export const STEPS = [
  "boot", "name", "vibe", "stage", "interests", "goals", "enemy", "rhythm", "language",
  "hours", "week", "weight", "freetime", "weekplan", "lockin", "notify", "reveal",
] as const;
export type StepId = (typeof STEPS)[number];

export interface Draft {
  v: 1;
  step: StepId;
  answers: Answers;
  blocks: AddedBlock[];
  /** Picked as can't-skip (block ids). */
  mustDo: string[];
  /** Schedule uids currently marked serious by this onboarding. */
  marked: string[];
  /** HOLO-built week: what they listed, points, free time, the plan, tweaks. */
  week: WeekState;
}

const KEY = "jarvis.public.onboarding.draft";

export function loadDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    if (draft.v !== 1 || !draft.step || !STEPS.includes(draft.step) || !draft.answers) return null;
    return {
      v: 1,
      step: draft.step,
      answers: { ...EMPTY, ...draft.answers },
      blocks: Array.isArray(draft.blocks) ? draft.blocks : [],
      mustDo: Array.isArray(draft.mustDo) ? draft.mustDo : [],
      marked: Array.isArray(draft.marked) ? draft.marked : [],
      // Any older shape (importance 1-5, frequency) is mapped onto points.
      week: normalizeWeek(draft.week),
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Private mode or a full store: only resuming is lost.
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

export function examName(answers: Answers): string | null {
  if (answers.stage !== "exam" || !answers.exam) return null;
  if (answers.exam === "Other") return answers.examOther.trim() || "Other";
  return answers.exam;
}

export function buildProfile(answers: Answers, wantsLockinTrial: boolean): OnboardingProfile {
  const name = answers.name.trim();
  return {
    name,
    callMe: answers.callMe.trim() || name,
    vibe: answers.vibe ?? "chill",
    stage: answers.stage ?? "college",
    exam: examName(answers),
    examDate: answers.stage === "exam" && answers.examDate ? answers.examDate : null,
    interests: answers.interests,
    goals: answers.goals.slice(0, 3),
    enemy: answers.enemy ?? "no plan",
    wake: answers.wake,
    sleep: answers.sleep,
    chronotype: answers.chronotype ?? "early",
    language: answers.language ?? "en",
    wantsLockinTrial,
    completedAt: new Date().toISOString(),
  };
}
