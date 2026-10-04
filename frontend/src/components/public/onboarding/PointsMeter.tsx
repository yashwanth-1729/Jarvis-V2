"use client";

import * as React from "react";

import { emitFx } from "@/components/phone/fx/fxBus";
import { haptic } from "@/components/phone/lib/haptics";
import { POINTS_MAX, POINTS_MIN } from "./planWeek";

const STOPS = Array.from({ length: POINTS_MAX }, (_, index) => index + 1);
const KEY_STEPS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2 };

export function pointsLabel(value: number): string {
  return value >= POINTS_MAX ? "MAX" : String(value);
}

/**
 * How much of the week something gets: a segmented meter with 11 stops,
 * 1-10 and then MAX. Drag along it or tap a segment; the arrow keys, Page
 * Up/Down, Home and End work too (it is a `role="slider"`). Every new stop
 * ticks a haptic, and MAX glows hot red.
 *
 * Touch: a sideways drag sets the value while an up-or-down swipe still
 * scrolls the page (`touch-action: pan-y`), and a tap sets it where it lands.
 * The fill is CSS on transform and opacity only.
 */
export function PointsMeter({ value, onChange, onCommit, label, tone }: {
  value: number;
  onChange: (value: number) => void;
  /** When a drag, tap or run of key presses settles. */
  onCommit?: (value: number) => void;
  /** What it measures, for screen readers. */
  label: string;
  tone: string;
}) {
  const track = React.useRef<HTMLDivElement>(null);
  const current = React.useRef(value);
  const gesture = React.useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const settle = React.useRef<number>();

  React.useEffect(() => {
    current.current = value;
  }, [value]);
  React.useEffect(() => () => window.clearTimeout(settle.current), []);

  const valueAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return current.current;
    const ratio = (clientX - box.left) / box.width;
    return Math.min(POINTS_MAX, Math.max(POINTS_MIN, Math.ceil(ratio * POINTS_MAX)));
  };

  const set = (next: number) => {
    if (next === current.current) return;
    current.current = next;
    haptic(next === POINTS_MAX ? "heavy" : "select", false);
    onChange(next);
  };

  const commit = () => {
    window.clearTimeout(settle.current);
    emitFx(current.current === POINTS_MAX ? "heavy" : "select", track.current);
    onCommit?.(current.current);
  };

  const max = value >= POINTS_MAX;
  return (
    <div className="ob-meter" data-tone={tone} data-max={max || undefined}>
      <div
        ref={track}
        className="ob-meter-track"
        role="slider"
        tabIndex={0}
        aria-label={`How much of your week ${label} gets`}
        aria-valuemin={POINTS_MIN}
        aria-valuemax={POINTS_MAX}
        aria-valuenow={value}
        aria-valuetext={max ? "MAX" : `${value} of 10`}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          const touch = event.pointerType === "touch";
          gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: !touch };
          // Mouse and pen set at once; a finger waits to see if it is a scroll.
          if (!touch) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // An unknown pointer can't be captured; the drag still works over the track.
            }
            set(valueAt(event.clientX));
          }
        }}
        onPointerMove={(event) => {
          const live = gesture.current;
          if (!live || live.id !== event.pointerId) return;
          if (!live.dragging) {
            const dx = Math.abs(event.clientX - live.x);
            const dy = Math.abs(event.clientY - live.y);
            if (dx < 6 || dx < dy) return;
            live.dragging = true;
          }
          set(valueAt(event.clientX));
        }}
        onPointerUp={(event) => {
          const live = gesture.current;
          if (!live || live.id !== event.pointerId) return;
          gesture.current = null;
          if (!live.dragging) set(valueAt(event.clientX));
          commit();
        }}
        onPointerCancel={() => {
          // The page took the gesture (a scroll): keep whatever a drag reached.
          const live = gesture.current;
          gesture.current = null;
          if (live?.dragging) commit();
        }}
        onKeyDown={(event) => {
          const step = KEY_STEPS[event.key];
          const next = step ? current.current + step : event.key === "Home" ? POINTS_MIN : event.key === "End" ? POINTS_MAX : null;
          if (next === null) return;
          event.preventDefault();
          set(Math.min(POINTS_MAX, Math.max(POINTS_MIN, next)));
          window.clearTimeout(settle.current);
          settle.current = window.setTimeout(commit, 500);
        }}
      >
        {STOPS.map((stop) => (
          <span
            key={stop}
            className="ob-meter-seg"
            data-on={stop <= value || undefined}
            data-top={stop === value || undefined}
            data-max-stop={stop === POINTS_MAX || undefined}
            style={{ "--k": stop } as React.CSSProperties}
          />
        ))}
      </div>
      <strong key={pointsLabel(value)} className="ob-meter-value" aria-hidden="true">
        {pointsLabel(value)}
      </strong>
    </div>
  );
}
