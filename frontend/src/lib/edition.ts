/**
 * Which app this build is: the owner's personal JARVIS, or the public edition
 * (docs/public-edition.md). Fixed at build time by NEXT_PUBLIC_JARVIS_EDITION,
 * which `scripts/build-android.mjs --public` sets.
 */
export type Edition = "personal" | "public";

export const EDITION: Edition = process.env.NEXT_PUBLIC_JARVIS_EDITION === "public" ? "public" : "personal";

export const IS_PUBLIC = EDITION === "public";

/** The app's name as users see it (the owner named the public app "JARVIS Public", 2026-10-03). */
export const BRAND = IS_PUBLIC ? "JARVIS Public" : "JARVIS";
