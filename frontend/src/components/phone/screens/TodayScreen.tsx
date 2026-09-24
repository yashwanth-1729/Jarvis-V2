"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  ArrowsClockwise,
  BellRinging,
  CalendarDots,
  CaretDown,
  Confetti,
  GearSix,
  Lightning,
  MapPin,
  Microphone,
  Sparkle,
  WarningCircle,
  WifiSlash,
} from "@phosphor-icons/react";

import type { Task } from "@/types";
import { focusTasks, isOverdueTask, KIND_LABEL, KIND_TONE, nowAndNext, upcomingReminders, type Occurrence } from "../lib/derive";
import { clock, duration, greeting, minutesUntil, relative } from "../lib/time";
import { usePhone, useNow, type PlanSection } from "../PhoneContext";
import { TaskSheet, type TaskTarget } from "../sheets/TaskSheet";
import { Chip, Empty, KineticText, SectionHead, Skeleton, Sticker } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Tap } from "../ui/Tap";
import { Ticker } from "../ui/Ticker";
import { TaskRow } from "./TaskRow";
import { Num } from "../ui/Num";

const SECTION_FOR: Record<Occurrence["event"]["kind"], PlanSection> = { COLLEGE: "college", ROUTINE: "routine", SESSION: "session" };

export function TodayScreen() {
  const { app, go, openChat, openVoice, openPlan, push, reminders, finishing, sync } = usePhone();
  const now = useNow();
  const [editing, setEditing] = React.useState<TaskTarget>(null);
  const state = app.state;
  const hello = greeting(now);

  const open = (state?.tasks ?? []).filter((task) => task.status !== "COMPLETED" && !finishing.has(task.id));
  const overdue = open.filter((task) => isOverdueTask(task, now.getTime())).length;
  const focus = focusTasks(open, 4, now);
  const agenda = nowAndNext(state?.today ?? [], now.getTime());
  const nextReminders = upcomingReminders(reminders, now.getTime());

  const date = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase();

  return (
    <Screen
      title="Today"
      className="ph-today"
      tone="lime"
      leading={<span className="ph-date-tag">{date}</span>}
      actions={
        <>
          <SyncBadge phase={sync.phase} message={sync.message} />
          <Tap className="ph-icon-btn" aria-label="Settings" onClick={() => push({ kind: "settings" })}>
            <GearSix size={22} weight="bold" />
          </Tap>
        </>
      }
      hero={
        <div className="ph-greet-wrap">
          <h2 className="ph-greet" aria-label={`${hello.hello} ${hello.word}`}>
            <KineticText text={hello.hello} className="ph-greet-a" />{" "}
            <KineticText text={hello.word} className="ph-greet-b" delay={0.12} />
          </h2>
          {state && (
            <motion.p className="ph-greet-sub" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}>
              <Num value={open.length} /> open · <Num value={agenda.remaining} /> left on the plan
              {overdue > 0 && <> · <span className="ph-hot"><Num value={overdue} /> late</span></>}
            </motion.p>
          )}
        </div>
      }
    >
      <div className="ph-stack">
        <ConnectionCard />

        <div className="ph-ask">
          <Tap className="ph-ask-main" onClick={openChat} squish={0.97}>
            <span className="ph-ask-spark" aria-hidden="true"><Sparkle size={20} weight="fill" /></span>
            <span className="ph-ask-text">Ask JARVIS anything…</span>
          </Tap>
          <Tap className="ph-ask-mic" aria-label="Talk to JARVIS" onClick={openVoice} squish={0.88} feel="heavy">
            <Microphone size={20} weight="fill" />
          </Tap>
        </div>

        {!state ? (
          app.loading ? <Skeleton rows={4} /> : <NoData />
        ) : (
          <>
            <div className="ph-bento">
              <NowTile agenda={agenda} now={now.getTime()} onOpen={(kind) => openPlan(SECTION_FOR[kind])} />
              <Tap className="ph-tile ph-tile-count" data-tone="lime" onClick={() => go("tasks")} squish={0.95}>
                <span className="ph-tile-label">Tasks</span>
                <span className="ph-tile-big"><Num value={open.length} /></span>
                <span className="ph-tile-foot">{open.length === 1 ? "thing to do" : "things to do"}</span>
                {overdue > 0 && <span className="ph-tile-sticker"><Sticker tone="red" tilt={6}>{overdue} LATE</Sticker></span>}
              </Tap>
              <Tap className="ph-tile ph-tile-count" data-tone="pink" onClick={() => openPlan("reminders")} squish={0.95}>
                <span className="ph-tile-label">Pings</span>
                <span className="ph-tile-big"><Num value={nextReminders.length} /></span>
                <span className="ph-tile-foot ph-ellipsis">
                  {nextReminders[0] ? `${relative(nextReminders[0].due_at, now.getTime())} · ${nextReminders[0].text}` : "no reminders queued"}
                </span>
                <BellRinging className="ph-tile-icon" size={26} weight="fill" aria-hidden="true" />
              </Tap>
              <BriefTile />
            </div>

            <section className="ph-section">
              <SectionHead
                title="Up next"
                count={open.length}
                action={
                  <Tap className="ph-link" onClick={() => go("tasks")} feel="select">
                    All tasks <ArrowRight size={14} weight="bold" />
                  </Tap>
                }
              />
              {focus.length ? (
                <ul className="ph-task-list">
                  <AnimatePresence initial={false}>
                    {focus.map((task, index) => (
                      <TaskRow key={task.uid ?? task.id} task={task} index={index} onEdit={(item: Task) => setEditing(item)} />
                    ))}
                  </AnimatePresence>
                </ul>
              ) : (
                <Empty
                  icon={<Confetti size={36} weight="duotone" />}
                  title="Inbox zero. Legend."
                  hint="Nothing open. Add something, or just ask JARVIS to."
                  action={<Tap className="ph-btn ph-btn-primary" onClick={() => setEditing("new")}>Add a task</Tap>}
                />
              )}
            </section>

            <section className="ph-section">
              <SectionHead
                title="Timeline"
                count={agenda.all.length}
                action={
                  <Tap className="ph-link" onClick={() => go("plan")} feel="select">
                    Full plan <ArrowRight size={14} weight="bold" />
                  </Tap>
                }
              />
              {agenda.all.length ? (
                <Timeline items={agenda.all} now={now.getTime()} onOpen={(kind) => openPlan(SECTION_FOR[kind])} />
              ) : (
                <Empty
                  icon={<CalendarDots size={36} weight="duotone" />}
                  title="Wide open day"
                  hint="Nothing scheduled. Protect the free time, or plan something."
                  action={<Tap className="ph-btn" onClick={() => go("plan")}>Plan something</Tap>}
                />
              )}
            </section>
          </>
        )}
      </div>
      <TaskSheet target={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}

function NowTile({ agenda, now, onOpen }: { agenda: ReturnType<typeof nowAndNext>; now: number; onOpen: (kind: Occurrence["event"]["kind"]) => void }) {
  const item = agenda.current ?? agenda.next;
  if (!item) {
    return (
      <div className="ph-tile ph-tile-wide ph-tile-now" data-tone="mint">
        <span className="ph-tile-label">Right now</span>
        <strong className="ph-now-title">Free for the rest of today</strong>
        <span className="ph-tile-foot">No more plans. Main character energy.</span>
      </div>
    );
  }
  const live = item === agenda.current;
  const event = item.event;
  const progress = live ? Math.min(1, Math.max(0, (now - item.start) / (item.end - item.start))) : 0;
  const left = minutesUntil(live ? item.end : item.start, now);
  return (
    <Tap className="ph-tile ph-tile-wide ph-tile-now" data-tone={KIND_TONE[event.kind]} data-live={live} onClick={() => onOpen(event.kind)} squish={0.97}>
      <span className="ph-now-top">
        {live ? <Sticker tone="red" tilt={-4} pulse>LIVE</Sticker> : <Sticker tone="lime" tilt={-4}>NEXT</Sticker>}
        <span className="ph-tile-label">{KIND_LABEL[event.kind]}</span>
      </span>
      <strong className="ph-now-title">{event.event_name}</strong>
      <span className="ph-now-meta">
        {clock(new Date(item.start))} – {clock(new Date(item.end))}
        {event.location && <><MapPin size={13} weight="fill" /> {event.location}</>}
      </span>
      <span className="ph-now-bar" aria-hidden="true">
        <motion.span className="ph-now-fill" initial={false} animate={{ scaleX: live ? progress : 0 }} transition={{ type: "spring", stiffness: 120, damping: 24 }} />
      </span>
      <span className="ph-now-left">
        {live ? "ends in " : "starts in "}
        <strong>{duration(left)}</strong>
      </span>
    </Tap>
  );
}

function BriefTile() {
  const { app } = usePhone();
  const [open, setOpen] = React.useState(false);
  const brief = app.state?.brief;
  if (!brief?.summary_text) return null;
  const bullets = brief.bullets.filter(Boolean);
  return (
    <motion.div layout className="ph-tile ph-tile-wide ph-tile-brief" data-open={open}>
      <button type="button" className="ph-brief-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="ph-brief-label"><Lightning size={16} weight="fill" /> JARVIS brief</span>
        {brief.urgent_count > 0 && <Sticker tone="red" tilt={3}>{brief.urgent_count} URGENT</Sticker>}
        <motion.span className="ph-brief-caret" animate={{ rotate: open ? 180 : 0 }}><CaretDown size={16} weight="bold" /></motion.span>
      </button>
      <motion.p layout="position" className="ph-brief-text">{brief.summary_text}</motion.p>
      {bullets.length > 0 && !open && <Ticker items={bullets} />}
      <AnimatePresence initial={false}>
        {open && bullets.length > 0 && (
          <motion.ul className="ph-brief-list" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Timeline({ items, now, onOpen }: { items: Occurrence[]; now: number; onOpen: (kind: Occurrence["event"]["kind"]) => void }) {
  return (
    <ol className="ph-timeline">
      {items.map((item, index) => {
        const state = item.end <= now ? "past" : item.start <= now ? "now" : "next";
        const event = item.event;
        const progress = state === "now" ? (now - item.start) / (item.end - item.start) : 0;
        return (
          <motion.li
            key={`${event.uid ?? event.id}-${item.start}`}
            data-state={state}
            data-tone={KIND_TONE[event.kind]}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 360, damping: 30, delay: Math.min(index, 8) * 0.04 }}
          >
            <time className="ph-tl-time">{clock(new Date(item.start))}</time>
            <span className="ph-tl-rail" aria-hidden="true"><span className="ph-tl-dot" /></span>
            <Tap className="ph-tl-card" onClick={() => onOpen(event.kind)} squish={0.98}>
              <span className="ph-tl-kind">{KIND_LABEL[event.kind]}</span>
              <strong>{event.event_name}</strong>
              <span className="ph-tl-meta">
                {clock(new Date(item.start))} – {clock(new Date(item.end))}
                {event.location ? ` · ${event.location}` : ""}
              </span>
              {state === "now" && (
                <span className="ph-tl-progress" aria-hidden="true">
                  <span style={{ transform: `scaleX(${progress})` }} />
                </span>
              )}
            </Tap>
          </motion.li>
        );
      })}
    </ol>
  );
}

function SyncBadge({ phase, message }: { phase: string; message: string | null }) {
  if (phase === "syncing") {
    return (
      <span className="ph-sync" data-phase="syncing" role="status" aria-label="Syncing">
        <ArrowsClockwise size={18} weight="bold" className="ph-spin" />
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="ph-sync" data-phase="error" role="status" aria-label={message ?? "Sync failed, will retry"} title={message ?? undefined}>
        <WarningCircle size={20} weight="fill" />
      </span>
    );
  }
  return null;
}

/** Offline / saved-data state, with a retry that never touches records. */
function ConnectionCard() {
  const { app } = usePhone();
  const show = Boolean(app.error || app.localOnly);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className="ph-offline"
          role="alert"
          initial={{ opacity: 0, height: 0, y: -8 }}
          animate={{ opacity: 1, height: "auto", y: 0 }}
          exit={{ opacity: 0, height: 0 }}
        >
          <WifiSlash size={22} weight="bold" />
          <div>
            <strong>{app.localOnly ? "Running on saved data" : "JARVIS is offline"}</strong>
            <p>Your stuff is safe. Voice and chat come back when the connection does.</p>
          </div>
          <Tap className="ph-btn ph-btn-small" onClick={() => void app.refresh()} disabled={app.refreshing}>
            {app.refreshing ? <ArrowsClockwise size={16} className="ph-spin" /> : "Retry"}
          </Tap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function NoData() {
  const { push } = usePhone();
  return (
    <Empty
      icon={<Chip tone="lilac">NO DATA YET</Chip>}
      title="Your records are safe."
      hint="Connect to JARVIS to open your saved data."
      action={<Tap className="ph-btn ph-btn-primary" onClick={() => push({ kind: "settings" })}>Open settings</Tap>}
    />
  );
}
