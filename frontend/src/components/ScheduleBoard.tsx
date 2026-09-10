"use client";

import { CalendarRange, GraduationCap, MapPin, Pencil, Plus, Repeat, StickyNote, TriangleAlert } from "lucide-react";
import * as React from "react";

import { RecordEditor, type RecordValues } from "@/components/RecordEditor";
import { ScheduleTimeline } from "@/components/ScheduleTimeline";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { createEvent, deleteEvent, updateEvent, type RecordsMode } from "@/lib/records";
import { cn } from "@/lib/utils";
import type { GroupedSchedule, ScheduleEvent } from "@/types";
import { transitionUi } from "@/lib/uiMotion";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * The three kinds a block can be — and nothing else.
 *
 * "Today" used to sit alongside these, which put a slice of the records
 * beside three categories *of* record in the same control. One of these
 * things is not like the others, and the row read as filters rather than
 * as structure because of it.
 */
type Section = "routine" | "college" | "session";

/** JS `getDay()` is Sunday-first; the backend is Monday-first. */
function todayIndex(): number {
  return (new Date().getDay() + 6) % 7;
}

/**
 * The schedule split into the three kinds the user asked for, plus a merged
 * "today". Recurring entries have no date, so they are grouped by weekday;
 * one-off sessions keep the chronological timeline.
 */
const EVENT_FIELDS = [
  { kind: "text", name: "event_name", label: "Name", required: true,
    placeholder: "Data Structures lecture" },
  { kind: "select", name: "kind", label: "Kind", options: [
    { value: "COLLEGE", label: "Class — repeats weekly" },
    { value: "ROUTINE", label: "Routine — repeats weekly" },
    { value: "SESSION", label: "Session — one-off" },
  ] },
  { kind: "weekday", name: "day_of_week", label: "Day (weekly entries)", visibleWhen: { field: "kind", values: ["COLLEGE", "ROUTINE"] } },
  { kind: "time", name: "start_time", label: "Starts (weekly)", visibleWhen: { field: "kind", values: ["COLLEGE", "ROUTINE"] } },
  { kind: "time", name: "end_time", label: "Ends (weekly)", visibleWhen: { field: "kind", values: ["COLLEGE", "ROUTINE"] } },
  { kind: "datetime", name: "time_start", label: "Starts", required: true, visibleWhen: { field: "kind", values: ["SESSION"] } },
  { kind: "datetime", name: "time_end", label: "Ends · block clears automatically", required: true, visibleWhen: { field: "kind", values: ["SESSION"] } },
  { kind: "text", name: "location", label: "Location", placeholder: "Room C410" },
  { kind: "textarea", name: "notes", label: "Notes", rows: 2 },
] as const;

