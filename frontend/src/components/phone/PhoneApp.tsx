"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, MotionConfig, MotionGlobalConfig, useIsPresent } from "framer-motion";
import { Toaster, toast } from "sonner";

import { useChatSession } from "@/lib/useChatSession";
import { useCommandCenter } from "@/lib/useCommandCenter";
import { useAutoSync } from "@/lib/useSync";
import { emitFx, setFxActivity, setFxScene } from "./fx/fxBus";
import { useFxMode } from "./fx/fxMode";
import { LiveBackground } from "./fx/LiveBackground";
import { useBackLayer, useBackStackInstall } from "./lib/backStack";
import { haptic } from "./lib/haptics";
import { useSlidingPill } from "./lib/motion";
import { useTheme } from "./lib/theme";
import {
  AppDataContext,
  ChatContext,
  FinishActionContext,
  FinishContext,
  LookContext,
  NavActionsContext,
  NavStateContext,
  PhoneRootContext,
  SyncContext,
  useAppData,
  useFinishing,
  useLook,
  useNav,
  useNavState,
  useReminders,
  type AppData,
  type Layer,
  type Look,
  type NavActions,
  type NavState,
  type PlanSection,
  type TabId,
} from "./PhoneContext";
import { ChatScreen } from "./screens/ChatScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { NotebookScreen } from "./screens/NotebookScreen";
import { PlanScreen } from "./screens/PlanScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { Tap } from "./ui/Tap";
import { Icon3D, type Icon3DName } from "./ui/Icon3D";
import { HoloFace } from "./voice/HoloFace";

// Development only: `?instant` skips JS animations, for checking layouts in
// a preview that is not being painted (where frames barely advance).
if (process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("instant")) {
  MotionGlobalConfig.skipAnimations = true;
}

// Heavy and rarely opened: loaded on first use.
const SettingsScreen = dynamic(() => import("./screens/SettingsScreen").then((m) => m.SettingsScreen), { ssr: false });
const VoiceScreen = dynamic(() => import("./voice/VoiceScreen").then((m) => m.VoiceScreen), { ssr: false });

const TABS: Array<{ id: TabId; label: string; icon: Icon3DName }> = [
  { id: "today", label: "Today", icon: "home" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "plan", label: "Plan", icon: "plan" },
  { id: "memory", label: "Memory", icon: "memory" },
];

/*
 * Screens never take props, so memoising them means a navigation or data
 * change elsewhere never re-renders a whole screen by accident; each screen
 * re-renders only for the context slices it reads.
 */
const Today = React.memo(TodayScreen);
const Tasks = React.memo(TasksScreen);
const Plan = React.memo(PlanScreen);
const Memory = React.memo(MemoryScreen);

/**
 * The phone app. `useCommandCenter` still owns every record, the runtime
 * handshake and voice availability (shared with the desktop page); this is
 * only how it looks and moves on a phone.
 */
export function PhoneApp() {
  return (
    <LookProvider>
      <DataProvider>
        <SyncProvider>
          <ChatProvider>
            <NavProvider>
              <Shell />
            </NavProvider>
          </ChatProvider>
        </SyncProvider>
      </DataProvider>
    </LookProvider>
  );
}

