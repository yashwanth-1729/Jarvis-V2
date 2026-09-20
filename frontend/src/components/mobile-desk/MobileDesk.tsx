"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ArrowDown, ArrowRight, ArrowUpRight, AudioLines, BookOpen, CalendarDays, Check, ChevronRight, CircleAlert, House, ListChecks, MessageSquare, Mic, Plus, Settings2, X } from "lucide-react";
import { Chat } from "@/components/Chat";
import { AgentRunStatus } from "@/components/AgentRunStatus";
import { ScheduleBoard } from "@/components/ScheduleBoard";
import { NotesWorkspace } from "@/components/NotesWorkspace";
import { SyncBanner } from "@/components/SyncBanner";
import { useCommandCenter, type CommandCenter } from "@/lib/useCommandCenter";
import { parseLocal } from "@/lib/utils";
import type { ScheduleEvent, Task, RefreshDomain } from "@/types";
import { DeskTaskEditor, DeskTaskRow, DeskTasks } from "./DeskTasks";

const SettingsPanel = dynamic(() => import("@/components/SettingsPanel").then(m => m.SettingsPanel));
const VoiceMode = dynamic(() => import("@/components/VoiceMode").then(m => m.VoiceMode), { ssr: false });

type Destination = "today" | "tasks" | "schedule" | "notes" | "chat";
const NAV = [
  { id: "today", label: "Today", icon: House },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "notes", label: "Notes", icon: BookOpen },
  { id: "chat", label: "Chat", icon: MessageSquare },
] as const;
const TITLE: Record<Destination, string> = { today: "Today.", tasks: "Make it happen.", schedule: "Your time.", notes: "Keep a thought.", chat: "Let’s talk." };
const DESCRIPTION: Record<Destination, string> = { today: "", tasks: "One thing at a time.", schedule: "Routines, classes, blocks and reminders.", notes: "Notes and the things JARVIS remembers.", chat: "Ask, plan, or think out loud." };

