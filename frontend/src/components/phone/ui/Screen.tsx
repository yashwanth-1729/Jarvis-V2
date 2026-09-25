"use client";

import * as React from "react";

/**
 * A scrolling page with a big title that hands over to a compact sticky bar.
 *
 * The hand-over is a CSS scroll-driven animation (`.ph-screen` names the
 * scroll timeline; the title, the bar's glass and the mini title animate
 * along it), so it runs on the compositor in lockstep with the finger and
 * scrolling never touches JavaScript at all.
 */
export function Screen({
  title,
  eyebrow,
  actions,
  leading,
  hero,
  children,
  tone = "lime",
  className,
  bottomPad = true,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  leading?: React.ReactNode;
  /** Extra content under the big title (counts, filters). */
  hero?: React.ReactNode;
  children: React.ReactNode;
  tone?: string;
  className?: string;
  /** Leave room for the dock. */
  bottomPad?: boolean;
}) {
  return (
    <div className={`ph-screen ${className ?? ""}`} data-tone={tone} data-pad={bottomPad}>
      <div className="ph-topbar">
        <div className="ph-topbar-glass" aria-hidden="true" />
        <div className="ph-topbar-lead">{leading}</div>
        <span className="ph-topbar-title" aria-hidden="true">
          {title}
        </span>
        <div className="ph-topbar-actions">{actions}</div>
      </div>
      <header className="ph-hero">
        {eyebrow && <div className="ph-eyebrow">{eyebrow}</div>}
        <h1 className="ph-title">{title}</h1>
        {hero}
      </header>
      {children}
    </div>
  );
}
