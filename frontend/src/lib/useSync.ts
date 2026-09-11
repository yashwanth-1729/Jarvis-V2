"use client";

import * as React from "react";

import {
  type AutoSyncController,
  type SyncPhase,
  describeAge,
  getSupabaseConfig,
  lastSyncAt,
  startAutoSync,
} from "@/lib/syncClient";

export type { SyncPhase } from "@/lib/syncClient";

export interface AutoSyncState {
  phase: SyncPhase;
  /** How long ago the last successful sync was, in words. */
  age: string;
  lastAt: string | null;
  message: string | null;
  configured: boolean;
}

/**
 * Automatic, button-free sync.
 *
 * The old hook was manual: it deliberately did not sync on mount and offered a
 * "Sync now" button. That is exactly what the user asked to remove. This one
 * runs the controller in `syncClient` — pull on open, quiet debounced push
 * after every change, slow pull while open — and exposes only passive status.
 *
 * `enabled` gates it to the platform that owns the data locally (mobile, where
 * IndexedDB is authoritative). On desktop the backend runs the only sync
 * engine, so the client stays out of its way.
 */
export function useAutoSync({
  enabled,
  onPulled,
}: {
  enabled: boolean;
  onPulled?: () => void;
}): AutoSyncState {
  const [phase, setPhase] = React.useState<SyncPhase>("idle");
  const [lastAt, setLastAt] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [configured, setConfigured] = React.useState(false);

  // The callback is registered once inside the controller, so route it through
  // a ref to always reach the latest without restarting the controller.
  const pulledRef = React.useRef(onPulled);
  pulledRef.current = onPulled;

  React.useEffect(() => {
    const isConfigured = getSupabaseConfig() !== null;
    setConfigured(isConfigured);

    let alive = true;
    void lastSyncAt().then((at) => {
      if (alive) setLastAt(at);
    });

    if (!enabled || !isConfigured) {
      return () => {
        alive = false;
      };
    }

    const controller: AutoSyncController = startAutoSync({
      onChange: (status) => {
        if (!alive) return;
        setPhase(status.phase);
        setMessage(status.message);
        if (status.at) setLastAt(status.at);
      },
      onPulled: () => pulledRef.current?.(),
    });

    return () => {
      alive = false;
      controller.stop();
    };
  }, [enabled]);

  return {
    phase,
    age: describeAge(lastAt),
    lastAt,
    message,
    configured,
  };
}