function useClock() {
  const [date, setDate] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setDate(new Date());
    const timer = setInterval(() => setDate(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return date;
}

/** A parallel visual experience over the same controller and record APIs.
 * The main route remains available while the two redesigns are evaluated. */
export function MobileDesk() {
  const app = useCommandCenter();
  const [destination, setDestination] = React.useState<Destination>("today");
  const [chatVisited, setChatVisited] = React.useState(false);
  const [voiceNotice, setVoiceNotice] = React.useState(false);
  const [theme, setTheme] = React.useState<"system" | "light" | "dark">("system");
  const date = useClock();
  const mainRef = React.useRef<HTMLElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const initialDestination = React.useRef(true);
  React.useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    if (initialDestination.current) { initialDestination.current = false; return; }
    headingRef.current?.focus({ preventScroll: true });
  }, [destination]);
  // Theme is a visual preference only, separate from provider and sync settings.
  React.useEffect(() => {
    try { const saved = localStorage.getItem("jarvis.mobile-desk.theme"); if (saved === "light" || saved === "dark") setTheme(saved); } catch { /* Storage can be unavailable in private browsing. */ }
  }, []);
  function changeTheme(value: "system" | "light" | "dark") {
    setTheme(value);
    try { localStorage.setItem("jarvis.mobile-desk.theme", value); } catch { /* The current session still applies the choice. */ }
  }
  function openVoice() {
    if (app.voiceAvailable) app.setVoiceOpen(true);
    else setVoiceNotice(true);
  }
  function navigate(next: Destination) {
    if (next === "chat") setChatVisited(true);
    setDestination(next);
  }
  const mode = { local: app.recordsLocal };
  return <div className="desk-shell" data-theme={theme}>
    <a className="desk-skip" href="#desk-content">Skip to content</a>
    <div className="desk-app">
      <header className="desk-header">
        <a className="desk-brand" href="/mobile/" aria-label="JARVIS home">jarvis<span aria-hidden="true">/</span></a>
        <span className="desk-connection" role="status"><i data-offline={app.status === "offline"} />{app.loading ? "Starting" : app.status === "offline" ? "Offline" : "Connected"}</span>
        <button className="desk-icon-button" onClick={() => app.setSettingsOpen(true)} aria-label="Open settings"><Settings2 size={20} /></button>
      </header>
      {process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_API_BASE === "http://127.0.0.1:8101" && <div className="desk-fixture-label">Design preview · Sample records</div>}
      <SyncBanner className="desk-sync" enabled={app.recordsLocal} onSynced={app.handleSynced} />
      <main id="desk-content" ref={mainRef} className="desk-content" data-chat={destination === "chat"}>
        <div className="desk-page-head">
          <div className="desk-date">{date ? date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "Your personal assistant"}</div>
          <h1 ref={headingRef} tabIndex={-1}>{TITLE[destination]}</h1>
          {DESCRIPTION[destination] && <p>{DESCRIPTION[destination]}</p>}
        </div>
        {(app.error || app.localOnly) && <div className="desk-error" role="alert"><CircleAlert size={19} /><div><strong>{app.localOnly ? "Working from saved data" : "Couldn’t load your day"}</strong><p>{app.localOnly ? "You can keep editing. Voice needs the backend to reconnect." : "Your records haven’t been changed. Retry or check the connection in Settings."}</p><button onClick={() => void app.refresh()} disabled={app.refreshing}>{app.refreshing ? "Connecting…" : "Retry connection"}</button></div></div>}
        {chatVisited && <div className="desk-chat" hidden={destination !== "chat"}><Chat onRefresh={app.handleAgentRefresh} onSurface={app.setSurface} /><AgentRunStatus /></div>}
        {destination === "chat" ? null : app.loading && !app.state ? <DeskLoading /> : !app.state ? <div className="desk-empty"><CalendarDays size={30} /><h2>Your day will appear here.</h2><p>Connect to JARVIS to load your saved tasks, notes and schedule.</p><button className="desk-button" onClick={() => app.setSettingsOpen(true)}>Open settings<ArrowUpRight size={16} /></button></div> : <div className="desk-view" key={destination}>
          {destination === "today" && <Today app={app} date={date} navigate={navigate} />}
          {destination === "tasks" && <DeskTasks tasks={app.state.tasks} mode={mode} onChanged={app.handleRecordChanged} onToggle={app.handleToggleTask} />}
          {destination === "schedule" && <ScheduleBoard schedule={app.state.schedule} today={app.state.today} mode={mode} onChanged={app.handleRecordChanged} />}
          {destination === "notes" && <NotesWorkspace ideas={app.state.ideas} memories={app.state.memories} pages={app.state.note_pages} mode={mode} onChanged={app.handleRecordChanged} />}
        </div>}
        {destination !== "chat" && <div className="desk-appearance"><label htmlFor="desk-theme">Appearance</label><select id="desk-theme" value={theme} onChange={event => changeTheme(event.target.value as typeof theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>}
      </main>
      <div className="desk-voice-dock"><button onClick={openVoice} aria-label="Start voice conversation"><AudioLines size={19} /><span>Talk to JARVIS</span><span className="desk-dock-action"><Mic size={17} /></span></button></div>
      <nav className="desk-nav" aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} aria-current={destination === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={21} strokeWidth={1.7} /><span>{label}</span></button>)}</nav>
    </div>
    {voiceNotice && <div className="desk-notice" role="status"><Mic size={22} /><div><strong>Voice isn’t ready yet</strong><p>Check your connection and voice credentials in Settings, then allow microphone access.</p><button className="desk-text-button" onClick={() => { setVoiceNotice(false); app.setSettingsOpen(true); }}>Open settings<ArrowUpRight size={16} /></button></div><button className="desk-icon-button" aria-label="Dismiss voice notice" onClick={() => setVoiceNotice(false)}><X size={20} /></button></div>}
    {app.settingsOpen && <SettingsPanel onClose={() => app.setSettingsOpen(false)} />}
    {app.voiceOpen && <VoiceMode open onClose={() => app.setVoiceOpen(false)} onRefresh={domains => app.handleAgentRefresh(domains as RefreshDomain[])} onSurface={app.setSurface} panelOpen={false} />}
  </div>;
}

