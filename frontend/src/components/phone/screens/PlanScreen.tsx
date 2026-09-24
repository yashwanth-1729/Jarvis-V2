"use client";

import * as React from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { BellRinging, CalendarDots, GraduationCap, Hourglass, MapPin, NotePencil, Plus, Repeat, Warning } from "@phosphor-icons/react";

import { parseLocal } from "@/lib/utils";
import type { Reminder, ScheduleEvent } from "@/types";
import { KIND_TONE } from "../lib/derive";
import { haptic } from "../lib/haptics";
import { clock, dayDelta, mondayIndex, relative, when, WEEKDAYS } from "../lib/time";
import { usePhone, useNow, type PlanSection } from "../PhoneContext";
import { EventSheet, ReminderSheet, type EventTarget, type ReminderTarget } from "../sheets/PlanSheets";
import { Chip, Empty, SectionHead, Skeleton, Sticker } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Segmented } from "../ui/Segmented";
import { Tap } from "../ui/Tap";

const SECTION_KIND: Record<Exclude<PlanSection, "reminders">, ScheduleEvent["kind"]> = {
  routine: "ROUTINE",
  college: "COLLEGE",
  session: "SESSION",
};

export function PlanScreen() {
  const { app, planSection, openPlan, reminders, remindersLoaded } = usePhone();
  const now = useNow();
  const [day, setDay] = React.useState(() => mondayIndex(new Date()));
  const [editing, setEditing] = React.useState<EventTarget>(null);
  const [reminding, setReminding] = React.useState<ReminderTarget>(null);
  const schedule = app.state?.schedule;

  const add = () => {
    if (planSection === "reminders") setReminding("new");
    else setEditing({ kind: SECTION_KIND[planSection], day: planSection === "session" ? undefined : day });
  };

  return (
    <Screen
      title="Plan"
      tone="sky"
      eyebrow={now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
      actions={
        <Tap className="ph-icon-btn ph-icon-btn-accent" aria-label={planSection === "reminders" ? "Add a reminder" : "Add a plan"} onClick={add} feel="heavy">
          <Plus size={22} weight="bold" />
        </Tap>
      }
      hero={
        <Segmented<PlanSection>
          label="Schedule section"
          size="sm"
          value={planSection}
          onChange={openPlan}
          options={[
            { value: "routine", label: "Routine", count: schedule?.routine.length },
            { value: "college", label: "College", count: schedule?.college.length },
            { value: "session", label: "Blocks", count: schedule?.session.length },
            { value: "reminders", label: "Pings", count: reminders.length },
          ]}
        />
      }
    >
      <div className="ph-stack">
        {!schedule ? (
          <Skeleton rows={4} />
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={planSection}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            >
              {planSection === "routine" && (
                <WeekView
                  entries={schedule.routine}
                  day={day}
                  setDay={setDay}
                  clashes={clashIds(schedule.conflicts)}
                  conflicts={schedule.conflicts.length}
                  onEdit={setEditing}
                  onAdd={() => setEditing({ kind: "ROUTINE", day })}
                  icon={<Repeat size={36} weight="duotone" />}
                  emptyTitle="No routine yet"
                  emptyHint={'Try saying: "Every Monday 6 to 7:45pm is my Django project"'}
                />
              )}
              {planSection === "college" && (
                <WeekView
                  entries={schedule.college}
                  day={day}
                  setDay={setDay}
                  clashes={new Set()}
                  conflicts={0}
                  onEdit={setEditing}
                  onAdd={() => setEditing({ kind: "COLLEGE", day })}
                  icon={<GraduationCap size={36} weight="duotone" />}
                  emptyTitle="No classes saved"
                  emptyHint={'Try saying: "My Monday DSA lecture is at 9am in C410"'}
                />
              )}
              {planSection === "session" && <Blocks blocks={schedule.session} now={now} onEdit={setEditing} onAdd={() => setEditing({ kind: "SESSION" })} />}
              {planSection === "reminders" &&
                (remindersLoaded ? (
                  <Reminders reminders={reminders} now={now} onEdit={setReminding} onAdd={() => setReminding("new")} />
                ) : (
                  <Skeleton rows={3} />
                ))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      <EventSheet target={editing} onClose={() => setEditing(null)} />
      <ReminderSheet target={reminding} onClose={() => setReminding(null)} />
    </Screen>
  );
}

function clashIds(conflicts: { a_id: number; b_id: number }[]): Set<number> {
  const ids = new Set<number>();
  for (const conflict of conflicts) {
    ids.add(conflict.a_id);
    ids.add(conflict.b_id);
  }
  return ids;
}

function minutesOf(value: string | null): number {
  const match = /(\d{1,2}):(\d{2})/.exec(value ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : 24 * 60;
}

/** Weekly entries, one weekday at a time. Swipe the list to change day. */
function WeekView({ entries, day, setDay, clashes, conflicts, onEdit, onAdd, icon, emptyTitle, emptyHint }: {
  entries: ScheduleEvent[];
  day: number;
  setDay: (day: number) => void;
  clashes: Set<number>;
  conflicts: number;
  onEdit: (event: ScheduleEvent) => void;
  onAdd: () => void;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyHint: string;
}) {
  const today = mondayIndex(new Date());
  const [direction, setDirection] = React.useState(0);
  const items = entries.filter((entry) => entry.day_of_week === day).sort((a, b) => minutesOf(a.start_time) - minutesOf(b.start_time));
  const change = (next: number) => {
    const wrapped = (next + 7) % 7;
    setDirection(next > day ? 1 : -1);
    haptic("select");
    setDay(wrapped);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -70 || info.velocity.x < -600) change(day + 1);
    else if (info.offset.x > 70 || info.velocity.x > 600) change(day - 1);
  };

  return (
    <>
      <div className="ph-daystrip" role="tablist" aria-label="Day of the week">
        {WEEKDAYS.map((name, index) => {
          const has = entries.some((entry) => entry.day_of_week === index);
          const on = index === day;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={name}
              className="ph-daystrip-day"
              data-on={on}
              data-today={index === today}
              onClick={() => {
                if (!on) change(index);
              }}
            >
              {on && <motion.span layoutId="daystrip-pill" className="ph-daystrip-pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
              <span className="ph-daystrip-letter">{name.slice(0, 3)}</span>
              <span className="ph-daystrip-dot" data-has={has} />
            </button>
          );
        })}
      </div>
      {conflicts > 0 && (
        <div className="ph-clash-banner">
          <Warning size={18} weight="fill" /> {conflicts} {conflicts === 1 ? "overlap" : "overlaps"} in your routine
        </div>
      )}
      <motion.div className="ph-swipe-area" drag="x" dragDirectionLock dragConstraints={{ left: 0, right: 0 }} dragElastic={0.18} onDragEnd={onDragEnd} style={{ touchAction: "pan-y" }}>
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={day}
            custom={direction}
            variants={{
              enter: (dir: number) => ({ opacity: 0, x: dir * 60 }),
              center: { opacity: 1, x: 0 },
              exit: (dir: number) => ({ opacity: 0, x: dir * -60 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
          >
            <SectionHead title={day === today ? `${WEEKDAYS[day]} · today` : WEEKDAYS[day]} count={items.length} />
            {items.length ? (
              <ol className="ph-agenda">
                {items.map((entry, index) => (
                  <AgendaCard key={entry.uid ?? entry.id} entry={entry} index={index} clash={clashes.has(entry.id)} onEdit={onEdit} />
                ))}
              </ol>
            ) : entries.length ? (
              <Empty icon={<CalendarDots size={34} weight="duotone" />} title={`Nothing on ${WEEKDAYS[day]}`} hint="Swipe for another day, or add something." action={<Tap className="ph-btn" onClick={onAdd}>Add here</Tap>} />
            ) : (
              <Empty icon={icon} title={emptyTitle} hint={emptyHint} action={<Tap className="ph-btn ph-btn-primary" onClick={onAdd}>Add one</Tap>} />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </>
  );
}

function AgendaCard({ entry, index, clash, onEdit }: { entry: ScheduleEvent; index: number; clash: boolean; onEdit: (event: ScheduleEvent) => void }) {
  const [time, meridiem] = (entry.display_start || "").split(" ");
  const notes = entry.notes?.trim() || "";
  const room = entry.location?.trim() || "";
  // The room is often repeated inside the notes; show it once.
  const extra = room && notes.toLowerCase().includes(room.toLowerCase()) ? notes.split("|")[0].trim() : notes;
  return (
    <motion.li
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30, delay: Math.min(index, 8) * 0.04 }}
    >
      <Tap className="ph-agenda-card" data-tone={KIND_TONE[entry.kind]} onClick={() => onEdit(entry)} squish={0.97}>
        <span className="ph-agenda-time">
          {entry.window ? (
            <>
              <strong>{time}</strong>
              <small>{meridiem}</small>
              {entry.display_end && <em>to {entry.display_end}</em>}
            </>
          ) : (
            <small>any time</small>
          )}
        </span>
        <span className="ph-agenda-body">
          <strong>{entry.event_name}</strong>
          {(room || extra) && (
            <span className="ph-agenda-meta">
              {room && <><MapPin size={13} weight="fill" /> {room}</>}
              {extra && <span className="ph-agenda-notes">{extra}</span>}
            </span>
          )}
        </span>
        {clash && <span className="ph-agenda-sticker"><Sticker tone="amber" tilt={5}>CLASH</Sticker></span>}
      </Tap>
    </motion.li>
  );
}

function Blocks({ blocks, now, onEdit, onAdd }: { blocks: ScheduleEvent[]; now: Date; onEdit: (event: ScheduleEvent) => void; onAdd: () => void }) {
  const groups = new Map<string, ScheduleEvent[]>();
  for (const block of [...blocks].sort((a, b) => (a.time_start ?? "").localeCompare(b.time_start ?? ""))) {
    const key = (block.time_start ?? "").slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  if (!blocks.length) {
    return <Empty icon={<Hourglass size={36} weight="duotone" />} title="No blocks booked" hint="Blocks are one-off focus sessions. They clear themselves when they end." action={<Tap className="ph-btn ph-btn-primary" onClick={onAdd}>Book a block</Tap>} />;
  }
  let index = 0;
  return (
    <>
      {[...groups.entries()].map(([key, items]) => {
        const date = parseLocal(`${key}T00:00:00`);
        const delta = date ? dayDelta(date, now) : 99;
        const label = delta === 0 ? "Today" : delta === 1 ? "Tomorrow" : date?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) ?? key;
        return (
          <section key={key} className="ph-section">
            <SectionHead title={label} count={items.length} />
            <ol className="ph-agenda">
              {items.map((block) => {
                const start = parseLocal(block.time_start);
                const end = parseLocal(block.time_end);
                const live = start && end && start.getTime() <= now.getTime() && now.getTime() < end.getTime();
                return (
                  <motion.li key={block.uid ?? block.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 400, damping: 30, delay: Math.min(index++, 8) * 0.04 }}>
                    <Tap className="ph-agenda-card" data-tone="orange" data-live={Boolean(live)} onClick={() => onEdit(block)} squish={0.97}>
                      <span className="ph-agenda-time">
                        <strong>{start ? clock(start).split(" ")[0] : "--"}</strong>
                        <small>{start ? clock(start).split(" ")[1] : ""}</small>
                        {end && <em>to {clock(end)}</em>}
                      </span>
                      <span className="ph-agenda-body">
                        <strong>{block.event_name}</strong>
                        <span className="ph-agenda-meta">
                          {block.location && <><MapPin size={13} weight="fill" /> {block.location}</>}
                          <span className="ph-agenda-notes">clears at {end ? clock(end) : "end"}</span>
                        </span>
                      </span>
                      {live && <span className="ph-agenda-sticker"><Sticker tone="red" tilt={-4} pulse>LIVE</Sticker></span>}
                    </Tap>
                  </motion.li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </>
  );
}

function Reminders({ reminders, now, onEdit, onAdd }: { reminders: Reminder[]; now: Date; onEdit: (reminder: Reminder) => void; onAdd: () => void }) {
  const sorted = [...reminders].sort((a, b) => (parseLocal(a.due_at)?.getTime() ?? 0) - (parseLocal(b.due_at)?.getTime() ?? 0));
  if (!sorted.length) {
    return <Empty icon={<BellRinging size={36} weight="duotone" />} title="No pings queued" hint={'Try saying: "Remind me to call the bank at 5pm"'} action={<Tap className="ph-btn ph-btn-primary" onClick={onAdd}>New reminder</Tap>} />;
  }
  return (
    <ol className="ph-pings">
      {sorted.map((reminder, index) => {
        const due = parseLocal(reminder.due_at);
        const late = Boolean(due && due.getTime() < now.getTime() && !reminder.fired_at);
        return (
          <motion.li key={reminder.id} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ type: "spring", stiffness: 380, damping: 30, delay: Math.min(index, 8) * 0.04 }}>
            <Tap className="ph-ping" data-late={late} onClick={() => onEdit(reminder)} squish={0.97}>
              <span className="ph-ping-icon"><BellRinging size={20} weight="fill" /></span>
              <span className="ph-ping-body">
                <strong>{reminder.text}</strong>
                <span className="ph-ping-meta">
                  {when(reminder.due_at, now)}
                  {reminder.fired_at ? <Chip>spoken</Chip> : <Chip tone={late ? "red" : "pink"}>{relative(reminder.due_at, now.getTime())}</Chip>}
                </span>
              </span>
              <NotePencil size={18} weight="bold" className="ph-ping-edit" aria-hidden="true" />
            </Tap>
          </motion.li>
        );
      })}
    </ol>
  );
}
