"use client";

import * as React from "react";

/**
 * HOLO's face in miniature, for the dock, the chat header and anywhere the
 * 3D mascot would be overkill. Pure CSS: an iridescent rim that turns, a
 * glass visor, eyes that blink and glance, a mouth that moves while it
 * talks. Every animation is a transform or opacity, so it costs nothing on
 * the main thread.
 */
export function HoloFace({ size, state = "idle", className }: { size: number; state?: string; className?: string }) {
  return (
    <span className={`ph-holo ${className ?? ""}`} data-state={state} data-small={size < 40} style={{ "--s": `${size}px` } as React.CSSProperties} aria-hidden="true">
      <span className="ph-holo-antenna" />
      <span className="ph-holo-head">
        <span className="ph-holo-visor">
          <i className="ph-holo-eye" />
          <i className="ph-holo-eye" />
          <i className="ph-holo-mouth" />
        </span>
      </span>
    </span>
  );
}
