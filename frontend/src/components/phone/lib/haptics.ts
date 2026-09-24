/**
 * Touch feedback.
 *
 * On the phone the shell exposes `window.JarvisHaptics` (MainActivity), which
 * plays the system's own haptic patterns through `performHapticFeedback` — no
 * vibration permission, and it follows the user's "Touch feedback" setting.
 * Anywhere else it falls back to the Vibration API, which most desktops simply
 * ignore.
 */

export type HapticKind = "tap" | "select" | "success" | "warning" | "heavy" | "toggle-on" | "toggle-off" | "gesture";

interface HapticsBridge {
  perform(kind: string): void;
}

const FALLBACK: Record<HapticKind, number | number[]> = {
  tap: 8,
  select: 5,
  success: [10, 50, 16],
  warning: [24, 60, 24],
  heavy: 22,
  "toggle-on": 7,
  "toggle-off": 5,
  gesture: 6,
};

export function haptic(kind: HapticKind = "tap"): void {
  if (typeof window === "undefined") return;
  const bridge = (window as unknown as { JarvisHaptics?: HapticsBridge }).JarvisHaptics;
  try {
    if (bridge?.perform) {
      bridge.perform(kind);
      return;
    }
    // Browsers refuse (and log) vibration before the first real tap.
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activation && !activation.hasBeenActive) return;
    navigator.vibrate?.(FALLBACK[kind]);
  } catch {
    /* Feedback is a nicety; never let it break the action it decorates. */
  }
}
