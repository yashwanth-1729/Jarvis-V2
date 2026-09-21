"use client";

/**
 * Choreographed screen changes.
 *
 * A React state change swaps one screen for another in a single frame, which
 * is the "hard cut" feel. The View Transitions API lets the browser keep a
 * picture of the outgoing screen, so the old content can fade and settle back
 * while the new one arrives -- and any element carrying the same
 * `view-transition-name` on both sides *morphs* between its two positions,
 * which is how "Type instead" can grow into the chat panel rather than
 * replacing it.
 *
 * Everything degrades safely: without support, or under reduced motion, the
 * update simply happens immediately.
 */

type TransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => { finished: Promise<void> };
};

export function supportsTransitions(): boolean {
  return typeof document !== "undefined"
    && typeof (document as TransitionDocument).startViewTransition === "function";
}

export function withTransition(update: () => void, kind = "screen"): void {
  const doc = document as TransitionDocument;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduce) {
    update();
    return;
  }
  // The kind rides on <html> so the stylesheet can give each move its own
  // character (a screen opening is not the same gesture as going back).
  const root = document.documentElement;
  root.dataset.transition = kind;
  const transition = doc.startViewTransition(() => {
    update();
  });
  transition.finished.finally(() => {
    if (root.dataset.transition === kind) delete root.dataset.transition;
  }).catch(() => undefined);
}
