"use client";

import * as React from "react";

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/";

/**
 * A label that decodes into its new value, left to right, whenever it
 * changes — a quick glitch rather than a hard swap. Screen readers get the
 * real text; under reduced motion it simply changes.
 */
export function Scramble({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = React.useState(text);
  React.useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text);
      return;
    }
    let step = 0;
    const steps = 12;
    const timer = window.setInterval(() => {
      step += 1;
      const settled = Math.floor((step / steps) * text.length);
      setShown(
        text
          .split("")
          .map((char, index) => (index < settled || char === " " ? char : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
          .join(""),
      );
      if (step >= steps) {
        window.clearInterval(timer);
        setShown(text);
      }
    }, 34);
    return () => window.clearInterval(timer);
  }, [text]);
  return (
    <span className={className} aria-label={text} role="status">
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}
