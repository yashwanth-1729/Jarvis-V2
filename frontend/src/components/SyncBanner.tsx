"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { useAutoSync } from "@/lib/useSync";

/**
 * A passive sync indicator.
 *
 * There is no "Sync now" button any more — sync is automatic (pull on open,
 * quiet push after every change). So this shows *status*, not a control: a thin
 * line while a round is running, and a quiet notice if one failed, which the
 * next automatic round clears on its own. When idle it renders nothing, so a
 * healthy app shows no chrome here at all.
 */
export function SyncBanner({
  className,
  enabled,
  onSynced,
}: {
  className?: string;
  /** True where the client owns the data and runs sync (mobile). */
  enabled: boolean;
  /** Fired after a round that pulled changes, so the page can refresh. */
  onSynced?: () => void;
}) {
  const { phase, message } = useAutoSync({ enabled, onPulled: onSynced });

  // Nothing to show unless a round is in flight or the last one failed.
  if (phase !== "syncing" && phase !== "error") return null;

  const isError = phase === "error";
  const Icon = isError ? AlertTriangle : RefreshCw;

  return (
    <div
      className={cn(
        "sync-notice flex items-center gap-2.5 border-b px-3 py-1.5",
        "motion-safe:animate-fade-in",
        isError ? "border-critical/30 bg-critical/10" : "border-line bg-surface-1",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          phase === "syncing" && "motion-safe:animate-spin",
          isError ? "text-critical" : "text-ink-dim",
        )}
        strokeWidth={2}
      />
      <p aria-live="polite" className="min-w-0 flex-1 truncate text-xs text-ink-dim">
        {phase === "syncing" ? "Syncing…" : (message ?? "Sync failed — will retry")}
      </p>
    </div>
  );
}
