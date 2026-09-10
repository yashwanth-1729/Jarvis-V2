"use client";

/**
 * Text that arrives the way it was written — a word at a time, fading in.
 *
 * Note that a typed reply does not actually arrive in pieces. `incremental`
 * is off for typed turns — the provider does not apply its prefix cache to
 * streaming requests, so an unstreamed turn finishes sooner and 8,960 of its
 * tokens come from cache instead of none. The whole answer therefore lands in
 * one delta, and a word-by-word render of it would simply appear all at once.
 *
 * So the cascade is produced here rather than inherited from the network: each
 * word carries a small animation delay, and the paragraph flows in even though
 * every word of it was known before the first one appeared. That is also more
 * even than real streaming, which arrives in bursts of whatever size the
 * provider felt like sending.
 *
 * So each word is its own element, and only words that have not been seen
 * before carry the entrance animation. React keys them by index, so a word
 * already on screen keeps its finished animation state and is never replayed —
 * which is the whole trick. Without that, every delta would restart the fade
 * on the entire message and the paragraph would strobe.
 *
 * The animation itself is deliberately small: opacity plus a two-pixel rise
 * and a hint of blur, over 300ms. Enough to read as arriving, not enough to
 * make anyone wait for a word they can already see.
 *
 * Markdown is not parsed while streaming. A half-written `**bold` is not valid
 * markdown, and re-parsing the whole document on every delta to discover that
 * is both slow and visibly unstable. The finished message renders through the
 * normal markdown path; this is only for text still in flight.
 */

import * as React from "react";

import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * How long the whole cascade should take, and the most any one word may wait.
 *
 * Pacing by a fixed per-word step was the mistake: at 22ms a word, a twelve
 * word reply — which is most of them — finished in 264ms, and 264ms reads as
 * "it just appeared". The effect was working and invisible.
 *
 * So the step is derived from the length instead. A short answer spreads
 * itself across most of a second, which is long enough to watch; a long one
 * packs tighter and is capped, because a cascade that outlasts the reader's
 * patience is not an effect, it is a queue.
 */
const TARGET_MS = 900;
const MAX_STEP_MS = 90;
const MAX_TOTAL_MS = 1600;

function stepFor(count: number): number {
  if (count <= 1) return 0;
  return Math.min(MAX_STEP_MS, Math.max(28, TARGET_MS / count));
}

/** Splits on whitespace but keeps it, so spacing survives reassembly. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((piece) => piece.length > 0);
}

export function StreamedProse({ text, className }: { text: string; className?: string }) {
  const reduced = useReducedMotion();
  const tokens = React.useMemo(() => tokenize(text), [text]);

  /**
   * Which words are new — decided per *text*, not per render.
   *
   * This was recomputed on every render from a ref the effect had already
   * advanced, which meant the first re-render after mount marked every word as
   * old and React stripped `animate-word-in` off all of them. With
   * `fill-mode: both`, removing the class mid-flight snaps straight to the end
   * state, so the reply appeared instantly and the cascade was destroyed by
   * the very state that existed to enable it. Confirmed in the DOM on the
   * device: the word spans were there, with `class=""`.
   *
   * Keyed on the text instead, the answer is stable no matter how many times
   * the component re-renders while the animation is running.
   */
  const marks = React.useRef<{ text: string | null; from: number; count: number }>({
    text: null,
    from: 0,
    count: 0,
  });

  // Words only, not the whitespace between them — spacing must not dilute the
  // pace or a wide-spaced reply would cascade slower than a tight one.
  const words = tokens.filter((token) => !/^\s+$/.test(token)).length;
  if (marks.current.text !== text) {
    marks.current.from = marks.current.text === null ? 0 : marks.current.count;
    marks.current.text = text;
    marks.current.count = tokens.length;
  }
  const animateFrom = marks.current.from;
  const step = stepFor(words);

  if (reduced) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        // Whitespace carries no ink; animating it costs a wrapper element per
        // gap and shows nothing.
        if (/^\s+$/.test(token)) return token;
        const fresh = index >= animateFrom;
        return (
          <span
            key={index}
            className={cn(fresh && "animate-word-in")}
            style={
              fresh
                ? {
                    animationDelay: `${Math.min(
                      (index - animateFrom) * step,
                      MAX_TOTAL_MS,
                    )}ms`,
                  }
                : undefined
            }
          >
            {token}
          </span>
        );
      })}
    </span>
  );
}
