"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { VoiceSessionState } from "@/types";

/**
 * The flat instrument layer that sits over the 3D core: tick rings, rotating
 * dashed arcs, corner telemetry and a live level meter.
 *
 * Deliberately SVG/CSS rather than more three.js — these are crisp 2D
 * graphics, and drawing them in the 3D scene would cost a texture and lose the
 * hairline precision that makes a HUD read as instrumentation.
 */

const TICKS = 72;

export function HudRings({ accent, level }: { accent: string; level: number }) {
  // Tick geometry never changes; recomputing 72 rotations per render is waste.
  const ticks = React.useMemo(
    () =>
      Array.from({ length: TICKS }, (_, index) => ({
        angle: (index / TICKS) * 360,
        major: index % 6 === 0,
      })),
    [],
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 h-[68vmin] w-[68vmin] -translate-x-1/2 -translate-y-1/2"
    >
      <svg viewBox="0 0 200 200" className="h-full w-full overflow-visible">
        {/* Fixed graduated ring */}
        <g style={{ color: accent }}>
          {ticks.map(({ angle, major }) => (
            <line
              key={angle}
              x1="100"
              y1={major ? 8 : 11}
              x2="100"
              y2={major ? 16 : 13.5}
              stroke="currentColor"
              strokeWidth={major ? 0.7 : 0.35}
              opacity={major ? 0.55 : 0.25}
              transform={`rotate(${angle} 100 100)`}
            />
          ))}
        </g>

        {/* Two dashed rings counter-rotating — the clearest "it is running" cue */}
        <circle
          cx="100"
          cy="100"
          r="82"
          fill="none"
          stroke={accent}
          strokeWidth="0.4"
          strokeDasharray="1 7"
          opacity="0.5"
          style={{ transformOrigin: "100px 100px", animation: "hud-spin 34s linear infinite" }}
        />
        <circle
          cx="100"
          cy="100"
          r="76"
          fill="none"
          stroke={accent}
          strokeWidth="0.5"
          strokeDasharray="26 12 4 12"
          opacity="0.42"
          style={{
            transformOrigin: "100px 100px",
            animation: "hud-spin 22s linear infinite reverse",
          }}
        />

        {/* Bracketed arcs that widen as the voice gets louder */}
        {[0, 90, 180, 270].map((angle) => (
          <path
            key={angle}
            d="M 100 28 A 72 72 0 0 1 148 46"
            fill="none"
            stroke={accent}
            strokeWidth="0.9"
            opacity={0.28 + level * 0.5}
            transform={`rotate(${angle} 100 100)`}
            style={{ transformOrigin: "100px 100px" }}
          />
        ))}
      </svg>
    </div>
  );
}

/** Corner readouts. Real values — a HUD full of fake numbers is a cartoon. */
export function HudTelemetry({
  accent,
  state,
  level,
  language,
  voice,
}: {
  accent: string;
  state: VoiceSessionState;
  level: number;
  language: string;
  voice: string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 font-mono text-2xs tracking-[0.2em] text-white/35"
    >
      <div className="absolute bottom-8 left-8 hidden space-y-1.5 md:block">
        <Readout label="Link" value={state === "idle" ? "closed" : "open"} accent={accent} />
        <Readout label="Lang" value={language} accent={accent} />
        <Readout label="Voice" value={voice} accent={accent} />
      </div>

      <div className="absolute bottom-8 right-8 hidden items-end gap-3 md:flex">
        <LevelMeter level={level} accent={accent} />
        <Readout label="Gain" value={`${Math.round(level * 100)}%`} accent={accent} />
      </div>
    </div>
  );
}

function Readout({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <p className="uppercase">
      <span className="opacity-50">{label}</span>
      <span className="mx-2 opacity-25">/</span>
      <span style={{ color: accent }}>{value}</span>
    </p>
  );
}

/** Vertical bars driven by the live microphone level. */
function LevelMeter({ level, accent }: { level: number; accent: string }) {
  const BARS = 14;
  return (
    <div className="flex h-10 items-end gap-[3px]">
      {Array.from({ length: BARS }, (_, index) => {
        // Each bar lights once the level passes its threshold, with a little
        // shaping so the meter does not move as one solid block.
        const threshold = (index + 1) / BARS;
        const lit = level >= threshold * 0.85;
        const height = 18 + index * 4;
        return (
          <span
            key={index}
            className={cn("w-[3px] rounded-sm transition-all duration-75")}
            style={{
              height: `${height}%`,
              background: lit ? accent : "rgba(255,255,255,0.12)",
              boxShadow: lit ? `0 0 8px ${accent}` : "none",
            }}
          />
        );
      })}
    </div>
  );
}
