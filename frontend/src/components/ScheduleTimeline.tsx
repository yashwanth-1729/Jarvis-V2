"use client";

import { CalendarRange, MapPin, Pencil, StickyNote } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatTime, groupByDay, parseLocal, relativeLabel } from "@/lib/utils";
import type { ScheduleEvent } from "@/types";

/** An event is "live" between its start and end (or for 60 min if open-ended). */
function isInProgress(event: ScheduleEvent): boolean {
  const start = parseLocal(event.time_start);
  if (!start) return false;
  const end = parseLocal(event.time_end) ?? new Date(start.getTime() + 3_600_000);
  const now = Date.now();
  return start.getTime() <= now && now <= end.getTime();
}

function isPast(event: ScheduleEvent): boolean {
  const start = parseLocal(event.time_start);
  const end = parseLocal(event.time_end) ?? start;
  return end !== null && end.getTime() < Date.now();
}

/**
 * One-off sessions on a chronological timeline. Recurring entries have no date
 * and are rendered by `ScheduleBoard` under their weekday instead, so anything
 * without a `time_start` is filtered out here rather than guessed at.
 */
export function ScheduleTimeline({
  events,
  onEdit,
}: {
  events: ScheduleEvent[];
  onEdit?: (event: ScheduleEvent) => void;
}) {
  const dated = React.useMemo(
    () =>
      events.filter(
        (event): event is ScheduleEvent & { time_start: string } =>
          typeof event.time_start === "string" && event.time_start.length > 0,
      ),
    [events],
  );
  const days = React.useMemo(() => groupByDay(dated), [dated]);

  if (!dated.length) {
    return (
      <div className="p-5">
        <EmptyState
          icon={<CalendarRange className="h-4 w-4" />}
          title="Nothing booked"
          hint='Try: "Block Thursday 14:00–15:00 for the design review"'
        />
      </div>
    );
  }

  return (
    // The page owns scrolling; keep dates and their entries together.
    <div className="schedule-days px-4 py-4">
      <div className="space-y-7">
        {days.map((day) => (
          <section key={day.key}>
            <div className="schedule-day-heading mb-3 flex items-baseline gap-3 py-1.5">
              <h3 className="font-display text-md font-semibold tracking-tight text-ink">
                {day.heading}
              </h3>
              <span className="tnum font-mono text-2xs text-ink-faint">
                {String(day.items.length).padStart(2, "0")}{" "}
                {day.items.length === 1 ? "event" : "events"}
              </span>
              <span aria-hidden className="ml-1 h-px flex-1 bg-line" />
            </div>

            <ol className="schedule-list space-y-px">
              {day.items.map((event) => {
                const live = isInProgress(event);
                const past = !live && isPast(event);

                return (
                  <li
                    key={event.id}
                    className={cn(
                      "schedule-card group relative grid grid-cols-[56px_1fr] gap-4 rounded py-2.5 pl-3 pr-3",
                      "transition-colors duration-150 hover:bg-surface-2/60",
                      past && "opacity-50",
                    )}
                  >
                    {/* Time gutter, monospaced so the column never jitters. */}
                    <div className="relative text-right">
                      <span
                        className={cn(
                          "schedule-start tnum block font-mono text-sm leading-tight",
                          live ? "text-accent" : "text-ink",
                        )}
                      >
                        {formatTime(event.time_start)}
                      </span>
                      {event.time_end && (
                        <span className="schedule-end tnum block font-mono text-2xs leading-tight text-ink-faint">
                          {formatTime(event.time_end)}
                        </span>
                      )}
                    </div>

                    {/* Spine + node */}
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[68px] top-0 hidden w-px bg-line group-last:bottom-1/2 lg:block"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-[65px] top-[13px] hidden h-[7px] w-[7px] rounded-full ring-4 ring-surface-0 lg:block",
                        live
                          ? "animate-breathe bg-accent"
                          : past
                            ? "bg-line-strong"
                            : "bg-ink-faint",
                      )}
                    />

                    <div className="min-w-0 lg:pl-5">
                      <div className="flex flex-wrap items-start gap-2">
                        {onEdit ? (
                          <button
                            type="button"
                            onClick={() => onEdit(event)}
                            title="Edit"
                            className={cn(
                              "schedule-title min-w-0 flex-1 break-words text-left text-base font-medium leading-snug text-ink",
                              "rounded-sm transition-colors duration-150 hover:text-accent",
                              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                            )}
                          >
                            {event.event_name}
                          </button>
                        ) : (
                          <p className="break-words text-base font-medium leading-snug text-ink">
                            {event.event_name}
                          </p>
                        )}
                        {onEdit && <button type="button" onClick={() => onEdit(event)} aria-label={`Edit ${event.event_name}`}
                          className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-dim hover:bg-surface-3 hover:text-accent lg:hidden">
                          <Pencil className="h-4 w-4" />
                        </button>}
                        {live && <Badge tone="accent">Now</Badge>}
                        {!live && !past && (
                          <span className="tnum font-mono text-2xs text-ink-faint">
                            {relativeLabel(event.time_start)}
                          </span>
                        )}
                      </div>

                      {(event.location || event.notes) && (
                        <div className="mt-1 flex flex-col gap-0.5">
                          {event.location && (
                            <p className="flex items-center gap-1.5 text-sm text-ink-dim">
                              <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                              <span className="break-words">{event.location}</span>
                            </p>
                          )}
                          {event.notes && (
                            <p className="flex items-start gap-1.5 text-sm text-ink-faint">
                              <StickyNote
                                className="mt-[3px] h-3 w-3 shrink-0"
                                strokeWidth={1.75}
                              />
                              <span className="break-words">{event.notes}</span>
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
