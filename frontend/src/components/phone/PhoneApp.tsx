"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, LayoutGroup, motion, MotionConfig, MotionGlobalConfig, useIsPresent } from "framer-motion";
import { Toaster, toast } from "sonner";
import { Brain, CalendarDots, CheckSquare, House } from "@phosphor-icons/react";

import { useChatSession } from "@/lib/useChatSession";
import { useCommandCenter } from "@/lib/useCommandCenter";
import { useAutoSync } from "@/lib/useSync";
import { useBackLayer, useBackStackInstall } from "./lib/backStack";
import { haptic } from "./lib/haptics";
import { useTheme } from "./lib/theme";
import {
  PhoneContext,
  PhoneRootContext,
  useFinishing,
  usePhone,
  useReminders,
  type Layer,
  type PhoneModel,
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
import { Orb } from "./voice/Orb";

// Development only: `?instant` skips JS animations, for checking layouts in
// a preview that is not being painted (where frames barely advance).
if (process.env.NODE_ENV === "development" && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("instant")) {
  MotionGlobalConfig.skipAnimations = true;
}

// Heavy and rarely opened: loaded on first use.
const SettingsScreen = dynamic(() => import("./screens/SettingsScreen").then((m) => m.SettingsScreen), { ssr: false });
const VoiceScreen = dynamic(() => import("./voice/VoiceScreen").then((m) => m.VoiceScreen), { ssr: false });

const TABS: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
  { id: "today", label: "Today", icon: House },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "plan", label: "Plan", icon: CalendarDots },
  { id: "memory", label: "Memory", icon: Brain },
];

/**
 * The phone app. `useCommandCenter` still owns every record, the runtime
 * handshake and voice availability (shared with the desktop page); this is
 * only how it looks and moves on a phone.
 */
export function PhoneApp() {
  const app = useCommandCenter();
  const theme = useTheme();
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
  const [tab, setTab] = React.useState<TabId>("today");
  const [visited, setVisited] = React.useState<ReadonlySet<TabId>>(() => new Set<TabId>(["today"]));
  const [planSection, setPlanSection] = React.useState<PlanSection>("routine");
  const [layers, setLayers] = React.useState<Layer[]>([]);
  const [chatOpen, setChatOpen] = React.useState(false);
  useBackStackInstall();
  useKeyboardInset(root);

  // The only sync engine on the phone; its status shows in the top bar.
  const sync = useAutoSync({ enabled: app.recordsLocal, onPulled: app.handleSynced });
  // The conversation lives here, so closing chat keeps drafts and streams.
  const chat = useChatSession({ onRefresh: app.handleAgentRefresh, onSurface: app.setSurface });
  const reminders = useReminders(app.state);
  const { checked, finishing, finish } = useFinishing(app.handleToggleTask);

  const go = React.useCallback((next: TabId) => {
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
      action: { label: "Settings", onClick: () => push({ kind: "settings" }) },
    });
  }, [voiceAvailable, setVoiceOpen, push]);

  const model: PhoneModel = {
    app,
    mode: { local: app.recordsLocal },
    chat,
    tab,
    go,
    planSection,
    openPlan,
    layers,
    push,
    pop,
    chatOpen,
    openChat,
    closeChat,
    openVoice,
    reminders: reminders.reminders,
    remindersLoaded: reminders.loaded,
    reloadReminders: reminders.reload,
    checked,
    finishing,
    finish,
    theme,
    sync,
  };

  const covered = layers.length > 0 || chatOpen;

  return (
    <PhoneRootContext.Provider value={root}>
      <PhoneContext.Provider value={model}>
        <MotionConfig reducedMotion="user">
          <LayoutGroup>
            <div ref={setRoot} className="ph" data-theme={theme.dark ? "dark" : "light"} data-tab={tab}>
              <div className="ph-app" data-vaul-drawer-wrapper="">
                <Backdrop tab={tab} />
                <motion.main
                  className="ph-panes"
                  animate={{ x: covered ? -36 : 0, scale: covered ? 0.97 : 1 }}
                  transition={{ type: "spring", stiffness: 360, damping: 38 }}
                >
                  {TABS.map(({ id }) => visited.has(id) && (
                    <Pane key={id} active={tab === id && !covered}>
                      {id === "today" && <TodayScreen />}
                      {id === "tasks" && <TasksScreen />}
                      {id === "plan" && <PlanScreen />}
                      {id === "memory" && <MemoryScreen />}
                    </Pane>
                  ))}
                </motion.main>
                <Dock hidden={covered} />
                <AnimatePresence>
                  {covered && (
                    <motion.div key="scrim" className="ph-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {layers.map((layer, index) => (
                    <LayerView key={`${layer.kind}-${index}`} layer={layer} />
                  ))}
                </AnimatePresence>
                <AnimatePresence>{chatOpen && <ChatScreen key="chat" />}</AnimatePresence>
              </div>
              <AnimatePresence>{app.voiceOpen && <VoiceScreen key="voice" />}</AnimatePresence>
              <Toaster
                theme={theme.dark ? "dark" : "light"}
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
          </LayoutGroup>
        </MotionConfig>
      </PhoneContext.Provider>
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

