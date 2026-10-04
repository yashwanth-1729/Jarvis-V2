/**
 * Everything the onboarding says and offers: the options on each screen and
 * HOLO's lines. Kept apart from the components so the copy can be tuned
 * without touching layout or logic.
 *
 * Stored values are plain labels (no emoji): the backend folds them into the
 * assistant's persona (backend/app/services/profile.py), which trims each to
 * 40-60 characters.
 */
import type { Chronotype, Gender, LanguagePref, LifeStage, Vibe } from "@/lib/profile";

export type Tone = "lime" | "sky" | "lilac" | "pink" | "orange" | "mint" | "amber" | "red";

/**
 * Who HOLO is talking to. "her" (she picked "A girl") swaps any gendered word
 * (bro, boss, king, dude) for warm best-friend energy; the options themselves
 * (interests, goals) never change with it. Everyone else keeps today's copy.
 */
export type Persona = "her" | null;

export function personaOf(gender: Gender | null | undefined): Persona {
  return gender === "female" ? "her" : null;
}

/** HOLO's expressions (see Holo.tsx). */
export type Mood =
  | "idle"
  | "happy"
  | "excited"
  | "love"
  | "wow"
  | "smirk"
  | "cool"
  | "calm"
  | "think"
  | "fierce"
  | "oops"
  | "sleepy";

export const TONES: Tone[] = ["lime", "pink", "sky", "orange", "lilac", "mint", "amber"];

/* ------------------------------------------------------------------ vibe */

export interface VibeOption {
  value: Vibe;
  title: string;
  emoji: string;
  tone: Tone;
  tag: string;
  sample: string;
  reaction: string;
  mood: Mood;
}

export const VIBES: VibeOption[] = [
  {
    value: "hype",
    title: "Hype friend",
    emoji: "🔥",
    tone: "pink",
    tag: "Loud",
    sample: "Three tasks before lunch?? You're on a different level today. LET'S GOOO.",
    reaction: "Say less. Your loudest fan, reporting for duty.",
    mood: "excited",
  },
  {
    value: "coach",
    title: "Strict coach",
    emoji: "📣",
    tone: "orange",
    tag: "No excuses",
    sample: "You said gym at 6. It's 6:10. Shoes on. Now.",
    reaction: "Good. I don't do excuses. Neither do you, now.",
    mood: "fierce",
  },
  {
    value: "chill",
    title: "Chill bro",
    emoji: "😎",
    tone: "sky",
    tag: "No pressure",
    sample: "Small win's still a win. Knock out one thing, then chill. Deal?",
    reaction: "Easy. We go at your pace.",
    mood: "cool",
  },
  {
    value: "monk",
    title: "Calm monk",
    emoji: "🧘",
    tone: "mint",
    tag: "Zen",
    sample: "Breathe. One task. Just this one. The rest can wait.",
    reaction: "Peace mode on. One thing at a time.",
    mood: "calm",
  },
];

/* ----------------------------------------------------------------- stage */

export interface StageOption {
  value: LifeStage;
  title: string;
  emoji: string;
  line: string;
  tone: Tone;
  reaction: string;
  mood: Mood;
}

export const STAGES: StageOption[] = [
  { value: "school", title: "School", emoji: "🎒", line: "Homework, tuition, all of it", tone: "sky", reaction: "School mode. Homework doesn't stand a chance.", mood: "happy" },
  { value: "college", title: "College", emoji: "🎓", line: "Lectures, labs, last-minute everything", tone: "lilac", reaction: "College. Attendance, assignments, chaos. I got you.", mood: "excited" },
  { value: "working", title: "Working", emoji: "💼", line: "9 to 5 (ish)", tone: "orange", reaction: "Working life. Let's protect your evenings.", mood: "smirk" },
  { value: "creator", title: "Creator", emoji: "🎬", line: "Content is the job", tone: "pink", reaction: "A creator! I'll guard your posting schedule.", mood: "love" },
  { value: "exam", title: "Exam grind", emoji: "📚", line: "Prepping for the big one", tone: "lime", reaction: "Exam grind. Okay, we're getting serious.", mood: "fierce" },
];

/** `her` is the line for the "her" persona where the usual one won't do. */
export const EXAMS: Array<{ value: string; reaction: string; her?: string }> = [
  { value: "JEE", reaction: "JEE? Physics won't know what hit it." },
  { value: "NEET", reaction: "NEET. Future doctor, noted. 🩺" },
  { value: "UPSC", reaction: "UPSC. The final boss of exams. Respect.", her: "UPSC. The toughest exam there is. Respect." },
  { value: "GATE", reaction: "GATE. Let's go get that rank." },
  { value: "CAT", reaction: "CAT. 99 percentile energy." },
  { value: "Other", reaction: "Name it. We'll crush it." },
];

/* ------------------------------------------------------------- interests */

export interface InterestOption {
  label: string;
  emoji: string;
  reaction?: string;
}

