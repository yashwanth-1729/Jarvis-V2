"use client";

/**
 * Lock-in's heartbeat line: a red ECG trace that draws itself across, with a
 * glowing head, over and over. Decoration only. Still for reduced motion
 * (phone.css).
 */
import * as React from "react";

const TRACE = "M0 20 H34 L40 20 L45 6 L51 34 L57 2 L63 26 L68 20 H112 L117 20 L121 12 L126 28 L131 20 H200";

export function Pulse({ className, live = true }: { className?: string; live?: boolean }) {
  const id = React.useId().replace(/:/g, "");
  return (
    <svg className={`ph-pulse ${className ?? ""}`} data-live={live} viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`pulse-${id}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ff1f3d" stopOpacity="0" />
          <stop offset="0.35" stopColor="#ff1f3d" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff4d5e" />
        </linearGradient>
      </defs>
      <path className="ph-pulse-base" d={TRACE} />
      <path className="ph-pulse-trace" d={TRACE} stroke={`url(#pulse-${id})`} pathLength={100} />
    </svg>
  );
}
