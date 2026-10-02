"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowCounterClockwise, CaretLeft, ChartLineUp, Check, LockSimple, Play, Plus, Timer } from "@phosphor-icons/react";

import {
  FOCUS_CHANGED,
  fetchFocus,
  finishFocus,
  markSerious,
  resetFocus,
  snapshotOf,
  startFocus,
  unmarkSerious,
  type FocusEvent,
  type FocusItem,
  type FocusMode,
} from "@/lib/focus";
import { parseLocal } from "@/lib/utils";
import type { ScheduleEvent, Task } from "@/types";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { clock, mondayIndex, when } from "../lib/time";
import { useAppData, useFinishAction, useNav, useNow } from "../PhoneContext";
import { Chip, Empty, SectionHead, stagger } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Segmented } from "../ui/Segmented";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";

type State = "pending" | "running" | "done" | "skipped";

interface Row {
  item: FocusItem;
  title: string;
  /** Today's date for a block, "once" for a task. */
  occurrence: string;
  state: State;
  event?: FocusEvent;
  task?: Task;
  start?: Date | null;
  end?: Date | null;
  due?: Date | null;
}

function dateKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function at(day: Date, hhmm: string | null | undefined): Date | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return null;
  const next = new Date(day);
  next.setHours(h, m || 0, 0, 0);
  return next;
}

/** When a block happens today, or null if it does not. */
function todayWindow(block: Pick<ScheduleEvent, "kind" | "day_of_week" | "start_time" | "end_time" | "time_start" | "time_end">, now: Date) {
  if (block.kind === "SESSION") {
    const start = parseLocal(block.time_start);
    if (!start || dateKey(start) !== dateKey(now)) return null;
    return { start, end: parseLocal(block.time_end) ?? new Date(start.getTime() + 3_600_000) };
  }
  if (block.day_of_week !== mondayIndex(now)) return null;
  const start = at(now, block.start_time);
  const end = at(now, block.end_time) ?? (start ? new Date(start.getTime() + 3_600_000) : null);
  return { start, end };
}

/**
 * Lock-in: serious mode. Tasks and blocks the user committed to, started and
 * finished on purpose, with every miss counted (the user asked, 2026-10-02).
 * Deliberately sober next to the rest of the app; the stats are the loud part.
 */
