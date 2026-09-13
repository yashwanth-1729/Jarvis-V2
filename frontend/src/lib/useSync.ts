"use client";

import * as React from "react";

import {
  type AutoSyncController,
  type SyncPhase,
  bootstrapSupabaseConfig,
  describeAge,
  getSupabaseConfig,
  lastSyncAt,
  startAutoSync,
} from "@/lib/syncClient";
import { buildSldtRemote, getSldtSettings, getSyncBackend, hasSessionSecret } from "@/lib/sldtConfig";

export type { SyncPhase } from "@/lib/syncClient";

export interface AutoSyncState {
  phase: SyncPhase;
  /** How long ago the last successful sync was, in words. */
  age: string;
  lastAt: string | null;
  message: string | null;
  configured: boolean;
  /**
   * True only when this device is set to SLDT, has settings saved, but this
   * page session hasn't had its recovery code re-entered yet -- the SLDT
   * design's deliberate tradeoff (the secret is never persisted) means this
   * is the ordinary state right after every reload, not an error. Lets the
   * UI say "re-enter your recovery code" instead of a generic "not
   * configured", which would look like the account itself was lost.
   */
  needsSldtSecret: boolean;
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
  const [needsSldtSecret, setNeedsSldtSecret] = React.useState(false);

  // The callback is registered once inside the controller, so route it through
  // a ref to always reach the latest without restarting the controller.
  const pulledRef = React.useRef(onPulled);
  pulledRef.current = onPulled;

  React.useEffect(() => {
    let alive = true;
    let controller: AutoSyncController | null = null;

    void lastSyncAt().then((at) => {
      if (alive) setLastAt(at);
    });

    void (async () => {
      if (getSyncBackend() === "sldt") {
        const settings = getSldtSettings();
        const remote = enabled ? buildSldtRemote() : null;
        if (!alive) return;
        setConfigured(remote !== null);
        setNeedsSldtSecret(enabled && settings !== null && !hasSessionSecret());

        if (!enabled || !remote) return;

        controller = startAutoSync({
          remote,
          onChange: (status) => {
            if (!alive) return;
            setPhase(status.phase);
            setMessage(status.message);
            if (status.at) setLastAt(status.at);
          },
          onPulled: () => pulledRef.current?.(),
        });
        return;
      }

      setNeedsSldtSecret(false);

      // A first-run desktop device has nothing in localStorage yet but the
      // local backend may already know its Supabase project — fill from
      // there before deciding sync has nothing to work with. A no-op
      // everywhere else (Android's backend has nothing to hand over; a
      // device that already has a config keeps exactly what it has).
      const config = enabled ? await bootstrapSupabaseConfig() : getSupabaseConfig();
      if (!alive) return;
      setConfigured(config !== null);

      if (!enabled || !config) return;

      controller = startAutoSync({
        onChange: (status) => {
          if (!alive) return;
          setPhase(status.phase);
          setMessage(status.message);
          if (status.at) setLastAt(status.at);
        },
        onPulled: () => pulledRef.current?.(),
      });
    })();

    return () => {
      alive = false;
      controller?.stop();
    };
  }, [enabled]);

  return {
    phase,
    age: describeAge(lastAt),
    lastAt,
    message,
    configured,
    needsSldtSecret,
  };
}