function Today({ app, date, navigate }: { app: CommandCenter; date: Date | null; navigate: (value: Destination) => void }) {
  const [editing, setEditing] = React.useState<Task | "new" | null>(null);
  const state = app.state!;
  const tasks = state.tasks.filter(task => task.status !== "COMPLETED");
  const prioritized = [...tasks].sort((a, b) => Number(b.status === "IN_PROGRESS") - Number(a.status === "IN_PROGRESS") || (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  const agenda = [...state.today].sort((a, b) => eventStart(a) - eventStart(b));
  const now = date ? date.getHours() * 60 + date.getMinutes() : -1;
  const remaining = agenda.filter(event => eventEnd(event) === null || eventEnd(event)! > now);
  const next = remaining[0];
  return <>
    <section className="desk-talk-card" aria-label="Your assistant">
      <div className="desk-talk-top"><span>Your assistant</span><AudioLines size={23} aria-hidden /></div>
      <h2>Say what you<br />need done.</h2>
      <p>Set a reminder, move a class,<br />or capture a thought.</p>
      <button className="desk-talk-link" onClick={() => navigate("chat")}>Ask JARVIS<ArrowUpRight size={21} /></button>
    </section>
    <section className="desk-agenda" aria-labelledby="desk-agenda-title">
      <div className="desk-section-title"><h2 id="desk-agenda-title">On the agenda</h2><button className="desk-text-button" onClick={() => navigate("schedule")}>Schedule<ArrowUpRight size={16} /></button></div>
      {next ? <button className="desk-next-event" onClick={() => navigate("schedule")}>
        <span className="desk-event-time">{eventTime(next)}<small>{eventStart(next) <= now ? "Happening now" : "Up next"}</small></span>
        <span className="desk-event-copy"><strong>{next.event_name}</strong><span>{next.location || (next.kind === "COLLEGE" ? "College" : next.kind === "ROUTINE" ? "Your routine" : "Scheduled block")}</span></span><ChevronRight size={19} />
      </button> : <div className="desk-agenda-empty"><CalendarDays size={22} /><div><strong>{agenda.length ? "That’s today’s agenda." : "An open calendar."}</strong><p>{agenda.length ? "No more scheduled blocks today." : "Give something a place in your day."}</p></div><button className="desk-icon-button" aria-label="Open schedule" onClick={() => navigate("schedule")}><Plus size={20} /></button></div>}
      {remaining.length > 1 && <button className="desk-agenda-more" onClick={() => navigate("schedule")}><ArrowDown size={15} /><span>{remaining.length - 1} more {remaining.length === 2 ? "entry" : "entries"} today</span><span>{eventTime(remaining[1])}</span></button>}
    </section>
    <section className="desk-home-tasks" aria-labelledby="desk-tasks-title">
      <div className="desk-section-title"><h2 id="desk-tasks-title">To get done <span className="desk-count">{tasks.length}</span></h2><button className="desk-icon-button" onClick={() => setEditing("new")} aria-label="Add a task"><Plus size={20} /></button></div>
      {tasks.length ? <ul className="desk-task-list">{prioritized.slice(0, 3).map(task => <DeskTaskRow key={task.uid ?? task.id} task={task} onEdit={setEditing} onToggle={app.handleToggleTask} />)}</ul> : <div className="desk-agenda-empty"><Check size={22} /><div><strong>Nothing on the list.</strong><p>Add your next task when you’re ready.</p></div></div>}
      {tasks.length > 0 && <button className="desk-all-tasks" onClick={() => navigate("tasks")}>View all tasks<ArrowRight size={17} /></button>}
    </section>
    <button className="desk-note-link" onClick={() => navigate("notes")}><BookOpen size={24} /><span><strong>Worth keeping.</strong><small>Open your notes &amp; memory</small></span><ArrowUpRight size={22} /></button>
    <DeskTaskEditor task={editing} mode={{ local: app.recordsLocal }} onChanged={app.handleRecordChanged} onClose={() => setEditing(null)} />
  </>;
}

function eventStart(event: ScheduleEvent) { return minutes(event.start_time ?? event.time_start?.slice(11, 16) ?? "23:59"); }
function eventEnd(event: ScheduleEvent) { const end = event.end_time ?? event.time_end?.slice(11, 16); return end ? minutes(end) : null; }
function minutes(time: string) { const [hour, minute] = time.split(":").map(Number); return hour * 60 + minute; }
function eventTime(event: ScheduleEvent) {
  const start = event.start_time || event.time_start?.slice(11, 16);
  if (!start) return "Anytime";
  const date = parseLocal(`2000-01-01T${start}:00`);
  return date?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) ?? start;
}
function DeskLoading() { return <div className="desk-loading" role="status" aria-label="Loading your day"><div /><div /><div /><span className="sr-only">Loading your day</span></div>; }
