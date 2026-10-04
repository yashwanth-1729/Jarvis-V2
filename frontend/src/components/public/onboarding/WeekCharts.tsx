"use client";

/**
 * The plan, drawn (2026-10-04, the owner: "don't use bars... maybe a pie chart
 * or any good visual"):
 * - a donut of how the week splits between their own activities;
 * - one small ring per day, showing where each block sits in their waking day
 *   (wake at the top, going clockwise to sleep).
 *
 * College or work never appears, only their own time. The arcs draw in on
 * mount (framer-motion; MotionConfig turns that off for reduced motion).
 */
import * as React from "react";
import { motion } from "framer-motion";

import type { Tone } from "./content";

export interface RingSegment {
  key: string;
  /** 0..1 around the ring, starting at the top. */
  from: number;
  to: number;
  tone: Tone;
  free?: boolean;
}

export function Ring({ size, stroke, segments, gap = 0, delay = 0, children, className }: {
  size: number;
  stroke: number;
  segments: RingSegment[];
  /** Pixels left empty between neighbouring arcs. */
  gap?: number;
  delay?: number;
  children?: React.ReactNode;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const middle = size / 2;
  return (
    <span className={`ob-ring ${className ?? ""}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="ob-ring-track" cx={middle} cy={middle} r={r} strokeWidth={stroke} />
        <g transform={`rotate(-90 ${middle} ${middle})`}>
          {segments.map((segment, index) => {
            const length = Math.max(1, (segment.to - segment.from) * c - gap);
            return (
              <motion.circle
                key={segment.key}
                className="ob-ring-seg"
                data-tone={segment.free ? undefined : segment.tone}
                data-free={segment.free || undefined}
                cx={middle}
                cy={middle}
                r={r}
                strokeWidth={stroke}
                strokeDashoffset={-segment.from * c}
                initial={{ strokeDasharray: `0 ${c}` }}
                animate={{ strokeDasharray: `${length} ${c - length}` }}
                transition={{ duration: 0.75, delay: delay + index * 0.07, ease: [0.2, 0.8, 0.2, 1] }}
              />
            );
          })}
        </g>
      </svg>
      {children && <span className="ob-ring-center">{children}</span>}
    </span>
  );
}

export interface Slice {
  key: string;
  minutes: number;
  tone: Tone;
  free?: boolean;
}

/** "21h", "4h 30m", "45m". */
export function hoursText(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** How the week splits: one arc per activity, free time last and calm. */
export function WeekDonut({ slices, size = 188 }: { slices: Slice[]; size?: number }) {
  const total = slices.reduce((sum, slice) => sum + slice.minutes, 0);
  const planned = slices.filter((slice) => !slice.free).reduce((sum, slice) => sum + slice.minutes, 0);
  let cursor = 0;
  const segments: RingSegment[] = total
    ? slices.map((slice) => {
        const from = cursor;
        cursor += slice.minutes / total;
        return { key: slice.key, from, to: cursor, tone: slice.tone, free: slice.free };
      })
    : [];
  return (
    <Ring size={size} stroke={24} segments={segments} gap={slices.length > 1 ? 3 : 0} className="ob-donut">
      <b>{Math.round(planned / 30) / 2}</b>
      <small>hours a week</small>
    </Ring>
  );
}

export interface DayDial {
  index: number;
  letter: string;
  label: string;
  segments: RingSegment[];
}

/** Seven small rings, Monday first: tap one to open that day. */
export function DayDials({ days, selected, today, onSelect }: {
  days: DayDial[];
  selected: number;
  today: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="ob-dials" role="tablist" aria-label="Days">
      {days.map((day) => (
        <button
          key={day.index}
          type="button"
          role="tab"
          aria-selected={selected === day.index}
          aria-label={day.label}
          className="ob-dial"
          data-on={selected === day.index || undefined}
          data-today={today === day.index || undefined}
          onClick={() => onSelect(day.index)}
        >
          <Ring size={42} stroke={6} segments={day.segments} gap={1.5} delay={0.15 + day.index * 0.05} />
          <span className="ob-dial-day">{day.letter}</span>
        </button>
      ))}
    </div>
  );
}
