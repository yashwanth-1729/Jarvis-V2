"use client";

/**
 * Which tasks and blocks are serious, and which one is running, for the whole
 * app (Today, Tasks, the timeline and the Lock-in bar), not just the Lock-in
 * screen. Reloads whenever serious mode changes anywhere (lib/focus.ts
 * announces every change) and while a session runs it turns the live
 * background to embers.
 */
import * as React from "react";

import { FOCUS_CHANGED, fetchFocus, type FocusEvent, type FocusItem } from "@/lib/focus";
import { setFxTheme } from "../fx/fxBus";

export interface SeriousState {
  items: ReadonlyMap<string, FocusItem>;
  /** The session in progress, if any (the newest one started). */
  running: { item: FocusItem; event: FocusEvent } | null;
  eventFor: (uid: string, occurrence: string) => FocusEvent | undefined;
  reload: () => void;
}

const SeriousContext = React.createContext<SeriousState | null>(null);

/** "YYYY-MM-DD" in local time: a block's occurrence. */
export function dayKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function SeriousProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ReadonlyMap<string, FocusItem>>(() => new Map());
  const [events, setEvents] = React.useState<FocusEvent[]>([]);

  const reload = React.useCallback(() => {
    fetchFocus()
      .then((next) => {
        setItems(new Map(next.items.map((item) => [item.uid, item])));
        setEvents(next.events);
      })
      .catch(() => {
        // The backend may still be starting; the next change or poll retries.
      });
  }, []);

  React.useEffect(() => {
    reload();
    const onVisible = () => document.visibilityState === "visible" && reload();
    window.addEventListener(FOCUS_CHANGED, reload);
    document.addEventListener("visibilitychange", onVisible);
    // The backend boots alongside the UI on the phone: retry until it answers.
    const early = window.setInterval(reload, 4_000);
    const stopEarly = window.setTimeout(() => window.clearInterval(early), 20_000);
    const poll = window.setInterval(() => document.visibilityState === "visible" && reload(), 60_000);
    return () => {
      window.removeEventListener(FOCUS_CHANGED, reload);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(early);
      window.clearTimeout(stopEarly);
      window.clearInterval(poll);
    };
  }, [reload]);

  const running = React.useMemo(() => {
    let best: { item: FocusItem; event: FocusEvent } | null = null;
    for (const event of events) {
      if (event.status !== "running") continue;
      const item = items.get(event.item_uid);
      if (!item) continue;
      if (!best || String(event.started_at) > String(best.event.started_at)) best = { item, event };
    }
    return best;
  }, [events, items]);

  // The whole app changes mood while a serious session runs.
  React.useEffect(() => {
    setFxTheme(running ? "lockin" : "normal");
  }, [running]);
  React.useEffect(() => () => setFxTheme("normal"), []);

  const value = React.useMemo<SeriousState>(() => ({
    items,
    running,
    eventFor: (uid, occurrence) => {
      let found: FocusEvent | undefined;
      for (const event of events) {
        if (event.item_uid === uid && event.occurrence === occurrence) found = event;
      }
      return found;
    },
    reload,
  }), [items, running, events, reload]);

  return <SeriousContext.Provider value={value}>{children}</SeriousContext.Provider>;
}

/** Serious-mode state, or null where no provider is mounted. */
export function useSerious(): SeriousState | null {
  return React.useContext(SeriousContext);
}