/** A tab's screen. Kept mounted so its scroll and state survive switching. */
function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.inert = !active;
  }, [active]);
  return (
    <motion.section
      ref={ref}
      className="ph-pane"
      aria-hidden={!active}
      initial={false}
      animate={active ? "on" : "off"}
      variants={{
        on: { opacity: 1, scale: 1, y: 0, visibility: "visible", transition: { type: "spring", stiffness: 420, damping: 36, delay: 0.03 } },
        off: { opacity: 0, scale: 0.985, y: 8, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] }, transitionEnd: { visibility: "hidden" } },
      }}
    >
      {children}
    </motion.section>
  );
}

function LayerView({ layer }: { layer: Layer }) {
  const { pop } = usePhone();
  useBackLayer(useIsPresent(), pop);
  return (
    <motion.div
      className="ph-layer"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 380, damping: 40 }}
    >
      {layer.kind === "settings" && <SettingsScreen />}
      {layer.kind === "notebook" && <NotebookScreen uid={layer.uid} initialView={layer.view} fallback={layer.page} />}
    </motion.div>
  );
}

/** The floating dock: four tabs around JARVIS's orb. */
function Dock({ hidden }: { hidden: boolean }) {
  const { tab, go, openVoice, app } = usePhone();
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.inert = hidden;
  }, [hidden]);
  const left = TABS.slice(0, 2);
  const right = TABS.slice(2);
  const item = ({ id, label, icon: Icon }: (typeof TABS)[number]) => {
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
        {active && <motion.span layoutId="dock-pill" className="ph-dock-pill" transition={{ type: "spring", stiffness: 480, damping: 32 }} />}
        <motion.span
          className="ph-dock-icon"
          animate={active ? { scale: [1, 1.28, 1], rotate: [0, -10, 0] } : { scale: 1, rotate: 0 }}
          transition={{ duration: 0.42, ease: [0.34, 1.56, 0.64, 1] }}
        >
          <Icon size={24} weight={active ? "fill" : "bold"} />
        </motion.span>
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
      animate={hidden ? { y: 140, opacity: 0 } : { y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
    >
      {left.map(item)}
      <Tap className="ph-dock-orb" aria-label="Talk to JARVIS" onClick={openVoice} squish={0.86} feel="heavy" data-offline={!app.voiceAvailable}>
        {!app.voiceOpen && (
          <motion.span layoutId="jarvis-orb" className="ph-dock-orb-inner" transition={{ type: "spring", stiffness: 210, damping: 26 }}>
            <Orb size={56} />
          </motion.span>
        )}
      </Tap>
      {right.map(item)}
    </motion.nav>
  );
}

/** Soft colour pools behind the screens, shifting hue with the tab. */
function Backdrop({ tab }: { tab: TabId }) {
  return (
    <div className="ph-backdrop" data-tab={tab} aria-hidden="true">
      <span className="ph-pool ph-pool-a" />
      <span className="ph-pool ph-pool-b" />
      <span className="ph-pool ph-pool-c" />
      <span className="ph-grain" />
    </div>
  );
}
