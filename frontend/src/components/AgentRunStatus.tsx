"use client";

import * as React from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, ShieldCheck, XCircle } from "lucide-react";

type Run = { id: string; status: string; updated_at?: string };
type Pairing = { token: string; principal_id: string };
type TauriInternals = { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };

class RuntimeRequestError extends Error {
  constructor(readonly status: number) {
    super(`Agent runtime request failed (${status})`);
  }
}

const presentation: Record<string, { label: string; tone: string; Icon: typeof Activity }> = {
  QUEUED: { label: "Queued", tone: "text-muted", Icon: Clock3 },
  RUNNING: { label: "Working", tone: "text-cyan-300", Icon: Activity },
  WAITING_APPROVAL: { label: "Approval needed", tone: "text-amber-400", Icon: ShieldCheck },
  WAITING_USER: { label: "Needs your input", tone: "text-amber-400", Icon: AlertTriangle },
  COMPLETED: { label: "Verified", tone: "text-emerald-400", Icon: CheckCircle2 },
  FAILED: { label: "Failed", tone: "text-rose-400", Icon: XCircle },
  CANCELLED: { label: "Cancelled", tone: "text-muted", Icon: XCircle },
  CANCEL_REQUESTED: { label: "Stopping safely", tone: "text-amber-400", Icon: Clock3 },
};

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

/** P18/P34's compact, evidence-first status surface. */
export function AgentRunStatus() {
  const [pairing, setPairing] = React.useState<Pairing | null>(null);
  const [run, setRun] = React.useState<Run | undefined>();
  const [connection, setConnection] = React.useState<"connecting" | "ready" | "unavailable">("connecting");

  React.useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge) {
      setConnection("unavailable");
      return;
    }
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

  const runSafeCheck = async () => {
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
  };

  if (connection === "connecting") return <section className="border-t border-line px-5 py-4 text-sm text-muted">Connecting to the safe agent runtime…</section>;
  if (connection === "unavailable") return <section className="border-t border-line px-5 py-4 text-sm text-muted">Agent runtime unavailable. Chat and voice remain connected.</section>;
  if (!run) return <section className="flex items-center justify-between gap-4 border-t border-line px-5 py-3"><div><p className="text-sm font-medium text-emerald-400">Agent runtime paired</p><p className="mt-0.5 text-xs text-muted">Ready for durable, verified work as capabilities are enabled.</p></div><button type="button" onClick={() => void runSafeCheck()} className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium text-text transition hover:border-cyan-400/50 hover:text-cyan-300">Run safe check</button></section>;

  const item = presentation[run.status] ?? { label: "Outcome uncertain", tone: "text-amber-400", Icon: AlertTriangle };
  return <section aria-live="polite" className="flex items-center justify-between gap-4 border-t border-line px-5 py-4"><div><div className={`flex items-center gap-2 text-sm font-medium ${item.tone}`}><item.Icon size={17} strokeWidth={1.8} /><span>{item.label}</span></div><p className="mt-1 font-mono text-xs text-muted">{run.id}</p>{run.status === "WAITING_APPROVAL" && <p className="mt-2 text-sm text-muted">Review the exact target and effect before granting permission.</p>}{run.status === "FAILED" && <p className="mt-2 text-sm text-muted">The job stopped without claiming completion. Its recorded events remain available for review.</p>}</div>{["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) && <button type="button" onClick={() => void runSafeCheck()} className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium text-text transition hover:border-cyan-400/50 hover:text-cyan-300">Run again</button>}</section>;
}