export function ScheduleBoard({
  schedule,
  today,
  mode,
  onChanged,
}: {
  schedule: GroupedSchedule;
  today: ScheduleEvent[];
  mode: RecordsMode;
  onChanged: () => void;
}) {
  const [section, setSection] = React.useState<Section>("routine");
  const [editing, setEditing] = React.useState<ScheduleEvent | "new" | null>(null);
  const current = todayIndex();

  const options = [
    { value: "routine" as const, label: "My routine", count: schedule.routine.length },
    { value: "college" as const, label: "College", count: schedule.college.length },
    { value: "session" as const, label: "Blocks", count: schedule.session.length },
  ];

  return (
    <div className="schedule-board flex flex-col">
      {/* Stays put while the page scrolls. Switching section is the one
          thing you should never have to scroll back up to reach — and it
          is opaque so rows do not ghost through it on the way past. */}
      <div className="board-toolbar sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-line bg-surface-0 px-4 py-3">
        <Segmented
          options={options}
          value={section}
          onValueChange={(next) => transitionUi(() => setSection(next))}
          aria-label="Schedule section"
        />
        {schedule.conflicts.length > 0 && (
          <span className="flex items-center gap-1.5 text-2xs text-accent">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {schedule.conflicts.length} overlap
            {schedule.conflicts.length === 1 ? "" : "s"}
          </span>
        )}
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          onClick={() => setEditing("new")}
          aria-label="Add a schedule entry"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New entry</span>
        </Button>
      </div>

      <div key={section} className="agenda-view">
        {section === "college" && (
          <WeekdayList
            onEdit={setEditing}
            entries={schedule.college}
            highlightDay={current}
            emptyTitle="No class timings saved"
            emptyHint={'Try: "My Monday DSA lecture is at 9am in C410"'}
            icon={<GraduationCap className="h-4 w-4" />}
          />
        )}
        {section === "routine" && (
          <WeekdayList
            onEdit={setEditing}
            entries={schedule.routine}
            highlightDay={current}
            conflicts={schedule.conflicts}
            emptyTitle="No routines saved"
            emptyHint={'Try: "Every Monday 6 to 7:45pm is my Django project"'}
            icon={<Repeat className="h-4 w-4" />}
          />
        )}
        {section === "session" && (
          <ScheduleTimeline events={schedule.session} onEdit={setEditing} />
        )}
      </div>

      <RecordEditor
        open={editing !== null}
        title={editing === "new" ? "New schedule entry" : "Edit schedule entry"}
        fields={
          EVENT_FIELDS as unknown as React.ComponentProps<typeof RecordEditor>["fields"]
        }
        initial={
          editing && editing !== "new"
            ? {
                event_name: editing.event_name,
                kind: editing.kind,
                day_of_week: editing.day_of_week ?? "",
                start_time: editing.start_time ?? "",
                end_time: editing.end_time ?? "",
                time_start: editing.time_start ?? "",
                time_end: editing.time_end ?? "",
                location: editing.location ?? "",
                notes: editing.notes ?? "",
              }
            : { kind: section.toUpperCase() }
        }
        onClose={() => setEditing(null)}
        onSave={async (values: RecordValues) => {
          const text = (key: string) => String(values[key] ?? "").trim() || null;
          const day = String(values.day_of_week ?? "").trim();
          const draft = {
            event_name: String(values.event_name ?? "").trim(),
            kind: (values.kind as ScheduleEvent["kind"]) ?? "SESSION",
            day_of_week: day === "" ? null : Number(day),
            start_time: text("start_time"),
            end_time: text("end_time"),
            time_start: text("time_start"),
            time_end: text("time_end"),
            location: text("location"),
            notes: text("notes"),
          };
          if (draft.kind === "SESSION") {
            if (!draft.time_start || !draft.time_end || new Date(draft.time_end) <= new Date(draft.time_start)) {
              throw new Error("Choose an end time after the block starts.");
            }
            draft.day_of_week = null;
            draft.start_time = draft.end_time = null;
          } else {
            draft.time_start = draft.time_end = null;
          }
          if (editing === "new") {
            await createEvent(mode, draft);
          } else if (editing) {
            await updateEvent(mode, editing.uid ?? editing.id, draft);
          }
          onChanged();
        }}
        onDelete={
          editing && editing !== "new"
            ? async () => {
                await deleteEvent(mode, editing.uid ?? editing.id);
                onChanged();
              }
            : undefined
        }
      />
    </div>
  );
}

/**
 * Weekly entries under their weekday heading.
 *
 * `flat` renders one ungrouped list — used for "today", where every row is
 * already the same day and a heading would be noise.
 */
