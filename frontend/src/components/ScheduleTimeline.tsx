"use client";

import { CalendarRange, MapPin, StickyNote } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
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

export function ScheduleTimeline({ events }: { events: ScheduleEvent[] }) {
  const days = React.useMemo(() => groupByDay(events), [events]);

  if (!events.length) {
    return (
      <div className="p-5">
        <EmptyState
          icon={<CalendarRange className="h-4 w-4" />}
          title="Nothing scheduled"
          hint='Try: "Block Thursday 14:00–15:00 for the design review"'
        />
      </div>
    );
  }

  return (
    // No edge mask here: the per-day headings below are `sticky`, and a mask on
    // the scroll container would fade them as they pin.
    <ScrollArea className="h-full min-h-0 px-5 py-4">
      <div className="space-y-7">
        {days.map((day) => (
          <section key={day.key}>
            <div className="sticky top-0 z-10 -mx-5 mb-3 flex items-baseline gap-3 bg-surface-0/90 px-5 py-1.5 backdrop-blur">
              <h3 className="font-display text-md font-semibold tracking-tight text-ink">
                {day.heading}
              </h3>
              <span className="tnum font-mono text-2xs text-ink-faint">
                {String(day.items.length).padStart(2, "0")}{" "}
                {day.items.length === 1 ? "event" : "events"}
              </span>
              <span aria-hidden className="ml-1 h-px flex-1 bg-line" />
            </div>

            <ol className="space-y-px">
              {day.items.map((event) => {
                const live = isInProgress(event);
                const past = !live && isPast(event);

                return (
                  <li
                    key={event.id}
                    className={cn(
                      "group relative grid grid-cols-[56px_1fr] gap-4 rounded py-2.5 pl-3 pr-3",
                      "transition-colors duration-150 hover:bg-surface-2/60",
                      past && "opacity-50",
                    )}
                  >
                    {/* Time gutter, monospaced so the column never jitters. */}
                    <div className="relative text-right">
                      <span
                        className={cn(
                          "tnum block font-mono text-sm leading-tight",
                          live ? "text-ember" : "text-ink",
                        )}
                      >
                        {formatTime(event.time_start)}
                      </span>
                      {event.time_end && (
                        <span className="tnum block font-mono text-2xs leading-tight text-ink-faint">
                          {formatTime(event.time_end)}
                        </span>
                      )}
                    </div>

                    {/* Spine + node */}
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[68px] top-0 w-px bg-line group-last:bottom-1/2"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-[65px] top-[13px] h-[7px] w-[7px] rounded-full ring-4 ring-surface-0",
                        live
                          ? "animate-breathe bg-ember"
                          : past
                            ? "bg-line-strong"
                            : "bg-ink-faint",
                      )}
                    />

                    <div className="min-w-0 pl-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-words text-base font-medium leading-snug text-ink">
                          {event.event_name}
                        </p>
                        {live && <Badge tone="ember">Now</Badge>}
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
    </ScrollArea>
  );
}
