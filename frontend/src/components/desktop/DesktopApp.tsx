"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Toaster } from "sonner";
import { Brain, CalendarDots, CheckSquare, GearSix, House } from "@phosphor-icons/react";

import { LiveBackground } from "../phone/fx/LiveBackground";
import { useBackStackInstall } from "../phone/lib/backStack";
import { haptic } from "../phone/lib/haptics";
import { reducedMotion, spring } from "../phone/lib/motion";
import { ChatProvider, DataProvider, LayerView, LookProvider, NavProvider, Pane, SyncDot, SyncProvider } from "../phone/PhoneApp";
import { SeriousProvider, useSerious } from "../phone/serious/SeriousContext";
import { PhoneRootContext, useAppData, useLook, useNav, useNavState, type TabId } from "../phone/PhoneContext";
import { ChatScreen } from "../phone/screens/ChatScreen";
import { MemoryScreen } from "../phone/screens/MemoryScreen";
import { PlanScreen } from "../phone/screens/PlanScreen";
import { TasksScreen } from "../phone/screens/TasksScreen";
import { TodayScreen } from "../phone/screens/TodayScreen";
import { Tap } from "../phone/ui/Tap";
import { HoloFace } from "../phone/voice/HoloFace";
import { DesktopRuntime } from "./DesktopRuntime";

const VoiceScreen = dynamic(() => import("../phone/voice/VoiceScreen").then((m) => m.VoiceScreen), { ssr: false });

const TABS: Array<{ id: TabId; label: string; icon: React.ElementType; key: string }> = [
  { id: "today", label: "Today", icon: House, key: "1" },
  { id: "tasks", label: "Tasks", icon: CheckSquare, key: "2" },
  { id: "plan", label: "Plan", icon: CalendarDots, key: "3" },
  { id: "memory", label: "Memory", icon: Brain, key: "4" },
];

const Today = React.memo(TodayScreen);
const Tasks = React.memo(TasksScreen);
const Plan = React.memo(PlanScreen);
const Memory = React.memo(MemoryScreen);

/**
 * The desktop app in the phone's design.
 *
 * It reuses the phone's providers, screens, sheets, chat and voice exactly as
 * they are and only arranges them for a wide window: a rail on the left, the
 * screen in the middle, chat always open on the right. Everything that differs
 * lives here and in `desktop.css`, whose rules all sit under `.dk`, a class
 * only this shell renders, so the phone app itself is untouched.
 */
export function DesktopApp() {
  return (
    <LookProvider>
      <DataProvider>
        <SyncProvider>
          <ChatProvider>
            <NavProvider>
              <SeriousProvider>
                <DesktopShell />
              </SeriousProvider>
            </NavProvider>
          </ChatProvider>
        </SyncProvider>
      </DataProvider>
    </LookProvider>
  );
}

function focusComposer(root: HTMLElement | null) {
  root?.querySelector<HTMLTextAreaElement>(".dk-chat textarea")?.focus();
}

function DesktopShell() {
  // Lock-in's ember theme while a serious session runs, same as the phone.
  const lockin = Boolean(useSerious()?.running);
  const { app } = useAppData();
  const { tab, visited, layers, chatOpen } = useNavState();
  const { go, pop, push, closeChat } = useNav();
  const look = useLook();
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
  const chatColumn = React.useRef<HTMLElement>(null);
  useBackStackInstall();
  const covered = layers.length > 0;

  // Asking JARVIS from a screen opens the chat sheet on the phone. Here chat
  // is always on screen, so the request only puts the cursor in it.
  React.useEffect(() => {
    if (!chatOpen) return;
    focusComposer(root);
    closeChat();
  }, [chatOpen, closeChat, root]);

  const openTab = React.useCallback(
    (id: TabId) => {
      for (let i = 0; i < layers.length; i += 1) pop();
      if (tab !== id) go(id);
    },
    [go, layers.length, pop, tab],
  );

  // Desktop keys: Ctrl+1..4 switch screens, Ctrl+K types to JARVIS,
  // Ctrl+, opens Settings, Esc closes the page on top.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const target = TABS.find((item) => item.key === event.key);
      if (mod && target) {
        event.preventDefault();
        openTab(target.id);
      } else if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusComposer(root);
      } else if (mod && event.key === ",") {
        event.preventDefault();
        push({ kind: "settings" });
      } else if (event.key === "Escape" && layers.length && !root?.querySelector(".ph-sheet") && !app.voiceOpen) {
        pop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app.voiceOpen, layers.length, openTab, pop, push, root]);

  // The phone chat's header is a drag handle that pulls the sheet down to
  // close it. A docked chat has nothing to close, so a press on the header
  // (its buttons excepted) never reaches that handler.
  React.useEffect(() => {
    const node = chatColumn.current;
    if (!node) return;
    const guard = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".ph-chat-head") && !target.closest("button, a, [role='button']")) event.stopPropagation();
    };
    node.addEventListener("pointerdown", guard, true);
    return () => node.removeEventListener("pointerdown", guard, true);
  }, []);

  return (
    <PhoneRootContext.Provider value={root}>
      <MotionConfig reducedMotion="user">
        <div ref={setRoot} className="ph dk" data-theme={look.dark ? "dark" : "light"} data-tab={tab} data-covered={covered} data-lockin={lockin || undefined}>
          <div className="ph-app">
            <LiveBackground mode={look.fx} light={!look.dark} paused={app.voiceOpen} />
            <span className="ph-grain" aria-hidden="true" />
            <div className="dk-frame">
              <DesktopRail onSelect={openTab} />
              <div className="dk-center">
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
                <AnimatePresence>
                  {layers.map((layer, index) => (
                    <LayerView key={`${layer.kind}-${index}`} layer={layer} covered={index < layers.length - 1} />
                  ))}
                </AnimatePresence>
              </div>
              <aside ref={chatColumn} className="dk-chat-col" aria-label="Chat with JARVIS">
                <div className="dk-chat">
                  <ChatScreen />
                </div>
                <DesktopRuntime />
              </aside>
            </div>
          </div>
          <AnimatePresence>{app.voiceOpen && <VoiceScreen key="voice" />}</AnimatePresence>
          <SyncDot />
          <Toaster
            theme={look.dark ? "dark" : "light"}
            position="bottom-center"
            offset={{ bottom: 24 }}
            gap={10}
            toastOptions={{ unstyled: true, classNames: { toast: "ph-toast", title: "ph-toast-title", description: "ph-toast-desc", actionButton: "ph-toast-action", icon: "ph-toast-icon", success: "ph-toast-success", error: "ph-toast-error" } }}
          />
        </div>
      </MotionConfig>
    </PhoneRootContext.Provider>
  );
}

