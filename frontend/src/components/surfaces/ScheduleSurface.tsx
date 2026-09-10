"use client";

/**
 * The day that was asked about. Nothing else.
 *
 * This was a scale drawing — a pixel timeline at 76px an hour, with a
 * now-marker, plus Today/Tomorrow/Thursday tabs to move between days. As a
 * page that is a reasonable thing to build. As a panel over the HUD it was
 * wrong in every dimension: taller than the space it had, so it collided with
 * the transcript underneath; and it answered "what's my schedule tomorrow"
 * with a browsable calendar, which is not an answer, it is an invitation to go
 * and find one.
 *
 * A spoken question deserves a spoken-length answer on screen: this day, these
 * blocks, in order. The tabs are gone because the question already said which
 * day, and offering to change it is offering to make the panel disagree with
 * what JARVIS just said out loud.
 */

import { MapPin } from "lucide-react";
import * as React from "react";

import { stagger } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ScheduleEvent } from "@/types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function startMinutes(event: ScheduleEvent): number | null {
  const raw = event.start_time ?? event.time_start ?? null;
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(String(raw).slice(-8).trim() || String(raw));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function endMinutes(event: ScheduleEvent): number | null {
  const raw = event.end_time ?? event.time_end ?? null;
  if (!raw) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(String(raw).slice(-8).trim() || String(raw));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${display} ${suffix}` : `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}

interface ScheduleSurfaceProps {
  today: ScheduleEvent[];
  weekly: { college: ScheduleEvent[]; routine: ScheduleEvent[]; session: ScheduleEvent[] };
  onEdit: (event: ScheduleEvent) => void;
  /**
   * Which day the question was about, as an offset from today.
   *
   * Asking "what do I have tomorrow" and being shown today is the kind of small
   * wrongness that makes an interface feel like it is not listening. The server
   * reads the day out of the user's own words; this is where it lands.
   */
  initialDay?: number;
}

export function ScheduleSurface({
  today,
  weekly,
  onEdit,
  initialDay = 0,
}: ScheduleSurfaceProps) {
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7; // JS Sunday-first -> Monday-first
  const target = (todayIndex + initialDay) % 7;

  const events = React.useMemo(() => {
    if (initialDay === 0) return today;
    return [...weekly.college, ...weekly.routine].filter((e) => e.day_of_week === target);
  }, [initialDay, today, weekly, target]);

  const ordered = React.useMemo(() => {
    const withTime = events
      .map((event) => ({ event, start: startMinutes(event) }))
      .sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9));
    return withTime;
  }, [events]);

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const label = initialDay === 0 ? "Today" : initialDay === 1 ? "Tomorrow" : DAYS[target];

  return (
    <div className="flex h-full flex-col gap-3 pt-1">
      <div className="shrink-0">
        <h3 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {label}
        </h3>
        <p className="font-mono text-2xs uppercase tracking-[0.2em] text-ink-faint">
          {DAYS[target]} · {ordered.length} {ordered.length === 1 ? "block" : "blocks"}
        </p>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm text-ink-dim">Nothing scheduled.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain">
          {ordered.map(({ event, start }, index) => {
            const end = endMinutes(event);
            // "Now" is only meaningful for today, and it is the one piece of
            // emphasis the list earns: it answers "what am I supposed to be
            // doing" without being asked a second question.
            const running =
              initialDay === 0 &&
              start !== null &&
              start <= nowMinutes &&
              (end ?? start + 60) >= nowMinutes;

            return (
              <li
                key={event.id}
                style={{ animationDelay: `${stagger(index, 30)}ms` }}
                className="animate-row-in"
              >
                <button
                  type="button"
                  onClick={() => onEdit(event)}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded-sm px-2 py-2 text-left",
                    "transition-colors duration-150 hover:bg-surface-2/50",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                    running && "bg-accent/[0.07]",
                  )}
                >
                  <span
                    className={cn(
                      "tnum w-[4.5rem] shrink-0 font-mono text-2xs",
                      running ? "text-accent" : "text-ink-faint",
                    )}
                  >
                    {start === null ? "—" : clock(start)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block break-words text-sm leading-snug",
                        running ? "text-accent" : "text-ink",
                      )}
                    >
                      {event.event_name}
                    </span>
                    {event.location && (
                      <span className="mt-0.5 flex items-center gap-1 text-2xs text-ink-faint">
                        <MapPin aria-hidden className="h-3 w-3" />
                        {event.location}
                      </span>
                    )}
                  </span>
                  {running && (
                    <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-accent">
                      now
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
