"use client";

import * as React from "react";
import { toast } from "sonner";

import { fetchReminders } from "@/lib/api";
import type { CommandCenter } from "@/lib/useCommandCenter";
import type { ChatSessionModel } from "@/lib/useChatSession";
import type { RecordsMode } from "@/lib/records";
import type { AutoSyncState } from "@/lib/useSync";
import type { NotePage, Reminder, Task } from "@/types";
import { burstFrom } from "./lib/confetti";
import { haptic } from "./lib/haptics";
import type { ThemeChoice } from "./lib/theme";

export type TabId = "today" | "tasks" | "plan" | "memory";
export type PlanSection = "routine" | "college" | "session" | "reminders";
export type MemoryView = "ALL" | "SEMANTIC" | "PROCEDURAL" | "EPISODIC" | "PROSPECTIVE" | "REFLECTIVE" | "REVIEW";

export type Layer =
  | { kind: "settings" }
  | { kind: "notebook"; uid: string; view?: MemoryView; page?: NotePage };

export interface PhoneModel {
  app: CommandCenter;
  mode: RecordsMode;
  chat: ChatSessionModel;
  tab: TabId;
  go: (tab: TabId) => void;
  planSection: PlanSection;
  openPlan: (section: PlanSection) => void;
  layers: Layer[];
  push: (layer: Layer) => void;
  pop: () => void;
  chatOpen: boolean;
  openChat: () => void;
  closeChat: () => void;
  openVoice: () => void;
  reminders: Reminder[];
  remindersLoaded: boolean;
  reloadReminders: () => Promise<void>;
  /** Tasks just ticked: their check is showing. */
  checked: ReadonlySet<number>;
  /** Tasks finished in the last few seconds, hidden while Undo is on offer. */
  finishing: ReadonlySet<number>;
  finish: (task: Task, origin?: Element | null) => void;
  theme: { choice: ThemeChoice; choose: (choice: ThemeChoice) => void; dark: boolean };
  /** Automatic sync status (mobile runs the only sync engine). */
  sync: AutoSyncState;
}

export const PhoneContext = React.createContext<PhoneModel | null>(null);
export const PhoneRootContext = React.createContext<HTMLElement | null>(null);

export function usePhone(): PhoneModel {
  const model = React.useContext(PhoneContext);
  if (!model) throw new Error("usePhone must be used inside PhoneApp");
  return model;
}

/** The themed root element; sheets and menus portal into it. */
export function usePhoneRoot(): HTMLElement | null {
  return React.useContext(PhoneRootContext);
}

/** A clock for "now" copy, ticking on the minute. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, intervalMs);
    const wake = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Reminders live outside the dashboard (each device fires its own), so they
 * are fetched separately — once at start and again after every dashboard
 * refresh, which is when a voice or chat turn may have added one.
 */
export function useReminders(refreshKey: unknown) {
  const [reminders, setReminders] = React.useState<Reminder[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const reload = React.useCallback(async () => {
    try {
      setReminders(await fetchReminders());
    } catch {
      // Keep the last list rather than flashing to empty on a transient miss.
    } finally {
      setLoaded(true);
    }
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { reminders, loaded, reload };
}

const UNDO_MS = 4200;

/**
 * Finishing a task, with a moment to take it back.
 *
 * Completing removes a task for good (the board holds open work only), so the
 * write is held for a few seconds behind an Undo toast. Leaving the app
 * commits anything still waiting, so nothing finished is ever lost.
 *
 * `checked` flips at once (the row plays its check); `finishing` follows a
 * beat later and is what lists hide, so the row leaves after the check lands.
 */
export function useFinishing(toggle: CommandCenter["handleToggleTask"]) {
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(() => new Set());
  const [finishing, setFinishing] = React.useState<ReadonlySet<number>>(() => new Set());
  const waiting = React.useRef(new Map<number, { timer: number; hide: number; commit: () => void }>());
  const toggleRef = React.useRef(toggle);
  toggleRef.current = toggle;

  const drop = React.useCallback((id: number) => {
    const without = (current: ReadonlySet<number>) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    };
    setChecked(without);
    setFinishing(without);
  }, []);

  const finish = React.useCallback((task: Task, origin?: Element | null) => {
    if (waiting.current.has(task.id)) return;
    haptic("success");
    burstFrom(origin ?? null);
    setChecked((current) => new Set(current).add(task.id));
    const hide = window.setTimeout(() => setFinishing((current) => new Set(current).add(task.id)), 380);
    const commit = () => {
      const entry = waiting.current.get(task.id);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      window.clearTimeout(entry.hide);
      waiting.current.delete(task.id);
      setFinishing((current) => new Set(current).add(task.id));
      void Promise.resolve(toggleRef.current(task.id, "COMPLETED")).finally(() => drop(task.id));
    };
    const timer = window.setTimeout(commit, UNDO_MS);
    waiting.current.set(task.id, { timer, hide, commit });
    toast.success("Done and dusted", {
      id: `finish-${task.id}`,
      description: task.title,
      duration: UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => {
          const entry = waiting.current.get(task.id);
          if (!entry) return;
          window.clearTimeout(entry.timer);
          window.clearTimeout(entry.hide);
          waiting.current.delete(task.id);
          haptic("toggle-off");
          drop(task.id);
        },
      },
    });
  }, [drop]);

  React.useEffect(() => {
    const flush = () => {
      for (const { commit } of [...waiting.current.values()]) commit();
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { checked, finishing, finish };
}
