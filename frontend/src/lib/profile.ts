/**
 * The public edition's onboarding answers ("create your character",
 * docs/public-edition.md). Kept on the device (localStorage) and handed to the
 * backend, which folds a short summary into the assistant's persona so the
 * vibe, name and goals shape every reply.
 */
import { API_BASE } from "@/lib/api";

export type Vibe = "hype" | "coach" | "chill" | "monk";
export type LifeStage = "school" | "college" | "working" | "creator" | "exam";
export type Chronotype = "early" | "night";
export type LanguagePref = "en" | "te" | "hinglish";
/** Asked first in onboarding; null is "Rather not say". */
export type Gender = "female" | "male";

export interface OnboardingProfile {
  /**
   * "female" switches the public app to the "her" persona (copy, a pink-to-lilac
   * accent, notification lines); absent or null keeps today's defaults.
   */
  gender?: Gender | null;
  /** Their name, as typed. */
  name: string;
  /** What the assistant should call them (nickname); defaults to name. */
  callMe: string;
  vibe: Vibe;
  stage: LifeStage;
  /** JEE, NEET, UPSC, GATE, CAT... when stage is "exam". */
  exam?: string | null;
  /** ISO date of the exam, if they gave one. */
  examDate?: string | null;
  interests: string[];
  /** Up to three. */
  goals: string[];
  /** What wrecks their day: reels, sleep, procrastination, overthinking, no plan. */
  enemy: string;
  /** "HH:MM", 24-hour. */
  wake: string;
  sleep: string;
  chronotype: Chronotype;
  language: LanguagePref;
  /** They picked must-do blocks and want the free 3-day Lock-in trial. */
  wantsLockinTrial: boolean;
  /** ISO timestamp when onboarding finished. */
  completedAt: string;
}

const KEY = "jarvis.public.profile";

export function loadProfile(): OnboardingProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OnboardingProfile) : null;
  } catch {
    return null;
  }
}

export function saveProfileLocal(profile: OnboardingProfile): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Private mode or a full store: onboarding still finishes; the backend copy remains.
  }
}

/** Hand the profile to the backend (persona); never throws. */
export async function pushProfile(profile: OnboardingProfile): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile),
    });
    return response.ok;
  } catch {
    return false;
  }
}
