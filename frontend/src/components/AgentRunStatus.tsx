"use client";

import * as React from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, ShieldCheck, XCircle } from "lucide-react";

type Run = { id: string; status: string; updated_at?: string };

const presentation: Record<string, { label: string; tone: string; Icon: typeof Activity }> = {
  QUEUED: { label: "Queued", tone: "text-slate-500", Icon: Clock3 },
  RUNNING: { label: "Working", tone: "text-sky-700", Icon: Activity },
  WAITING_APPROVAL: { label: "Approval needed", tone: "text-amber-700", Icon: ShieldCheck },
  WAITING_USER: { label: "Needs your input", tone: "text-amber-700", Icon: AlertTriangle },
  COMPLETED: { label: "Completed", tone: "text-emerald-700", Icon: CheckCircle2 },
  FAILED: { label: "Failed", tone: "text-rose-700", Icon: XCircle },
  CANCELLED: { label: "Cancelled", tone: "text-slate-500", Icon: XCircle },
  CANCEL_REQUESTED: { label: "Stopping safely", tone: "text-amber-700", Icon: Clock3 },
};

/** P18's deliberately modest view: state first, never optimistic completion. */
export function AgentRunStatus({ run, unavailable = false }: { run?: Run; unavailable?: boolean }) {
  if (unavailable) return <section className="border-t border-slate-200 px-5 py-4 text-sm text-slate-500">Agent runtime is not paired on this device.</section>;
  if (!run) return <section className="border-t border-slate-200 px-5 py-4 text-sm text-slate-500">No durable jobs yet. Long-running work will appear here once submitted.</section>;
  const item = presentation[run.status] ?? { label: "Outcome uncertain", tone: "text-amber-700", Icon: AlertTriangle };
  return <section aria-live="polite" className="border-t border-slate-200 px-5 py-4"><div className={`flex items-center gap-2 text-sm font-medium ${item.tone}`}><item.Icon size={17} strokeWidth={1.8} /><span>{item.label}</span></div><p className="mt-1 font-mono text-xs text-slate-500">{run.id}</p>{run.status === "WAITING_APPROVAL" && <p className="mt-2 text-sm text-slate-600">Review the exact target and effect before granting permission.</p>}{run.status === "FAILED" && <p className="mt-2 text-sm text-slate-600">The job stopped without claiming completion. Its recorded events remain available for review.</p>}</section>;
}
