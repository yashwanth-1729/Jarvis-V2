"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ArrowsClockwise, CaretDown, MapPin } from "@phosphor-icons/react";

import type { Task } from "@/types";
import { focusTasks, isOverdueTask, KIND_LABEL, KIND_TONE, nowAndNext, upcomingReminders, type Occurrence } from "../lib/derive";
import { clock, duration, greeting, minutesUntil, relative } from "../lib/time";
import { useAppData, useFinish, useNav, useNow, useSyncState, type PlanSection } from "../PhoneContext";
import { TaskSheet, type TaskTarget } from "../sheets/TaskSheet";
import { Chip, Empty, KineticText, SectionHead, Skeleton, stagger, Sticker } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Tap } from "../ui/Tap";
import { Icon3D } from "../ui/Icon3D";
import { Ticker } from "../ui/Ticker";
import { TaskRow } from "./TaskRow";
import { Num } from "../ui/Num";

const SECTION_FOR: Record<Occurrence["event"]["kind"], PlanSection> = { COLLEGE: "college", ROUTINE: "routine", SESSION: "session" };

export function TodayScreen() {
  const { app, reminders } = useAppData();
  const { go, openChat, openVoice, openPlan, push } = useNav();
  const { checked, finishing } = useFinish();
  const sync = useSyncState();
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
            <Icon3D name="settings" size={28} />
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
            <p className="ph-greet-sub ph-fade-in">
              <Num value={open.length} /> open · <Num value={agenda.remaining} /> left on the plan
              {overdue > 0 && <> · <span className="ph-hot"><Num value={overdue} /> late</span></>}
            </p>
          )}
        </div>
      }
    >
      <div className="ph-stack">
        <ConnectionCard />

        <div className="ph-ask">
          <Tap className="ph-ask-main" onClick={openChat} squish={0.97}>
            <span className="ph-ask-spark" aria-hidden="true"><Icon3D name="sparkle" size={34} /></span>
            <span className="ph-ask-text">Ask JARVIS anything…</span>
          </Tap>
          <Tap className="ph-ask-mic" aria-label="Talk to JARVIS" onClick={openVoice} squish={0.88} feel="heavy">
            <Icon3D name="mic" size={32} />
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
                <Icon3D name="bell" size={46} className="ph-tile-icon" />
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
                      <TaskRow key={task.uid ?? task.id} task={task} done={checked.has(task.id)} index={index} onEdit={setEditing} />
                    ))}
                  </AnimatePresence>
                </ul>
              ) : (
                <Empty
                  icon={<Icon3D name="party" size={58} />}
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
                  icon={<Icon3D name="plan" size={58} />}
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
        <span className="ph-now-fill" style={{ transform: `scaleX(${live ? progress : 0})` }} />
      </span>
      <span className="ph-now-left">
        {live ? "ends in " : "starts in "}
        <strong>{duration(left)}</strong>
      </span>
    </Tap>
  );
}

function BriefTile() {
  const { app } = useAppData();
  const [open, setOpen] = React.useState(false);
  const brief = app.state?.brief;
  if (!brief?.summary_text) return null;
  const bullets = brief.bullets.filter(Boolean);
  return (
    <div className="ph-tile ph-tile-wide ph-tile-brief" data-open={open}>
      <button type="button" className="ph-brief-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="ph-brief-label"><Icon3D name="bolt" size={20} /> JARVIS brief</span>
        {brief.urgent_count > 0 && <Sticker tone="red" tilt={3}>{brief.urgent_count} URGENT</Sticker>}
        <span className="ph-brief-caret"><CaretDown size={16} weight="bold" /></span>
      </button>
      <p className="ph-brief-text">{brief.summary_text}</p>
      {bullets.length > 0 && !open && <Ticker items={bullets} />}
      <AnimatePresence initial={false}>
        {open && bullets.length > 0 && (
          <motion.ul className="ph-brief-list" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}>
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
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
          <li
            key={`${event.uid ?? event.id}-${item.start}`}
            className="ph-slide-in"
            style={stagger(index)}
            data-state={state}
            data-tone={KIND_TONE[event.kind]}
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
          </li>
        );
      })}
    </ol>
  );
}

function SyncBadge({ phase, message }: { phase: string; message: string | null }) {
  if (phase === "syncing") {
    return (
      <span className="ph-sync" data-phase="syncing" role="status" aria-label="Syncing">
        <Icon3D name="refresh" size={26} className="ph-spin" />
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="ph-sync" data-phase="error" role="status" aria-label={message ?? "Sync failed, will retry"} title={message ?? undefined}>
        <Icon3D name="warning" size={26} />
      </span>
    );
  }
  return null;
}

/** Offline / saved-data state, with a retry that never touches records. */
function ConnectionCard() {
  const { app } = useAppData();
  const show = Boolean(app.error || app.localOnly);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className="ph-offline"
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.26, ease: [0.2, 0, 0, 1] }}
        >
          <Icon3D name="offline" size={36} />
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
  const { push } = useNav();
  return (
    <Empty
      icon={<Chip tone="lilac">NO DATA YET</Chip>}
      title="Your records are safe."
      hint="Connect to JARVIS to open your saved data."
      action={<Tap className="ph-btn ph-btn-primary" onClick={() => push({ kind: "settings" })}>Open settings</Tap>}
    />
  );
}