/** Where the lime pill should sit, gliding down or up the rail like the dock's. */
function glideY(pill: HTMLElement, y: number, instant: boolean) {
  const current = new DOMMatrix(getComputedStyle(pill).transform);
  const from = current.m42;
  for (const animation of pill.getAnimations()) animation.cancel();
  pill.style.transform = `translateY(${y}px)`;
  const distance = y - from;
  if (instant || Math.abs(distance) < 0.5 || reducedMotion() || typeof pill.animate !== "function") return;
  const stretch = 1 + Math.min(0.32, Math.abs(distance) / 480);
  const { easing, duration } = spring(520, 34);
  pill.animate(
    [
      { transform: `translateY(${from}px) scaleY(1)` },
      { transform: `translateY(${from + distance * 0.5}px) scaleY(${stretch})`, offset: 0.32 },
      { transform: `translateY(${y}px) scaleY(1)` },
    ],
    { duration, easing },
  );
}

/** The dock, stood on its side: four screens around JARVIS's orb. */
function DesktopRail({ onSelect }: { onSelect: (id: TabId) => void }) {
  const { tab } = useNavState();
  const { openVoice, push } = useNav();
  const { app } = useAppData();
  const row = React.useRef<HTMLDivElement>(null);
  const pill = React.useRef<HTMLSpanElement>(null);
  const placed = React.useRef(false);
  const index = TABS.findIndex((item) => item.id === tab);

  const place = React.useCallback(
    (instant: boolean) => {
      const box = row.current;
      const node = pill.current;
      const item = box?.querySelectorAll<HTMLElement>(".ph-dock-item")[index];
      if (!box || !node || !item) return;
      node.style.opacity = "1";
      node.style.width = `${item.offsetWidth}px`;
      node.style.height = `${item.offsetHeight}px`;
      node.style.left = `${item.offsetLeft}px`;
      glideY(node, item.offsetTop, instant || !placed.current);
      placed.current = true;
    },
    [index],
  );

  React.useLayoutEffect(() => place(false), [place]);
  React.useEffect(() => {
    const box = row.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(true));
    observer.observe(box);
    return () => observer.disconnect();
  }, [place]);

  const item = ({ id, label, icon: Icon, key }: (typeof TABS)[number]) => {
    const active = tab === id;
    return (
      <button
        key={id}
        type="button"
        className="ph-dock-item"
        data-active={active}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        title={`${label}  (Ctrl+${key})`}
        onClick={() => {
          haptic("select");
          onSelect(id);
        }}
      >
        <span className="ph-dock-icon" data-bounce={active}>
          <Icon size={24} weight={active ? "fill" : "bold"} />
        </span>
        <span className="ph-dock-label">{label}</span>
      </button>
    );
  };

  return (
    <nav className="dk-rail" aria-label="Main">
      <span className="dk-brand" aria-hidden="true">JARVIS</span>
      <div ref={row} className="dk-rail-tabs">
        <span ref={pill} className="ph-dock-pill" aria-hidden="true" />
        {TABS.slice(0, 2).map(item)}
        <Tap className="ph-dock-orb dk-rail-orb" aria-label="Talk to JARVIS" title="Talk to JARVIS" onClick={openVoice} squish={0.86} feel="heavy" data-offline={!app.voiceAvailable}>
          <span className="ph-dock-orb-inner">
            <HoloFace size={56} />
          </span>
        </Tap>
        {TABS.slice(2).map(item)}
      </div>
      <div className="dk-rail-foot">
        <Tap className="dk-rail-btn" aria-label="Settings" title="Settings  (Ctrl+,)" onClick={() => push({ kind: "settings" })} feel="select">
          <GearSix size={22} weight="bold" />
        </Tap>
      </div>
    </nav>
  );
}
