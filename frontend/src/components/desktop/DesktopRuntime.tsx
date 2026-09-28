"use client";

import * as React from "react";

import { useAgentRuntime } from "@/lib/useAgentRuntime";

const STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: "Queued", tone: "sky" },
  RUNNING: { label: "Working", tone: "sky" },
  WAITING_APPROVAL: { label: "Approval needed", tone: "amber" },
  WAITING_USER: { label: "Needs your input", tone: "amber" },
  COMPLETED: { label: "Verified", tone: "mint" },
  FAILED: { label: "Failed", tone: "red" },
  CANCELLED: { label: "Cancelled", tone: "lilac" },
  CANCEL_REQUESTED: { label: "Stopping safely", tone: "amber" },
};

/**
 * The laptop's agent runtime, as one small card under the chat. Shown only
 * inside the desktop app (the native bridge pairs it); a browser has none.
 */
export function DesktopRuntime() {
  const { connection, run, runSafeCheck, native } = useAgentRuntime();
  if (!native) return null;

  let tone = "lime";
  let title = "Agent runtime ready";
  let detail: string | null = "Durable, verified desktop work";
  let action: string | null = "Safe check";
  if (connection === "connecting") {
    tone = "sky";
    title = "Connecting agent runtime…";
    detail = null;
    action = null;
  } else if (connection === "unavailable") {
    tone = "amber";
    title = "Agent runtime offline";
    detail = "Chat and voice still work";
    action = null;
  } else if (run) {
    const status = STATUS[run.status] ?? { label: "Outcome uncertain", tone: "amber" };
    tone = status.tone;
    title = status.label;
    detail = run.status === "WAITING_APPROVAL"
      ? "Review the exact target and effect first"
      : run.status === "FAILED"
        ? "Stopped without claiming completion"
        : run.id;
    action = ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) ? "Run again" : null;
  }

  return (
    <section className="dk-runtime" data-tone={tone} aria-live="polite">
      <span className="dk-runtime-dot" aria-hidden="true" />
      <span className="dk-runtime-text">
        <b>{title}</b>
        {detail && <span>{detail}</span>}
      </span>
      {action && (
        <button type="button" className="dk-runtime-btn" onClick={() => void runSafeCheck()}>
          {action}
        </button>
      )}
    </section>
  );
}