function WeekdayList({
  entries,
  highlightDay,
  conflicts = [],
  emptyTitle,
  emptyHint,
  icon,
  flat = false,
  onEdit,
}: {
  entries: ScheduleEvent[];
  highlightDay?: number;
  conflicts?: GroupedSchedule["conflicts"];
  emptyTitle: string;
  emptyHint: string;
  icon?: React.ReactNode;
  flat?: boolean;
  onEdit?: (entry: ScheduleEvent) => void;
}) {
  const [selectedDay, setSelectedDay] = React.useState(highlightDay ?? 0);
  const clashing = React.useMemo(() => {
    const ids = new Set<number>();
    for (const conflict of conflicts) {
      ids.add(conflict.a_id);
      ids.add(conflict.b_id);
    }
    return ids;
  }, [conflicts]);

  if (!entries.length) {
    return (
      <div className="p-5">
        <EmptyState
          icon={icon ?? <CalendarRange className="h-4 w-4" />}
          title={emptyTitle}
          hint={emptyHint}
        />
      </div>
    );
  }

  // Read once per render rather than per row: a list that disagreed with
  // itself about the time would be worse than one that never showed it.
  const clock = new Date();
  const nowMinutes = flat ? clock.getHours() * 60 + clock.getMinutes() : null;

  if (flat) {
    return (
      <div className="px-4 py-4">
        <ol className="space-y-px">
          {entries.map((entry) => (
            <EntryRow
              key={`${entry.kind}-${entry.id}`}
              entry={entry}
              showKind
              onEdit={onEdit}
              state={entryState(entry, nowMinutes)}
            />
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="schedule-days px-4 py-4">
      <div className="agenda-intro"><span className="page-kicker">WEEKLY OVERVIEW</span><p>Make time for what matters.</p></div>
      <nav aria-label="Choose a weekday" className="weekday-picker mb-6 grid grid-cols-7 gap-1 lg:hidden">
        {DAYS.map((day, index) => (
          <button key={day} type="button" aria-label={day} aria-pressed={selectedDay === index}
            onClick={() => transitionUi(() => setSelectedDay(index))}
            className={cn("flex min-h-12 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl text-[12px] font-medium transition-colors",
              selectedDay === index ? "bg-accent text-accent-ink" : "bg-surface-1 text-ink-dim")}>
            <span>{day.slice(0, 3)}</span>
            <span aria-hidden className={cn("h-1 w-1 rounded-full", entries.some((entry) => entry.day_of_week === index) ? "bg-current" : "bg-transparent")} />
          </button>
        ))}
      </nav>
      {!entries.some((entry) => entry.day_of_week === selectedDay) && (
        <div className="lg:hidden"><EmptyState icon={icon} title={`Nothing on ${DAYS[selectedDay]}`} hint="Choose another day, or add a new entry." /></div>
      )}
      <div className="space-y-7">
        {DAYS.map((day, index) => {
          const items = entries.filter((entry) => entry.day_of_week === index);
          if (!items.length) return null;

          return (
            <section key={day} className={cn("agenda-day", index !== selectedDay && "hidden lg:block")}>
              <div className="schedule-day-heading mb-3 flex items-baseline gap-3 py-1.5">
                <h3
                  className={cn(
                    "font-display text-md font-semibold tracking-tight",
                    index === highlightDay ? "text-accent" : "text-ink",
                  )}
                >
                  {day}
                </h3>
                {index === highlightDay && <Badge tone="accent">Today</Badge>}
                <span className="tnum font-mono text-2xs text-ink-faint">
                  {items.length} {items.length === 1 ? "plan" : "plans"}
                </span>
                <span aria-hidden className="ml-1 h-px flex-1 bg-line" />
              </div>

              <ol className="schedule-list space-y-px">
                {items.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    clashing={clashing.has(entry.id)}
                    onEdit={onEdit}
                  />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Minutes since midnight for a stored time, or null when there is none. */
function minutesOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /(\d{1,2}):(\d{2})/.exec(String(value));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Past, now, or still to come.
 *
 * Only meaningful for today — a Tuesday row seen on a Monday is not "past",
 * it simply has not happened yet this week, and dimming it would be a lie.
 */
function entryState(
  entry: ScheduleEvent,
  nowMinutes: number | null,
): "past" | "now" | "upcoming" {
  if (nowMinutes === null) return "upcoming";
  const start = minutesOf(entry.display_start ?? entry.start_time ?? entry.time_start);
  if (start === null) return "upcoming";
  const end =
    minutesOf(entry.display_end ?? entry.end_time ?? entry.time_end) ?? start + 60;
  if (nowMinutes >= end) return "past";
  if (nowMinutes >= start) return "now";
  return "upcoming";
}

function EntryRow({
  entry,
  clashing = false,
  showKind = false,
  onEdit,
  state = "upcoming",
}: {
  entry: ScheduleEvent;
  clashing?: boolean;
  showKind?: boolean;
  onEdit?: (entry: ScheduleEvent) => void;
  /** Where this block sits relative to the clock. */
  state?: "past" | "now" | "upcoming";
}) {
  const now = state === "now";
  const past = state === "past";

  // The room is usually repeated verbatim inside the notes ("25CS2103E-S |
  // Room C410"), so the same string appeared twice on every class. Showing it
  // once is not a saving of space, it is the difference between a row you can
  // scan and one you have to read.
  const notes = entry.notes?.trim() || "";
  const room = entry.location?.trim() || "";
  const noteIsRoom = Boolean(room) && notes.toLowerCase().includes(room.toLowerCase());
  const extra = noteIsRoom ? notes.split("|")[0].trim() : notes;

  return (
    <li
      className={cn(
        "schedule-card group relative grid grid-cols-[68px_1fr] gap-3 py-2.5 pl-3 pr-2",
        "transition-colors duration-150 hover:bg-surface-2/50",
        past && "opacity-45",
      )}
    >
      {/* A single accent rail marks the block that is running. One mark, in
          the place the eye already scans, instead of a badge competing with
          the name. */}
      {now && (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent"
          style={{ boxShadow: "0 0 8px hsl(var(--accent) / 0.8)" }}
        />
      )}

      <div className="pt-0.5 text-right">
        {entry.window ? (
          <>
            <span
              className={cn(
                "schedule-start tnum block font-mono text-sm leading-tight",
                now ? "text-accent" : "text-ink",
              )}
            >
              {entry.display_start}
            </span>
            {/* The end time is a detail, so it reads as one — no second
                full-size line pretending to be as important as the start. */}
            {entry.display_end && (
              <span className="schedule-end tnum block font-mono text-[0.6rem] leading-tight text-ink-faint">
                {entry.display_end}
              </span>
            )}
          </>
        ) : (
          <span className="font-mono text-[0.6rem] leading-tight text-ink-faint">
            no time
          </span>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-start gap-2">
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(entry)}
              title="Edit"
              className={cn(
                "schedule-title min-w-0 flex-1 break-words py-0.5 text-left text-[0.95rem] font-medium leading-snug",
                "rounded-sm transition-colors duration-150 hover:text-accent",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                now ? "text-accent" : "text-ink",
              )}
            >
              {entry.event_name}
            </button>
          ) : (
            <p
              className={cn(
                "min-w-0 break-words py-0.5 text-[0.95rem] font-medium leading-snug",
                now ? "text-accent" : "text-ink",
              )}
            >
              {entry.event_name}
            </p>
          )}

          {onEdit && <button type="button" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.event_name}`}
            className="schedule-edit -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-dim hover:bg-surface-3 hover:text-accent lg:hidden">
            <Pencil className="h-4 w-4" />
          </button>}

          {now && (
            <span className="ml-auto shrink-0 pt-1 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-accent">
              now
            </span>
          )}
        </div>

        {/* One quiet line for everything else. The kind is a word here rather
            than a boxed badge — it is context, and context does not need a
            border to be understood. */}
        {(room || extra || showKind || clashing) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-faint">
            {showKind && (
              <span className="uppercase tracking-[0.12em]">
                {entry.kind === "COLLEGE"
                  ? "class"
                  : entry.kind === "ROUTINE"
                    ? "routine"
                    : "session"}
              </span>
            )}
            {room && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                {room}
              </span>
            )}
            {extra && <span className="min-w-0 break-words">{extra}</span>}
            {clashing && (
              <span className="flex items-center gap-1 text-accent">
                <TriangleAlert className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                overlaps
              </span>
            )}
          </p>
        )}
      </div>
    </li>
  );
}