export const INTERESTS: InterestOption[] = [
  { label: "Cricket", emoji: "🏏", reaction: "Cricket! Nothing gets scheduled during a last-over chase." },
  { label: "Anime", emoji: "🍥", reaction: "Anime fan. \"One more episode\" is not a plan though 👀" },
  { label: "Gaming", emoji: "🎮", reaction: "A gamer. Your day's about to become a quest." },
  { label: "Coding", emoji: "💻", reaction: "A coder! We're going to get along." },
  { label: "Tollywood", emoji: "🎬", reaction: "Tollywood! First day, first show energy." },
  { label: "Bollywood", emoji: "🍿", reaction: "Bollywood! Dramatic entrances encouraged." },
  { label: "Music", emoji: "🎧", reaction: "Music. Focus playlists, incoming." },
  { label: "Gym", emoji: "🏋️", reaction: "Gym! Leg day is not optional." },
  { label: "Startups", emoji: "🚀", reaction: "Startups. Founder mode: loading…" },
  { label: "AI", emoji: "🤖", reaction: "AI? Well… thank you. 🤖" },
  { label: "Fashion", emoji: "👟", reaction: "Fashion. Fit check, daily." },
  { label: "Travel", emoji: "✈️", reaction: "Travel. I'll help you plan the escape." },
  { label: "Food", emoji: "🍜", reaction: "Food. Biryani is a personality, honestly." },
  { label: "Football", emoji: "⚽" },
  { label: "K-drama", emoji: "💜", reaction: "K-drama. Tissues on standby." },
  { label: "Memes", emoji: "😂", reaction: "Memes. Fluent, I see." },
  { label: "Photography", emoji: "📸" },
  { label: "Art & design", emoji: "🎨" },
  { label: "Books", emoji: "📖" },
  { label: "Finance", emoji: "📈" },
  { label: "Cars & bikes", emoji: "🏍️" },
  { label: "Science", emoji: "🔭" },
  { label: "Yoga", emoji: "🧘" },
];

export const INTEREST_LIMIT = 12;

export const NICE: string[] = ["Good taste.", "Ooh, nice.", "Noted ✓", "Respect.", "Love that.", "Same, honestly."];

/* ----------------------------------------------------------------- goals */

export interface GoalOption {
  label: string;
  emoji: string;
}

const COMMON_GOALS: GoalOption[] = [
  { label: "Get fit", emoji: "💪" },
  { label: "Build a side project", emoji: "🛠️" },
  { label: "Learn to code", emoji: "💻" },
  { label: "Read 12 books", emoji: "📖" },
  { label: "Fix my sleep", emoji: "😴" },
  { label: "Less screen time", emoji: "📵" },
  { label: "Save money", emoji: "💰" },
  { label: "Learn a new skill", emoji: "✨" },
  { label: "Start a business", emoji: "🚀" },
  { label: "Stress less", emoji: "🫶" },
  { label: "Learn a language", emoji: "🗣️" },
];

export function goalOptions(stage: LifeStage | null, exam: string | null): GoalOption[] {
  const first: GoalOption[] =
    stage === "exam"
      ? [
          { label: exam && exam !== "Other" ? `Crack ${exam}` : "Crack my exam", emoji: "🎯" },
          { label: "Finish the syllabus", emoji: "📚" },
          { label: "A mock test every week", emoji: "📝" },
        ]
      : stage === "college"
        ? [
            { label: "Top my semester", emoji: "🏆" },
            { label: "Land an internship", emoji: "💼" },
            { label: "Get placed", emoji: "🎓" },
          ]
        : stage === "school"
          ? [
              { label: "Ace my boards", emoji: "🏆" },
              { label: "Get into a top college", emoji: "🎓" },
            ]
          : stage === "working"
            ? [
                { label: "Get promoted", emoji: "📈" },
                { label: "Switch to a better job", emoji: "🔁" },
                { label: "Leave work at work", emoji: "🏠" },
              ]
            : stage === "creator"
              ? [
                  { label: "Grow my channel", emoji: "📈" },
                  { label: "Post consistently", emoji: "📅" },
                  { label: "Land a brand deal", emoji: "🤝" },
                ]
              : [];
  return [...first, ...COMMON_GOALS];
}

export const GOAL_LIMIT = 3;
export const GOAL_REACTIONS = ["Locked in. 1 of 3.", "Two down. One more?", "That's the list. Let's make it happen."];

/* ----------------------------------------------------------------- enemy */

export interface EnemyOption {
  value: string;
  title: string;
  emoji: string;
  line: string;
  tone: Tone;
  reaction: string;
  mood: Mood;
  /** The character-card title earned by beating it. */
  slayer: string;
}

