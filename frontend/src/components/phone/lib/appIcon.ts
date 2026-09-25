/**
 * The launcher icon, switchable from the app (Settings → Design lab).
 *
 * On Android, `MainActivity` attaches `window.JarvisAppIcon`, which enables
 * one launcher alias per icon (see `JarvisAppIcon.kt`). Anywhere else the
 * bridge is absent and the choice is only a preview.
 */

export type AppIconId = "classic" | "holo" | "orb" | "bubble";

export const APP_ICONS: Array<{ id: AppIconId; name: string; hint: string; src: string }> = [
  { id: "classic", name: "Classic", hint: "The icon you have now", src: "/brand/icon-classic.png" },
  { id: "holo", name: "HOLO face", hint: "The voice mascot, glowing", src: "/brand/icon-holo.webp" },
  { id: "orb", name: "Candy spark", hint: "An AI spark in a candy marble", src: "/brand/icon-orb.webp" },
  { id: "bubble", name: "Talk & done", hint: "Say it and it gets done", src: "/brand/icon-bubble.webp" },
];

interface AppIconBridge {
  current(): string;
  set(name: string): boolean;
}

function bridge(): AppIconBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { JarvisAppIcon?: AppIconBridge }).JarvisAppIcon ?? null;
}

/** True inside the Android app, where the launcher icon can really change. */
export function canSwitchAppIcon(): boolean {
  return bridge() !== null;
}

/** The icon the launcher shows now, or null outside the Android app. */
export function currentAppIcon(): AppIconId | null {
  try {
    const value = bridge()?.current();
    return APP_ICONS.some((icon) => icon.id === value) ? (value as AppIconId) : null;
  } catch {
    return null;
  }
}

/** Put `id` on the launcher. False if it could not be switched. */
export function setAppIcon(id: AppIconId): boolean {
  try {
    return bridge()?.set(id) === true;
  } catch {
    return false;
  }
}
