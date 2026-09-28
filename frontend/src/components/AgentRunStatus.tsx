"use client";

import * as React from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, ShieldCheck, XCircle } from "lucide-react";

import { useAgentRuntime } from "@/lib/useAgentRuntime";

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

/** P18/P34's compact, evidence-first status surface. */
export function AgentRunStatus() {
  const { connection, run, runSafeCheck } = useAgentRuntime();

  if (connection === "connecting") return <section className="border-t border-line px-5 py-4 text-sm text-muted">Connecting to the safe agent runtime…</section>;
  if (connection === "unavailable") return <section className="border-t border-line px-5 py-4 text-sm text-muted">Agent runtime unavailable. Chat and voice remain connected.</section>;
  if (!run) return <section className="flex items-center justify-between gap-4 border-t border-line px-5 py-3"><div><p className="text-sm font-medium text-emerald-400">Agent runtime paired</p><p className="mt-0.5 text-xs text-muted">Ready for durable, verified work as capabilities are enabled.</p></div><button type="button" onClick={() => void runSafeCheck()} className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium text-text transition hover:border-cyan-400/50 hover:text-cyan-300">Run safe check</button></section>;

  const item = presentation[run.status] ?? { label: "Outcome uncertain", tone: "text-amber-400", Icon: AlertTriangle };
  return <section aria-live="polite" className="flex items-center justify-between gap-4 border-t border-line px-5 py-4"><div><div className={`flex items-center gap-2 text-sm font-medium ${item.tone}`}><item.Icon size={17} strokeWidth={1.8} /><span>{item.label}</span></div><p className="mt-1 font-mono text-xs text-muted">{run.id}</p>{run.status === "WAITING_APPROVAL" && <p className="mt-2 text-sm text-muted">Review the exact target and effect before granting permission.</p>}{run.status === "FAILED" && <p className="mt-2 text-sm text-muted">The job stopped without claiming completion. Its recorded events remain available for review.</p>}</div>{["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) && <button type="button" onClick={() => void runSafeCheck()} className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-medium text-text transition hover:border-cyan-400/50 hover:text-cyan-300">Run again</button>}</section>;
}
