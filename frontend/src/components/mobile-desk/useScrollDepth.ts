"use client";

import * as React from "react";

/**
 * Publishes how far the live page is scrolled, as `--scroll-depth` (0 to 1) on
 * the shell.
 *
 * Gives the header something real to react to -- the iOS large-title collapse
 * -- instead of a static bar. Written from a passive listener on an animation
 * frame, so scrolling never waits on React, and only transform/opacity read it.
 */
export function useScrollDepth(shellRef: React.RefObject<HTMLElement | null>, distance = 72) {
  React.useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    let last = -1;

    const write = (value: number) => {
      const depth = Math.max(0, Math.min(1, value / distance));
      // Two decimals is below the eye's threshold here and keeps the style
      // recalculation from running on every pixel of a flick.
      const rounded = Math.round(depth * 100) / 100;
      if (rounded === last) return;
      last = rounded;
      shell.style.setProperty("--scroll-depth", String(rounded));
      shell.dataset.scrolled = rounded > 0.02 ? "true" : "false";
    };

    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.classList?.contains("pocket-page") && !target?.classList?.contains("pocket-content")) return;
      if (target.getAttribute("aria-hidden") === "true") return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        write(target.scrollTop);
      });
    };

    // Capture: each page is its own scroller, and scroll does not bubble.
    shell.addEventListener("scroll", onScroll, { capture: true, passive: true });
    write(0);
    return () => {
      shell.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [shellRef, distance]);
}
