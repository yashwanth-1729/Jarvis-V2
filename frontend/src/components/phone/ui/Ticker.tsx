"use client";

import * as React from "react";

/**
 * A news-ticker strip. The items are drawn twice and the pair slides by half
 * its width, so the loop is seamless; the speed is set per pixel, so a long
 * brief does not race. Compositor-only (one transform animation).
 */
export function Ticker({ items }: { items: string[] }) {
  const track = React.useRef<HTMLDivElement>(null);
  const [seconds, setSeconds] = React.useState(20);
  React.useLayoutEffect(() => {
    const width = track.current?.scrollWidth ?? 0;
    if (width) setSeconds(Math.max(12, width / 2 / 36));
  }, [items]);
  const run = [...items, ...items];
  return (
    <div className="ph-ticker" aria-label={items.join(". ")} role="marquee">
      <div ref={track} className="ph-ticker-track" style={{ animationDuration: `${seconds}s` }} aria-hidden="true">
        {run.map((item, index) => (
          <span key={index} className="ph-ticker-item">
            <span className="ph-ticker-star">✦</span>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
