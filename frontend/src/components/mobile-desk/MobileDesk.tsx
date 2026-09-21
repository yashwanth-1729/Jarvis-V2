"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { ArrowLeft, ArrowUpRight, AudioLines, Bell, BookOpen, CalendarDays, ChevronRight, CircleAlert, Clock3, Keyboard, Layers3, ListChecks, Mic, Plus, Settings2, X } from "lucide-react";
import { Chat } from "@/components/Chat";
import { ScheduleBoard } from "@/components/ScheduleBoard";
import { NotesWorkspace } from "@/components/NotesWorkspace";
import { SyncBanner } from "@/components/SyncBanner";
import { useCommandCenter, type CommandCenter } from "@/lib/useCommandCenter";
import type { NotePage, RefreshDomain, ScheduleEvent } from "@/types";
import { DeskTasks } from "./DeskTasks";
import { useSpaceSlide } from "./useSpaceSlide";
import { useScrollDepth } from "./useScrollDepth";
import { withTransition } from "./transition";

const SettingsPanel = dynamic(() => import("@/components/SettingsPanel").then(m => m.SettingsPanel));
const VoiceMode = dynamic(() => import("@/components/VoiceMode").then(m => m.VoiceMode), { ssr: false });
type Space = "assistant" | "day" | "library";
type Screen = "chat" | "tasks" | "schedule" | "reminders" | "notes" | null;
const SPACES = [{ id: "day", label: "My day", icon: CalendarDays }, { id: "assistant", label: "Assistant", icon: AudioLines }, { id: "library", label: "Library", icon: Layers3 }] as const;
const SCREEN_TITLE = { chat: "Conversation", tasks: "Tasks", schedule: "Schedule", reminders: "Reminders", notes: "Notebook" };

function useClock() {
  const [date, setDate] = React.useState<Date | null>(null);
  React.useEffect(() => { setDate(new Date()); const timer = setInterval(() => setDate(new Date()), 30_000); return () => clearInterval(timer); }, []);
  return date;
}