export const ENEMIES: EnemyOption[] = [
  { value: "reels", title: "Reels", emoji: "📱", line: "\"One more\" at 2 a.m.", tone: "pink", reaction: "The infinite scroll. Classic villain. I'll call it out, nicely.", mood: "smirk", slayer: "Reel Slayer" },
  { value: "sleep", title: "Sleep", emoji: "😴", line: "Snooze ×7", tone: "lilac", reaction: "Sleep's a mess? We'll fix it gently. No 5 a.m. club, promise.", mood: "sleepy", slayer: "Snooze Slayer" },
  { value: "procrastination", title: "Procrastination", emoji: "🐌", line: "\"I'll start at :00\"", tone: "orange", reaction: "Starting at :00, huh? We start now. Small.", mood: "think", slayer: "Deadline Ninja" },
  { value: "overthinking", title: "Overthinking", emoji: "🌀", line: "4 hours planning, 0 doing", tone: "sky", reaction: "Overthinker. I'll only ever show you the next step.", mood: "calm", slayer: "Overthink Tamer" },
  { value: "no plan", title: "No plan", emoji: "🗺️", line: "Wake up, vibe, panic", tone: "amber", reaction: "No plan? That's literally my job.", mood: "excited", slayer: "Chaos Tamer" },
];

/* ---------------------------------------------------------------- rhythm */

export const CHRONOTYPES: Array<{ value: Chronotype; title: string; emoji: string; line: string; tone: Tone; reaction: string; mood: Mood }> = [
  { value: "early", title: "Early bird", emoji: "🌅", line: "Best brain before noon", tone: "amber", reaction: "Early bird. Mornings are your superpower.", mood: "happy" },
  { value: "night", title: "Night owl", emoji: "🦉", line: "Wakes up when the world sleeps", tone: "lilac", reaction: "Night owl. I'll keep the big stuff for later in the day.", mood: "cool" },
];

/* -------------------------------------------------------------- language */

export const LANGUAGES: Array<{ value: LanguagePref; title: string; native: string; sample: string; tone: Tone; reaction: string; mood: Mood }> = [
  { value: "en", title: "English", native: "English", sample: "Let's get it done.", tone: "sky", reaction: "English it is. Clean and simple.", mood: "happy" },
  { value: "te", title: "Telugu", native: "తెలుగు", sample: "పదండి, మొదలుపెడదాం!", tone: "pink", reaction: "తెలుగు! Typing works on every plan. The voice is a Main Character perk.", mood: "love" },
  { value: "hinglish", title: "Hinglish", native: "Hinglish", sample: "Chal, kaam shuru karte hain!", tone: "orange", reaction: "Hinglish! Ekdum sahi choice.", mood: "excited" },
];

/* ---------------------------------------------------------- notifications */

const VIBE_PINGS: Record<Vibe, (what: string, call: string) => string> = {
  hype: (what, call) => `${what} in 10! Let's GOOO, ${call} 🔥`,
  coach: (what, call) => `${what} in 10. Up, ${call}. No excuses.`,
  chill: (what, call) => `${what} in 10, ${call}. Easy does it.`,
  monk: (what) => `${what} in 10. Breathe, stretch, begin.`,
};

const ENEMY_PINGS: Record<string, string> = {
  reels: "It's 1 a.m. The reels will still be there tomorrow. 🌙",
  sleep: "Wind-down time. Phone down in 15? 😴",
  procrastination: "Just 10 minutes on it. Then decide. ⏱️",
  overthinking: "One next step. That's all for now. 🫶",
  "no plan": "Morning! Your day, in three lines. 🗺️",
};

export function samplePings(vibe: Vibe | null, call: string, enemy: string | null, block: { name: string; emoji: string } | null): Array<{ emoji: string; text: string; when: string }> {
  const what = block?.name || "Study time";
  const pings = [
    { emoji: block?.emoji ?? "📚", text: VIBE_PINGS[vibe ?? "chill"](what, call || "legend"), when: "now" },
    { emoji: "💬", text: ENEMY_PINGS[enemy ?? "no plan"] ?? ENEMY_PINGS["no plan"], when: "11:58 pm" },
    { emoji: "🔥", text: "Day 3 streak. Don't break it now.", when: "8:00 am" },
  ];
  return pings;
}

/* -------------------------------------------------------------- reveal */

export function vibeOf(value: Vibe | null): VibeOption {
  return VIBES.find((item) => item.value === value) ?? VIBES[0];
}

/** A vibe's name as shown: "Chill bro" is "Chill bestie" for her (the stored value stays "chill"). */
export function vibeTitle(option: VibeOption, persona: Persona): string {
  return persona === "her" && option.value === "chill" ? "Chill bestie" : option.title;
}

export function characterTitle(chronotype: Chronotype | null, enemy: string | null): string {
  const owl = chronotype === "night" ? "Night Owl" : "Early Bird";
  const slayer = ENEMIES.find((item) => item.value === enemy)?.slayer ?? "Main Character";
  return `${owl} · ${slayer}`;
}

/** Days from today to an ISO date (YYYY-MM-DD), or null. */
export function daysUntil(date: string | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  const target = new Date(`${date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