function LookProvider({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const fx = useFxMode();
  const value = React.useMemo<Look>(
    () => ({ choice: theme.choice, choose: theme.choose, dark: theme.dark, fx: fx.mode, setFx: fx.choose }),
    [theme.choice, theme.choose, theme.dark, fx.mode, fx.choose],
  );
  return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}

function DataProvider({ children }: { children: React.ReactNode }) {
  const center = useCommandCenter();
  const reminders = useReminders(center.state);
  // `useCommandCenter` builds a fresh object every render; hold one per real
  // change so readers do not re-render when nothing they use has moved.
  const app = React.useMemo(
    () => center,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.state, center.loading, center.refreshing, center.error, center.voiceOpen, center.settingsOpen, center.voiceAvailable, center.recordsLocal, center.localOnly, center.status, center.handleToggleTask, center.handleRecordChanged, center.handleAgentRefresh, center.handleSynced, center.refresh],
  );
  const value = React.useMemo<AppData>(
    () => ({
      app,
      mode: { local: app.recordsLocal },
      reminders: reminders.reminders,
      remindersLoaded: reminders.loaded,
      reloadReminders: reminders.reload,
    }),
    [app, reminders.reminders, reminders.loaded, reminders.reload],
  );
  const finishing = useFinishing(app.handleToggleTask);
  return (
    <AppDataContext.Provider value={value}>
      <FinishActionContext.Provider value={finishing.finish}>
        <FinishContext.Provider value={finishing}>{children}</FinishContext.Provider>
      </FinishActionContext.Provider>
    </AppDataContext.Provider>
  );
}

/** The phone runs the only sync engine; its status feeds the top bar. */
function SyncProvider({ children }: { children: React.ReactNode }) {
  const { app } = useAppData();
  const sync = useAutoSync({ enabled: app.recordsLocal, onPulled: app.handleSynced });
  React.useEffect(() => {
    setFxActivity("sync", sync.phase === "syncing" ? 0.25 : 0);
  }, [sync.phase]);
  return <SyncContext.Provider value={sync}>{children}</SyncContext.Provider>;
}

