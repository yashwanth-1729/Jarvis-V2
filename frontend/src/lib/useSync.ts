"use client";

import * as React from "react";

import { onHidden, onShutdown } from "@/lib/lifecycle";
import { pendingCount } from "@/lib/localdb";
import {
  type SyncResult,
  describeAge,
  getSupabaseConfig,
  lastSyncAt,
  moved,
  summarize,
  syncOnce,
} from "@/lib/syncClient";

export type SyncPhase = "idle" | "syncing" | "done" | "error";

export interface SyncState {
  phase: SyncPhase;
  /** How long ago the last successful sync was, in words. */
  age: string;
  /** Null until the first read of local state completes. */
  lastAt: string | null;
  /** Set after a round finishes; drives the result message. */
  message: string | null;
  configured: boolean;
  /** Cumulative rows moved this session; increases when a round did work. */
  movedCount: number;
  sync: () => void;
}

/**
 * Sync as a foreground action the user initiates.
 *
 * Deliberately does **not** sync on mount. The app has to be usable the instant
 * it opens, reading from local storage, and a sync fired automatically at launch
 * competes for the network exactly when first paint needs it least. The banner
 * offers it; the user decides.
 */
export function useSync(): SyncState {
  const [phase, setPhase] = React.useState<SyncPhase>("idle");
  const [lastAt, setLastAt] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [configured, setConfigured] = React.useState(false);
  const [movedCount, setMovedCount] = React.useState(0);

  // Results that arrive after the component is gone must be dropped rather than
  // set: React would warn, and on a closing app the state is meaningless.
  const alive = React.useRef(true);

  // Registered once on mount, so it must reach the latest `sync` rather than
  // the one that existed at registration time.
  const syncRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    alive.current = true;
    const release = onShutdown(() => {
      alive.current = false;
    });

    setConfigured(getSupabaseConfig() !== null);
    // A local read, so this resolves in a frame or two and never blocks paint.
    void lastSyncAt().then((at) => {
      if (alive.current) setLastAt(at);
    });

    return () => {
      alive.current = false;
      release();
    };
  }, []);

  /**
   * Publish on the way out.
   *
   * The store is local-first and always has been: every edit lands in
   * IndexedDB immediately and nothing waits on the network. What was missing
   * was the other half — changes sat in the pending queue until somebody
   * remembered to press Sync, so a device could go days out of date and then
   * publish a pile of edits all at once, which is where most of the conflicts
   * came from.
   *
   * Syncing when the app is hidden closes that gap without adding a
   * background timer. Two properties make it safe: it only runs when there is
   * actually something to publish, so backgrounding the app is normally free;
   * and it is safe to be killed halfway, because the pending queue is durable
   * and an interrupted publish simply happens on the next one.
   */
  React.useEffect(() => {
    return onHidden(() => {
      void pendingCount().then((count) => {
        if (count > 0) syncRef.current?.();
      });
    });
  }, []);

  const sync = React.useCallback(() => {
    setPhase((current) => {
      if (current === "syncing") return current; // already running
      void run();
      return "syncing";
    });

    async function run(): Promise<void> {
      let result: SyncResult;
      try {
        result = await syncOnce();
      } catch (error) {
        // syncOnce is contracted never to throw; if it somehow does, the app
        // still must not break.
        if (!alive.current) return;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!alive.current) return;

      setMessage(summarize(result));
      if (result.error) {
        setPhase("error");
        return;
      }
      setPhase("done");
      const changed = moved(result) + result.deletedLocally;
      if (changed) setMovedCount((total) => total + changed);
      if (!result.skipped) {
        setLastAt(result.at);
        // Nothing moved is worth saying once, not worth leaving on screen.
        if (!moved(result) && !result.deletedLocally) {
          window.setTimeout(() => {
            if (alive.current) setPhase("idle");
          }, 2500);
        }
      }
    }
  }, []);

  syncRef.current = sync;

  return {
    phase,
    age: describeAge(lastAt),
    lastAt,
    message,
    configured,
    movedCount,
    sync,
  };
}
