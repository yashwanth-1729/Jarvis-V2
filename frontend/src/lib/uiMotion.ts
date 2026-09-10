import { flushSync } from "react-dom";
let current: { skipTransition: () => void } | null = null;

/** Snapshot only deliberate navigation. Data, audio and tools never wait on motion. */
export function transitionUi(update: () => void) {
  if (typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update(); return;
  }
  const doc = document as Document & { startViewTransition?: (callback: () => void) => { finished: Promise<void>; skipTransition: () => void } };
  if (!doc.startViewTransition) { update(); return; }
  // Native snapshots allow a real crossfade without mounting duplicate live controls.
  current?.skipTransition();
  const transition = doc.startViewTransition(() => flushSync(update));
  current = transition;
  void transition.finished.catch(() => {}).finally(() => { if (current === transition) current = null; });
}

export function prefersQuietMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
