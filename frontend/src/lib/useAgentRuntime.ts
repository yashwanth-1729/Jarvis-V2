"use client";

import * as React from "react";

/**
 * Pairing with the desktop agent runtime and its installed-path safe check.
 *
 * Moved out of `components/AgentRunStatus.tsx` unchanged, so the classic
 * desktop panel and the new desktop shell share one implementation.
 */

export type AgentRun = { id: string; status: string; updated_at?: string };
type Pairing = { token: string; principal_id: string };
type TauriInternals = { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };

class RuntimeRequestError extends Error {
  constructor(readonly status: number) {
    super(`Agent runtime request failed (${status})`);
  }
}

function nativeBridge(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
}

async function request(path: string, pairing: Pairing, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:8000${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pairing.token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw new RuntimeRequestError(response.status);
  return response.json();
}

async function pairNative(): Promise<Pairing> {
  const bridge = nativeBridge();
  if (!bridge) throw new Error("Native bridge unavailable");
  return bridge.invoke<Pairing>("pair_agent_runtime");
}

export function useAgentRuntime() {
  const [pairing, setPairing] = React.useState<Pairing | null>(null);
  const [run, setRun] = React.useState<AgentRun | undefined>();
  const [connection, setConnection] = React.useState<"connecting" | "ready" | "unavailable">("connecting");
  const [native, setNative] = React.useState(false);

  React.useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge) {
      setConnection("unavailable");
      return;
    }
    setNative(true);
    let cancelled = false;
    const pair = async () => {
      // Cold Windows starts can spend several seconds importing Python,
      // migrating SQLite and loading the local voice. Keep pairing bounded,
      // but do not declare the runtime unavailable before its watchdog's own
      // readiness window has elapsed.
      for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
        try {
          const result = await pairNative();
          if (!cancelled) {
            setPairing(result);
            setConnection("ready");
          }
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      }
      if (!cancelled) setConnection("unavailable");
    };
    void pair();
    return () => { cancelled = true; };
  }, []);

  const runSafeCheck = React.useCallback(async () => {
    if (!pairing) return;
    setRun({ id: "Preparing installed-path check", status: "QUEUED" });
    const execute = async (activePairing: Pairing) => {
      const sessionId = `desktop-${crypto.randomUUID()}`;
      await request("/api/agent/sessions", activePairing, {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, device_id: "windows-desktop", title: "Installed-path verification" }),
      });
      return request("/api/agent/runs", activePairing, {
        method: "POST",
        body: JSON.stringify({
          schema_version: 1,
          client_request_id: `request-${crypto.randomUUID()}`,
          session_id: sessionId,
          input: { text: "desktop-installed-path", language: "en" },
          requested_mode: "interactive",
          execution_policy: "foreground",
          artifact_ids: [],
          budget_profile: "conservative",
        }),
      });
    };
    try {
      let result;
      try {
        result = await execute(pairing);
      } catch (error) {
        // Pairing tokens intentionally live only in backend memory. A healthy
        // watchdog restart therefore invalidates the old token; re-pair through
        // the native command and retry this read-only fixture exactly once.
        if (!(error instanceof RuntimeRequestError) || error.status !== 401) throw error;
        const refreshed = await pairNative();
        setPairing(refreshed);
        setConnection("ready");
        result = await execute(refreshed);
      }
      setRun(result.run);
    } catch {
      setRun({ id: "Installed-path check", status: "FAILED" });
    }
  }, [pairing]);

  return { connection, run, runSafeCheck, native };
}