/** Full-height mobile spaces. The existing controller still owns data and voice. */
export function MobileDesk() {
  const app = useCommandCenter();
  const [space, setSpace] = React.useState<Space>("assistant");
  const [screen, setScreen] = React.useState<Screen>(null);
  // A drag settles on its own space; React is told after the fact so the
  // movement never waits on a render.
  const shellRef = React.useRef<HTMLDivElement>(null);
  const { trackRef, selectionRef } = useSpaceSlide(
    SPACES.findIndex(item => item.id === space), screen === null,
    next => setSpace(SPACES[next].id),
  );
  useScrollDepth(shellRef);
  const [notebook, setNotebook] = React.useState("notes-long-term");
  const [chatVisited, setChatVisited] = React.useState(false);
  const [voiceNotice, setVoiceNotice] = React.useState(false);
  const [motionPaused, setMotionPaused] = React.useState(false);
  const [theme, setTheme] = React.useState<"system" | "light" | "dark">("system");
  const date = useClock();
  const contentRef = React.useRef<HTMLElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const firstRender = React.useRef(true);
  React.useEffect(() => {
    const update = () => setMotionPaused(document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  React.useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus({ preventScroll: true });
  }, [space, screen]);
  React.useEffect(() => {
    try { const saved = localStorage.getItem("jarvis.mobile-desk.theme"); if (saved === "light" || saved === "dark") setTheme(saved); } catch { /* Session preference still works. */ }
  }, []);
  function openScreen(next: Screen) {
    // Chat is mounted first so the browser has both sides to morph between.
    if (next === "chat") setChatVisited(true);
    withTransition(() => setScreen(next), "open");
  }
  const closeScreen = () => withTransition(() => setScreen(null), "back");
  const setSettingsOpen = app.setSettingsOpen;
  const closeSettings = React.useCallback(() => withTransition(() => setSettingsOpen(false), "back"), [setSettingsOpen]);
  function openVoice() {
    if (app.voiceAvailable) withTransition(() => app.setVoiceOpen(true), "open");
    else withTransition(() => setVoiceNotice(true), "notice");
  }
  const mode = { local: app.recordsLocal };
  const title = screen ? SCREEN_TITLE[screen] : space === "assistant" ? "JARVIS" : space === "day" ? "My day" : "Library";
  const ready = !app.loading && app.status !== "offline" && !app.localOnly;
  return <div ref={shellRef} className="desk-shell" data-theme={theme} data-motion-paused={motionPaused} data-voice-open={app.voiceOpen}>
    <a className="desk-skip" href="#desk-content">Skip to content</a>
    <div className="desk-app" aria-hidden={app.settingsOpen || app.voiceOpen ? true : undefined} ref={element => { if (element) element.inert = app.settingsOpen || app.voiceOpen; }}>
      <header className="pocket-header">
        {screen ? <button className="desk-icon-button glass" onClick={closeScreen} aria-label="Go back"><ArrowLeft size={21} /></button> : <span className="pocket-monogram" aria-hidden="true"><AudioLines size={22} /></span>}
        <div className="pocket-heading"><h1 ref={headingRef} tabIndex={-1}>{title}</h1>{!screen && <span>{space === "assistant" ? "Personal intelligence" : date?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) || "Your space"}</span>}</div>
        <button className="desk-icon-button glass" onClick={() => withTransition(() => app.setSettingsOpen(true), "open")} aria-label="Open settings"><Settings2 size={20} /></button>
      </header>
      {process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_API_BASE === "http://127.0.0.1:8101" && <div className="desk-fixture-label">Design preview · Sample records</div>}
      <SyncBanner enabled={app.recordsLocal} onSynced={app.handleSynced} />
      <main id="desk-content" ref={contentRef} className="pocket-content" data-screen={screen || space} data-pager={!screen}>
        {(app.error || app.localOnly) && <div className="desk-error" role="alert"><CircleAlert size={18} /><div><strong>{app.localOnly ? "Using saved data" : "Connection unavailable"}</strong><p>You can retry without changing your records.</p><button onClick={() => void app.refresh()} disabled={app.refreshing}>{app.refreshing ? "Connecting…" : "Reconnect"}</button></div></div>}
        {chatVisited && <div className="desk-chat" hidden={screen !== "chat"}><Chat presentation="pocket" onRefresh={app.handleAgentRefresh} onSurface={app.setSurface} /></div>}
        <div className="pocket-pages-viewport" hidden={!!screen}>
          <div className="pocket-pages-track" ref={trackRef}>
            {SPACES.map(({ id, label }) => <div key={id} className="pocket-page" data-space={id} aria-label={label} aria-hidden={space !== id || !!screen} ref={element => { if (element) element.inert = space !== id || !!screen; }}>
              {id === "assistant" ? <Assistant app={app} date={date} ready={ready} openVoice={openVoice} openScreen={openScreen} /> : <RecordsReady app={app}>
                {id === "day" ? <Day app={app} date={date} openScreen={openScreen} /> : <Library app={app} onReminders={() => openScreen("reminders")} onOpen={uid => { setNotebook(uid); openScreen("notes"); }} />}
              </RecordsReady>}
            </div>)}
          </div>
        </div>
        {screen && screen !== "chat" && <div key={screen} className="pocket-screen">
          <RecordsReady app={app}>
            {app.state && <>
            {screen === "tasks" && <DeskTasks tasks={app.state.tasks} mode={mode} onChanged={app.handleRecordChanged} onToggle={app.handleToggleTask} />}
            {(screen === "schedule" || screen === "reminders") && <ScheduleBoard key={screen} initialSection={screen === "reminders" ? "reminders" : "routine"} schedule={app.state.schedule} today={app.state.today} mode={mode} onChanged={app.handleRecordChanged} />}
            {screen === "notes" && <NotesWorkspace initialPage={notebook} ideas={app.state.ideas} memories={app.state.memories} pages={app.state.note_pages} mode={mode} onChanged={app.handleRecordChanged} />}
            </>}
          </RecordsReady>
        </div>}
      </main>
      {!screen && <nav className="pocket-dock glass" data-space={space} aria-label="Main navigation"><span ref={selectionRef} className="pocket-dock-selection" aria-hidden="true" />{SPACES.map(({ id, label, icon: Icon }) => <button key={id} aria-current={space === id ? "page" : undefined} onClick={() => setSpace(id)}><span><Icon size={22} strokeWidth={1.7} /></span>{label}</button>)}</nav>}
    </div>
    {voiceNotice && <div className="desk-notice glass" role="status"><Mic size={22} /><div><strong>Voice is not ready yet</strong><p>Check your connection and credentials in Settings, then allow microphone access.</p><button className="desk-text-button" onClick={() => withTransition(() => { setVoiceNotice(false); app.setSettingsOpen(true); }, "open")}>Open settings<ArrowUpRight size={16} /></button></div><button className="desk-icon-button" aria-label="Dismiss voice notice" onClick={() => withTransition(() => setVoiceNotice(false), "back")}><X size={20} /></button></div>}
    {app.settingsOpen && <SettingsPanel presentation="pocket" onClose={closeSettings} appearance={<fieldset className="pocket-appearance"><legend>Choose your look</legend>{(["system", "light", "dark"] as const).map(value => <label key={value} data-theme-choice={value}><input type="radio" name="appearance" value={value} checked={theme === value} onChange={() => { setTheme(value); try { localStorage.setItem("jarvis.mobile-desk.theme", value); } catch { /* Optional persistence. */ } }} /><span className="pocket-theme-preview" aria-hidden="true"><i /><i /><i /></span><span>{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</span></label>)}</fieldset>} />}
    {app.voiceOpen && <VoiceMode open presentation="pocket" onClose={() => withTransition(() => app.setVoiceOpen(false), "back")} onRefresh={domains => app.handleAgentRefresh(domains as RefreshDomain[])} onSurface={app.setSurface} panelOpen={false} />}
  </div>;
}

function RecordsReady({ app, children }: { app: CommandCenter; children: React.ReactNode }) {
  if (app.loading && !app.state) return <div className="desk-loading" role="status"><div /><div /><div /><span className="sr-only">Loading your records</span></div>;
  if (!app.state) return <div className="desk-empty"><Layers3 size={36} /><h2>Your records are safe.</h2><p>Connect to JARVIS to open your saved data.</p><button className="desk-button" onClick={() => app.setSettingsOpen(true)}>Open settings</button></div>;
  return <>{children}</>;
}

function Assistant({ app, date, ready, openVoice, openScreen }: { app: CommandCenter; date: Date | null; ready: boolean; openVoice: () => void; openScreen: (screen: Screen) => void }) {
  const next = upcoming(app.state?.today || [], date)[0];
  return <section className="pocket-assistant" aria-label="Voice assistant">
    <div className="pocket-readiness" role="status"><span data-ready={ready} />{app.loading ? "Connecting to your assistant" : ready ? "Ready when you are" : "Waiting for connection"}</div>
    <div className="pocket-voice-space">
      {/* User-supplied artwork decorates the real, accessible microphone action. */}
      <button className="pocket-speak pocket-speak-art" onClick={openVoice} aria-label="Start voice conversation"><Image className="pocket-loop-art" src="/mobile/sea-glass-loop.png" alt="" width={1254} height={1254} priority unoptimized draggable={false} /><span className="pocket-glass-core"><Mic size={32} strokeWidth={1.4} /></span></button>
      <h2>Tap. Talk. Done.</h2><p>Your voice is the shortcut.</p>
    </div>
    <div className="pocket-assistant-actions"><button className="pocket-type glass" onClick={() => openScreen("chat")}><Keyboard size={21} /><span>Type instead</span><ArrowUpRight size={18} /></button>
      <button className="pocket-context glass" onClick={() => openScreen("schedule")}><CalendarDays size={20} /><span><small>{next ? "Next in your day" : "Your schedule"}</small><strong>{next?.event_name || "See what’s planned"}</strong></span>{next ? <time>{eventTime(next)}</time> : <ChevronRight size={18} />}</button>
    </div>
  </section>;
}

function Day({ app, date, openScreen }: { app: CommandCenter; date: Date | null; openScreen: (screen: Screen) => void }) {
  const state = app.state!;
  const agenda = [...state.today].sort((a, b) => eventStart(a) - eventStart(b));
  const next = upcoming(agenda, date)[0];
  const tasks = state.tasks.filter(task => task.status !== "COMPLETED");
  return <div className="pocket-day">
    <div className="pocket-day-summary"><div><span>{date?.toLocaleDateString("en-GB", { month: "long" }) || "Today"}</span><strong>{date?.getDate() ?? ""}</strong></div><p>{tasks.length ? <><b>{tasks.length} open {tasks.length === 1 ? "task" : "tasks"}.</b><br />One place to plan them.</> : <>No open tasks.<br />Your day, at your pace.</>}</p></div>
    <div className="pocket-day-tools"><button className="glass" onClick={() => openScreen("tasks")}><ListChecks size={22} /><span>Tasks</span><ArrowUpRight size={16} /></button><button className="glass" onClick={() => openScreen("reminders")}><Bell size={22} /><span>Reminders</span><ArrowUpRight size={16} /></button></div>
    <div className="pocket-section-heading"><h2>Today’s timeline</h2><button className="desk-icon-button glass" aria-label="Manage schedule" onClick={() => openScreen("schedule")}><Plus size={21} /></button></div>
    {agenda.length ? <ol className="pocket-timeline">{agenda.map(event => <li key={event.uid ?? event.id} data-next={event === next}>
      <time>{eventTime(event)}</time><button onClick={() => openScreen("schedule")} className="glass"><small>{event === next ? "Up next" : event.kind === "COLLEGE" ? "College" : event.kind === "ROUTINE" ? "Routine" : "Block"}</small><strong>{event.event_name}</strong>{event.location && <span>{event.location}</span>}<ChevronRight size={17} /></button>
    </li>)}</ol> : <div className="pocket-open-day glass"><CalendarDays size={36} /><h3>Nothing scheduled today</h3><p>Add a routine, class or a little time for yourself.</p><button className="desk-button" onClick={() => openScreen("schedule")}>Plan some time<Plus size={17} /></button></div>}
    <button className="pocket-full-link" onClick={() => openScreen("schedule")}>Open weekly schedule<ArrowUpRight size={18} /></button>
  </div>;
}

function Library({ app, onOpen, onReminders }: { app: CommandCenter; onOpen: (uid: string) => void; onReminders: () => void }) {
  const state = app.state!;
  const defaults: NotePage[] = [
    { uid: "notes-long-term", title: "Long-term memory", kind: "LONG_TERM", created_at: "", updated_at: "" },
    { uid: "notes-temporary", title: "Temporary memory", kind: "TEMPORARY", created_at: "", updated_at: "" },
    { uid: "notes-other", title: "Notes & ideas", kind: "OTHER", created_at: "", updated_at: "" },
  ];
  const pages = new Map(defaults.map(page => [page.uid, page]));
  for (const page of state.note_pages || []) pages.set(page.uid, page);
  return <div className="pocket-library"><p className="pocket-library-intro">Everything you’ve asked<br />JARVIS to keep.</p><div className="pocket-books">{[...pages.values()].map(page => {
    const isMemory = page.kind === "LONG_TERM" || page.kind === "TEMPORARY";
    const count = isMemory ? state.memories.filter(m => m.memory_status === "ACTIVE" && Boolean(m.expires_at) === (page.kind === "TEMPORARY")).length : state.ideas.filter(i => page.kind === "OTHER" ? !i.page_uid || i.page_uid === page.uid || !pages.has(i.page_uid) : i.page_uid === page.uid).length;
    const Icon = page.kind === "TEMPORARY" ? Clock3 : isMemory ? AudioLines : BookOpen;
    return <button className="pocket-book" key={page.uid} onClick={() => onOpen(page.uid)}><span className="pocket-book-cover glass" data-kind={page.kind}><Icon size={36} strokeWidth={1.2} /><span>{isMemory ? "Memory" : "Notebook"}</span><ArrowUpRight size={18} /></span><strong>{page.title}</strong><small>{count} {count === 1 ? "entry" : "entries"}</small></button>;
  })}<button className="pocket-book" onClick={onReminders}><span className="pocket-book-cover glass" data-kind="REMINDERS"><Bell size={36} strokeWidth={1.2} /><span>Alerts</span><ArrowUpRight size={18} /></span><strong>Reminders</strong><small>View and manage</small></button></div><button className="pocket-full-link" onClick={() => onOpen("notes-other")}>Manage notebooks<Plus size={19} /></button></div>;
}

function minutes(time: string) { const [hour, minute] = time.split(":").map(Number); return hour * 60 + minute; }
function eventStart(event: ScheduleEvent) { return minutes(event.start_time ?? event.time_start?.slice(11, 16) ?? "23:59"); }
function upcoming(events: ScheduleEvent[], date: Date | null) {
  const now = date ? date.getHours() * 60 + date.getMinutes() : -1;
  return [...events].filter(event => { const end = event.end_time ?? event.time_end?.slice(11, 16); return !end || minutes(end) > now; }).sort((a, b) => eventStart(a) - eventStart(b));
}
function eventTime(event: ScheduleEvent) { return event.start_time || event.time_start?.slice(11, 16) || "Anytime"; }