export function FocusScreen() {
  const { app } = useAppData();
  const { pop, push } = useNav();
  const finishTask = useFinishAction();
  const now = useNow(15_000);
  const [items, setItems] = React.useState<FocusItem[]>([]);
  const [events, setEvents] = React.useState<FocusEvent[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const next = await fetchFocus();
      setItems(next.items);
      setEvents(next.events);
    } catch {
      // Keep what is on screen; the next action retries.
    } finally {
      setLoaded(true);
    }
  }, []);
  React.useEffect(() => {
    void reload();
    const again = () => void reload();
    window.addEventListener(FOCUS_CHANGED, again);
    return () => window.removeEventListener(FOCUS_CHANGED, again);
  }, [reload]);

  const tasks = React.useMemo(() => app.state?.tasks ?? [], [app.state?.tasks]);
  const blocks = React.useMemo(() => {
    const schedule = app.state?.schedule;
    return schedule ? [...schedule.college, ...schedule.routine, ...schedule.session] : [];
  }, [app.state?.schedule]);

  // Keep each item's timing snapshot current, so the backend judges skips
  // against the block's real time even after it was edited.
  React.useEffect(() => {
    for (const item of items) {
      const block = item.kind === "block" ? blocks.find((b) => b.uid === item.uid) : undefined;
      const task = item.kind === "task" ? tasks.find((t) => t.uid === item.uid) : undefined;
      const fresh = block ? snapshotOf({ block }, item.mode) : task ? snapshotOf({ task }, item.mode) : null;
      if (!fresh) continue;
      const stale = Object.entries(fresh).some(([key, value]) => (item as unknown as Record<string, unknown>)[key] !== (value ?? null));
      if (stale) void markSerious(item.uid, fresh).catch(() => undefined);
    }
  }, [items, blocks, tasks]);

  const today = dateKey(now);
  const { rows, later } = React.useMemo(() => {
    const out: Row[] = [];
    const rest: FocusItem[] = [];
    for (const item of items) {
      if (item.kind === "block") {
        const block = blocks.find((b) => b.uid === item.uid);
        const source = block ?? {
          kind: (item.block_kind ?? "ROUTINE") as ScheduleEvent["kind"],
          day_of_week: item.day_of_week, start_time: item.start_time, end_time: item.end_time,
          time_start: item.time_start, time_end: item.time_end,
        };
        const window = todayWindow(source, now);
        if (!window) {
          rest.push(item);
          continue;
        }
        const event = events.find((e) => e.item_uid === item.uid && e.occurrence === today);
        const ended = Boolean(window.end && window.end.getTime() <= now.getTime());
        // Same rule as the stats: an occurrence that began before it was
        // marked serious was never committed to, so it cannot be skipped.
        const committed = !window.start || window.start.getTime() >= (parseLocal(item.created_at)?.getTime() ?? 0);
        if (!event && ended && !committed) continue;
        const state: State = event ? event.status : ended ? "skipped" : "pending";
        out.push({ item, title: block?.event_name ?? item.title, occurrence: today, state, event, start: window.start, end: window.end });
      } else {
        const task = tasks.find((t) => t.uid === item.uid);
        const event = events.find((e) => e.item_uid === item.uid && e.occurrence === "once");
        if (!task && !event) continue;
        const due = parseLocal(task?.due_date ?? item.due_date);
        if (!event && due && dateKey(due) > today) {
          rest.push(item);
          continue;
        }
        const markedAt = parseLocal(item.created_at)?.getTime() ?? 0;
        const state: State = event ? event.status : due && due.getTime() <= now.getTime() && due.getTime() >= markedAt ? "skipped" : "pending";
        if (event?.status === "done" && event.finished_at && !event.finished_at.startsWith(today)) continue;
        out.push({ item, title: task?.title ?? item.title, occurrence: "once", state, event, task, due });
      }
    }
    const order: Record<State, number> = { running: 0, pending: 1, skipped: 2, done: 3 };
    out.sort((a, b) => order[a.state] - order[b.state] || (a.start?.getTime() ?? a.due?.getTime() ?? 0) - (b.start?.getTime() ?? b.due?.getTime() ?? 0));
    return { rows: out, later: rest };
  }, [items, events, blocks, tasks, now, today]);

  const done = rows.filter((row) => row.state === "done").length;
  const skipped = rows.filter((row) => row.state === "skipped").length;

  const act = async (row: Row, action: "start" | "done" | "undo", origin?: Element | null) => {
    setBusy(row.item.uid);
    try {
      if (action === "start") {
        await startFocus(row.item.uid, row.occurrence);
        haptic("heavy");
        emitFx("heavy", origin ?? null);
      } else if (action === "done") {
        await finishFocus(row.item.uid, row.occurrence);
        haptic("success");
        emitFx("success", origin ?? null);
        // A serious task done here is done on the board too.
        if (row.task) finishTask(row.task, origin ?? null);
      } else {
        await resetFocus(row.item.uid, row.occurrence);
        haptic("toggle-off");
      }
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Screen
        title="Lock in."
        tone="red"
        bottomPad={false}
        className="ph-focus"
        eyebrow={<span className="ph-focus-eyebrow"><LockSimple size={14} weight="fill" /> Serious mode</span>}
        leading={
          <Tap className="ph-icon-btn" aria-label="Back" onClick={pop} feel="select">
            <CaretLeft size={22} weight="bold" />
          </Tap>
        }
        actions={
          <Tap className="ph-icon-btn" aria-label="Make something serious" onClick={() => setPicking(true)} feel="select">
            <Plus size={22} weight="bold" />
          </Tap>
        }
        hero={
          <div className="ph-focus-hero">
            <p className="ph-focus-tally">
              <strong>{done}</strong>/{rows.length} done today
              {skipped > 0 && <span className="ph-focus-missed"> · {skipped} skipped</span>}
            </p>
            <Tap className="ph-focus-stats-btn" onClick={() => push({ kind: "focusStats" })} feel="heavy" squish={0.94}>
              <ChartLineUp size={20} weight="bold" />
              <span>How am I doing?</span>
            </Tap>
          </div>
        }
      >
        <div className="ph-stack">
          {!loaded ? null : rows.length === 0 && later.length === 0 ? (
            <Empty
              icon={<LockSimple size={44} weight="duotone" />}
              title="Nothing serious yet."
              hint="Pick the tasks and blocks you won't skip. Start them, finish them, and every miss gets counted."
              action={<Tap className="ph-btn ph-btn-primary" onClick={() => setPicking(true)}>Make something serious</Tap>}
            />
          ) : (
            <>
              <section className="ph-section">
                <SectionHead title="Today" count={rows.length} />
                {rows.length ? (
                  <ol className="ph-focus-list">
                    <AnimatePresence initial={false}>
                      {rows.map((row, index) => (
                        <motion.li key={`${row.item.uid}-${row.occurrence}`} layout="position" style={stagger(index)} className="ph-slide-in">
                          <FocusRow row={row} now={now} busy={busy === row.item.uid} onAct={act} />
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ol>
                ) : (
                  <p className="ph-focus-quiet">Nothing serious on today. Rest is part of it.</p>
                )}
              </section>
              {later.length > 0 && (
                <section className="ph-section">
                  <SectionHead title="Coming up" count={later.length} />
                  <ul className="ph-focus-later">
                    {later.map((item) => (
                      <li key={item.uid}>
                        <span>{item.title}</span>
                        <Chip>{item.kind === "task" ? (item.due_date ? when(item.due_date, now) : "No date") : laterLabel(item)}</Chip>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </Screen>
      <PickSheet
        open={picking}
        onClose={() => setPicking(false)}
        items={items}
        tasks={tasks.filter((task) => task.status !== "COMPLETED")}
        blocks={blocks}
        onChanged={reload}
      />
    </>
  );
}

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function laterLabel(item: FocusItem): string {
  if (item.block_kind === "SESSION") return item.time_start ? when(item.time_start) : "One-off";
  return item.day_of_week != null ? `Every ${DAY[item.day_of_week]}${item.start_time ? ` · ${item.start_time}` : ""}` : "Weekly";
}

function Elapsed({ since }: { since: string | null }) {
  const now = useNow(1000);
  const start = parseLocal(since);
  const seconds = start ? Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000)) : 0;
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  return <span className="ph-focus-timer">{h ? `${h}:` : ""}{p(Math.floor((seconds % 3600) / 60))}:{p(seconds % 60)}</span>;
}

function FocusRow({ row, now, busy, onAct }: { row: Row; now: Date; busy: boolean; onAct: (row: Row, action: "start" | "done" | "undo", origin?: Element | null) => void }) {
  const session = row.item.mode === "session";
  const meta = row.start
    ? `${clock(row.start)}${row.end ? ` – ${clock(row.end)}` : ""}`
    : row.due
      ? `Due ${when(row.task?.due_date ?? row.item.due_date, now)}`
      : "Any time today";
  return (
    <div className="ph-focus-row" data-state={row.state}>
      <span className="ph-focus-mark" aria-hidden="true">
        {row.state === "done" ? <Check size={18} weight="bold" /> : row.state === "running" ? <Timer size={18} weight="fill" /> : <LockSimple size={16} weight="fill" />}
      </span>
      <span className="ph-focus-body">
        <strong>{row.title}</strong>
        <span className="ph-focus-meta">
          {meta}
          <span className="ph-focus-mode">{session ? "Start → Done" : "One tap"}</span>
          {row.state === "skipped" && <span className="ph-focus-flag">Skipped</span>}
        </span>
      </span>
      <span className="ph-focus-act">
        {row.state === "running" && <Elapsed since={row.event?.started_at ?? null} />}
        {row.state === "done" ? (
          // A task's Done also finished it on the board, so it is taken back
          // with the board's Undo toast; a block's is taken back here.
          row.item.kind === "task" ? null : <Tap className="ph-focus-undo" aria-label={`Undo ${row.title}`} onClick={() => onAct(row, "undo")} disabled={busy} feel="select">
            <ArrowCounterClockwise size={16} weight="bold" />
          </Tap>
        ) : row.state === "running" || !session || row.state === "skipped" ? (
          <Tap className="ph-focus-btn" data-kind="done" onClick={(event) => onAct(row, "done", event.currentTarget)} disabled={busy} feel={false} squish={0.9}>
            <Check size={16} weight="bold" /> {row.state === "skipped" ? "Did it" : "Done"}
          </Tap>
        ) : (
          <Tap className="ph-focus-btn" data-kind="start" onClick={(event) => onAct(row, "start", event.currentTarget)} disabled={busy} feel={false} squish={0.9}>
            <Play size={16} weight="fill" /> Start
          </Tap>
        )}
      </span>
    </div>
  );
}

type Choice = "off" | FocusMode;

/** Choose what is serious: every open task and every block, three-way. */
function PickSheet({ open, onClose, items, tasks, blocks, onChanged }: {
  open: boolean;
  onClose: () => void;
  items: FocusItem[];
  tasks: Task[];
  blocks: ScheduleEvent[];
  onChanged: () => Promise<void> | void;
}) {
  const modeOf = (uid?: string): Choice => items.find((item) => item.uid === uid)?.mode ?? "off";
  const choose = async (choice: Choice, record: { task: Task } | { block: ScheduleEvent }) => {
    const uid = "task" in record ? record.task.uid : record.block.uid;
    if (!uid) return;
    haptic(choice === "off" ? "toggle-off" : "toggle-on");
    if (choice === "off") await unmarkSerious(uid).catch(() => undefined);
    else await markSerious(uid, snapshotOf(record, choice));
    await onChanged();
  };
  const options = [
    { value: "off" as const, label: "Off" },
    { value: "session" as const, label: "Start → Done" },
    { value: "quick" as const, label: "One tap" },
  ];
  const sortedBlocks = [...blocks]
    .filter((block) => block.kind !== "SESSION" || (parseLocal(block.time_start)?.getTime() ?? 0) > Date.now() - 86_400_000)
    .sort((a, b) => (a.day_of_week ?? 9) - (b.day_of_week ?? 9) || (a.start_time ?? "").localeCompare(b.start_time ?? ""));
  return (
    <Sheet open={open} onClose={onClose} title="Make it serious" eyebrow="No skipping" tone="red">
      <div className="ph-focus-pick">
        <SectionHead title="Tasks" count={tasks.length} />
        {tasks.length ? tasks.map((task) => (
          <div key={task.uid ?? task.id} className="ph-focus-pick-row">
            <span><strong>{task.title}</strong><small>{task.due_date ? when(task.due_date) : "No date"}</small></span>
            <Segmented<Choice> label={`Serious mode for ${task.title}`} size="sm" value={modeOf(task.uid)} onChange={(choice) => void choose(choice, { task })} options={options} />
          </div>
        )) : <p className="ph-focus-quiet">No open tasks.</p>}
        <SectionHead title="Blocks" count={sortedBlocks.length} />
        {sortedBlocks.map((block) => (
          <div key={block.uid ?? block.id} className="ph-focus-pick-row">
            <span>
              <strong>{block.event_name}</strong>
              <small>{block.kind === "SESSION" ? when(block.time_start) : `${DAY[block.day_of_week ?? 0]} ${block.start_time ?? ""}`} · {block.kind.toLowerCase()}</small>
            </span>
            <Segmented<Choice> label={`Serious mode for ${block.event_name}`} size="sm" value={modeOf(block.uid)} onChange={(choice) => void choose(choice, { block })} options={options} />
          </div>
        ))}
      </div>
    </Sheet>
  );
}