/** The conversation lives here, so closing chat keeps drafts and streams. */
function ChatProvider({ children }: { children: React.ReactNode }) {
  const { app } = useAppData();
  const chat = useChatSession({ onRefresh: app.handleAgentRefresh, onSurface: app.setSurface });
  const wasStreaming = React.useRef(false);
  React.useEffect(() => {
    // JARVIS typing stirs the background; a finished reply settles it.
    setFxActivity("stream", chat.streaming ? 0.75 : 0);
    if (wasStreaming.current && !chat.streaming) emitFx("select", { x: 0.5, y: 0.82 });
    wasStreaming.current = chat.streaming;
  }, [chat.streaming]);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

function NavProvider({ children }: { children: React.ReactNode }) {
  const { app } = useAppData();
  const [tab, setTab] = React.useState<TabId>("today");
  const [visited, setVisited] = React.useState<ReadonlySet<TabId>>(() => new Set<TabId>(["today"]));
  const [planSection, setPlanSection] = React.useState<PlanSection>("routine");
  const [layers, setLayers] = React.useState<Layer[]>([]);
  const [chatOpen, setChatOpen] = React.useState(false);
  const tabRef = React.useRef(tab);
  tabRef.current = tab;

  const go = React.useCallback((next: TabId) => {
    const from = TABS.findIndex((item) => item.id === tabRef.current);
    const to = TABS.findIndex((item) => item.id === next);
    if (from !== to) {
      emitFx("tab", undefined, to > from ? 1 : -1);
      setFxScene(next);
    }
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);
  const openPlan = React.useCallback((section: PlanSection) => {
    setPlanSection(section);
    go("plan");
  }, [go]);
  const push = React.useCallback((layer: Layer) => setLayers((current) => [...current, layer]), []);
  const pop = React.useCallback(() => setLayers((current) => current.slice(0, -1)), []);
  const openChat = React.useCallback(() => setChatOpen(true), []);
  const closeChat = React.useCallback(() => setChatOpen(false), []);
  const { voiceAvailable, setVoiceOpen } = app;
  const openVoice = React.useCallback(() => {
    if (voiceAvailable) {
      setVoiceOpen(true);
      return;
    }
    haptic("warning");
    toast.error("Voice isn't ready yet", {
      description: "Check the connection and keys in Settings, then allow the microphone.",
      action: { label: "Settings", onClick: () => setLayers((current) => [...current, { kind: "settings" }]) },
    });
  }, [voiceAvailable, setVoiceOpen]);

  const actions = React.useMemo<NavActions>(
    () => ({ go, openPlan, push, pop, openChat, closeChat, openVoice }),
    [go, openPlan, push, pop, openChat, closeChat, openVoice],
  );
  const state = React.useMemo<NavState>(() => ({ tab, visited, planSection, layers, chatOpen }), [tab, visited, planSection, layers, chatOpen]);

  // Pre-mount the other tabs once the first screen has settled, so the first
  // switch to each one is an animation, not a render.
  React.useEffect(() => {
    const host = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const warm = () => setVisited(new Set<TabId>(TABS.map((item) => item.id)));
    if (host.requestIdleCallback) {
      const handle = host.requestIdleCallback(warm, { timeout: 2500 });
      return () => host.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <NavActionsContext.Provider value={actions}>
      <NavStateContext.Provider value={state}>{children}</NavStateContext.Provider>
    </NavActionsContext.Provider>
  );
}

function Shell() {
  const { app } = useAppData();
  const { tab, visited, layers, chatOpen } = useNavState();
  const look = useLook();
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
  useBackStackInstall();
  useKeyboardInset(root);
  const covered = layers.length > 0 || chatOpen;

  return (
    <PhoneRootContext.Provider value={root}>
      <MotionConfig reducedMotion="user">
        <div ref={setRoot} className="ph" data-theme={look.dark ? "dark" : "light"} data-tab={tab} data-covered={covered}>
          <div className="ph-app">
            <LiveBackground mode={look.fx} light={!look.dark} paused={app.voiceOpen} />
            <span className="ph-grain" aria-hidden="true" />
            <motion.main
              className="ph-panes"
              initial={false}
              animate={covered ? { opacity: 0, transform: "translateX(-28px)" } : { opacity: 1, transform: "translateX(0px)" }}
              transition={covered ? { duration: 0.2, ease: [0.4, 0, 1, 1] } : { type: "spring", stiffness: 380, damping: 38 }}
            >
              <Pane active={tab === "today" && !covered}><Today /></Pane>
              {visited.has("tasks") && <Pane active={tab === "tasks" && !covered}><Tasks /></Pane>}
              {visited.has("plan") && <Pane active={tab === "plan" && !covered}><Plan /></Pane>}
              {visited.has("memory") && <Pane active={tab === "memory" && !covered}><Memory /></Pane>}
            </motion.main>
            <Dock hidden={covered} />
            <AnimatePresence>
              {layers.map((layer, index) => (
                <LayerView key={`${layer.kind}-${index}`} layer={layer} />
              ))}
            </AnimatePresence>
            <AnimatePresence>{chatOpen && <ChatScreen key="chat" />}</AnimatePresence>
          </div>
          <AnimatePresence>{app.voiceOpen && <VoiceScreen key="voice" />}</AnimatePresence>
          <Toaster
            theme={look.dark ? "dark" : "light"}
            position="bottom-center"
            offset={{ bottom: 104 }}
            mobileOffset={{ bottom: 104, left: 12, right: 12 }}
            gap={10}
            toastOptions={{ unstyled: true, classNames: { toast: "ph-toast", title: "ph-toast-title", description: "ph-toast-desc", actionButton: "ph-toast-action", icon: "ph-toast-icon", success: "ph-toast-success", error: "ph-toast-error" } }}
          />
          {process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_API_BASE === "http://127.0.0.1:8101" && (
            <div className="ph-fixture-tag">Design preview · sample data</div>
          )}
        </div>
      </MotionConfig>
    </PhoneRootContext.Provider>
  );
}

/**
 * Keep typing surfaces above the on-screen keyboard.
 *
 * When the WebView itself shrinks for the keyboard nothing is needed and the
 * inset stays 0. When only the visual viewport shrinks, the difference is
 * published as `--kb` so the chat composer can lift by exactly that much.
 */
function useKeyboardInset(root: HTMLElement | null) {
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      root.style.setProperty("--kb", `${inset > 80 ? inset : 0}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [root]);
}

/**
 * A tab's screen. Kept mounted so its scroll and state survive switching.
 * The swap animates `transform` and `opacity` as whole values, which framer
 * hands to the compositor, so it stays smooth even while React is busy.
 * Once a pane has faded out it goes idle (`content-visibility: hidden`), so
 * the hidden tabs cost nothing to style, lay out or paint.
 */
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLElement>(null);
  const [idle, setIdle] = React.useState(!active);
  const activeNow = React.useRef(active);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    activeNow.current = active;
    if (ref.current) ref.current.inert = !active;
    // Awake from any change until a leave animation has fully played out.
    if (mounted.current) setIdle(false);
    mounted.current = true;
  }, [active]);
  return (
    <motion.section
      ref={ref}
      className="ph-pane"
      data-idle={idle && !active}
      aria-hidden={!active}
      initial={false}
      animate={active ? "on" : "off"}
      onAnimationComplete={(definition) => {
        if (definition === "off" && !activeNow.current) setIdle(true);
      }}
      variants={{
        on: { opacity: 1, transform: "translateY(0px)", transition: { type: "spring", stiffness: 420, damping: 40, delay: 0.04 } },
        off: { opacity: 0, transform: "translateY(10px)", transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } },
      }}
    >
      {children}
    </motion.section>
  );
}

function LayerView({ layer }: { layer: Layer }) {
  const { pop } = useNav();
  useBackLayer(useIsPresent(), pop);
  return (
    <motion.div
      className="ph-layer"
      initial={{ transform: "translateX(100%)" }}
      animate={{ transform: "translateX(0%)" }}
      exit={{ transform: "translateX(100%)" }}
      transition={{ type: "spring", stiffness: 380, damping: 42 }}
    >
      {layer.kind === "settings" && <SettingsScreen />}
      {layer.kind === "notebook" && <NotebookScreen uid={layer.uid} initialView={layer.view} fallback={layer.page} />}
    </motion.div>
  );
}

/** The floating dock: four tabs around JARVIS's orb. */
function Dock({ hidden }: { hidden: boolean }) {
  const { tab } = useNavState();
  const { go, openVoice } = useNav();
  const { app } = useAppData();
  const ref = React.useRef<HTMLElement>(null);
  const { container, pill } = useSlidingPill<HTMLDivElement, HTMLSpanElement>(TABS.findIndex((item) => item.id === tab), ".ph-dock-item");
  React.useEffect(() => {
    if (ref.current) ref.current.inert = hidden;
  }, [hidden]);
  const left = TABS.slice(0, 2);
  const right = TABS.slice(2);
  const item = ({ id, label, icon }: (typeof TABS)[number]) => {
    const active = tab === id;
    return (
      <button
        key={id}
        type="button"
        className="ph-dock-item"
        data-active={active}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        onClick={() => {
          if (active) return;
          haptic("select");
          go(id);
        }}
      >
        <span className="ph-dock-icon" data-bounce={active}>
          <Icon3D name={icon} size={30} />
        </span>
        <span className="ph-dock-label">{label}</span>
      </button>
    );
  };
  return (
    <motion.nav
      ref={ref}
      className="ph-dock"
      aria-label="Main"
      aria-hidden={hidden || undefined}
      initial={false}
      animate={hidden ? { transform: "translateY(140px)", opacity: 0 } : { transform: "translateY(0px)", opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
    >
      <div ref={container} className="ph-dock-row">
        <span ref={pill} className="ph-dock-pill" aria-hidden="true" />
        {left.map(item)}
        <Tap className="ph-dock-orb" aria-label="Talk to JARVIS" onClick={openVoice} squish={0.86} feel="heavy" data-offline={!app.voiceAvailable}>
          <span className="ph-dock-orb-inner">
            <HoloFace size={56} />
          </span>
        </Tap>
        {right.map(item)}
      </div>
    </motion.nav>
  );
}
