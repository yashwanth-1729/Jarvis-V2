"use client";

import * as React from "react";

/**
 * The CSS orb: an iridescent marble for the dock, the chat header and the
 * moment voice mode flies open. Its colours turn (transform only) while the
 * highlight stays put, which is what makes it read as a sphere rather than a
 * spinning disc. The WebGL orb takes over inside voice mode.
 */
export function Orb({ size, state = "idle", className }: { size: number; state?: string; className?: string }) {
  return (
    <span className={`ph-orb ${className ?? ""}`} data-state={state} style={{ width: size, height: size }} aria-hidden="true">
      <span className="ph-orb-swirl" />
      <span className="ph-orb-blob ph-orb-blob-a" />
      <span className="ph-orb-blob ph-orb-blob-b" />
      <span className="ph-orb-shine" />
    </span>
  );
}
