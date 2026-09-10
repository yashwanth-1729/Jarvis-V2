"use client";

/**
 * The shared vocabulary for motion, so the interface moves like one thing.
 *
 * Two rules govern everything here, and both come from what the interface was
 * doing wrong rather than from taste.
 *
 * **Nothing may animate a layout property.** transform and opacity are
 * composited; width, height, top and margin are not, and animating them on a
 * phone means a layout and paint on every frame. The single sanctioned
 * exception is `grid-template-rows: 1fr -> 0fr` for collapsing a row, which is
 * the only way to close a gap without knowing the height in advance.
 *
 * **Nothing may disappear on the frame its condition flips.** `{x && <Thing/>}`
 * unmounts instantly, which is most of why the interface felt like components
 * were being swapped rather than transformed. `usePresence` below is the fix.
 */

import * as React from "react";

/** Durations, in milliseconds. Exit is deliberately shorter than enter. */
export const DUR = {
  instant: 90,
  fast: 160,
  base: 240,
  slow: 320,
  /** Leaving stays quicker than arriving, but neither is a cut. */
  exit: 340,
  /** The destructive sequence, which is allowed to take its time — once. */
  burn: 420,
} as const;

export const EASE = {
  /** The project's existing curve. New motion matches what already ships. */
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
} as const;

/**
 * Entrance delay for the item at `index`.
 *
 * The cap is the point. A cascade reads as craft over eight rows and as a slow
 * application over forty — at 34ms apiece an unbounded stagger would make a
 * long board take a second and a half to finish arriving, and the last row is
 * the one someone scrolled down to read.
 */
export function stagger(index: number, step = 34, cap = 8): number {
  return Math.min(Math.max(index, 0), cap) * step;
}

/** Honours the OS setting, and keeps honouring it if it changes mid-session. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return reduced;
}

export type PresenceState = "entering" | "present" | "leaving" | "absent";

export interface Presence<T> {
  /** The value to render — the outgoing one is held through its exit. */
  rendered: T | null;
  state: PresenceState;
}

/**
 * Keep a value mounted long enough for it to animate away.
 *
 * Without this, closing a panel is one frame of panel and one frame of nothing.
 * There is no "before" for the browser to interpolate from, so no amount of CSS
 * produces an exit — the element is simply gone.
 *
 * Interruptible by construction: a new value arriving mid-exit is adopted
 * immediately rather than queued behind the animation that is still finishing.
 * An exit that insists on completing is how an interface starts feeling like it
 * is arguing with you.
 */
export function usePresence<T>(value: T | null, exitMs: number = DUR.exit): Presence<T> {
  const reduced = useReducedMotion();
  const [rendered, setRendered] = React.useState<T | null>(value);
  const [state, setState] = React.useState<PresenceState>(value ? "present" : "absent");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const clear = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };

    if (value !== null) {
      clear();
      setRendered(value);
      setState((current) => (current === "present" ? "present" : "entering"));
      const frame = requestAnimationFrame(() => setState("present"));
      return () => cancelAnimationFrame(frame);
    }

    if (rendered === null) {
      setState("absent");
      return;
    }

    if (reduced) {
      clear();
      setRendered(null);
      setState("absent");
      return;
    }

    setState("leaving");
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setRendered(null);
      setState("absent");
    }, exitMs);

    return clear;
    // `rendered` is intentionally excluded: including it restarts the exit
    // timer every time the held value is written, and the exit never lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, exitMs, reduced]);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { rendered, state };
}

/**
 * False on the frame the dependency changes, true from the next one.
 *
 * This repository learned the need for it the hard way, and the note in
 * SurfaceHost still records it: "Animating from the same frame the element
 * appears in means the browser has no 'before' to interpolate from and the
 * transition is simply skipped." Anything transitioning on mount needs a frame
 * of the initial state first.
 */
export function useEntrance(key: unknown): boolean {
  const [entered, setEntered] = React.useState(false);

  React.useEffect(() => {
    setEntered(false);
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [key]);

  return entered;
}
