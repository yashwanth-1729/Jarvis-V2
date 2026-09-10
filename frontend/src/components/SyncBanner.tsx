"use client";

import { AlertTriangle, Check, RefreshCw, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { useSync } from "@/lib/useSync";

/**
 * The launch-time sync prompt.
 *
 * A bar, never a dialog. The app has already rendered from local storage by the
 * time this appears, so blocking the screen to ask about the network would make
 * a fast start *feel* slow for no gain — the data behind it is already on
 * screen and already usable. Everything here is skippable.
 */
export function SyncBanner({
  className,
  onSynced,
}: {
  className?: string;
  /** Fired after a round that changed something, so the page can react. */
  onSynced?: () => void;
}) {
  const { phase, age, message, configured, sync, movedCount } = useSync();

  // A sync that pulled rows leaves the runtime's working copy stale and the
  // rendered board out of date, so the page needs to know.
  const seenRef = React.useRef(0);
  React.useEffect(() => {
    if (movedCount > seenRef.current) {
      seenRef.current = movedCount;
      onSynced?.();
    }
  }, [movedCount, onSynced]);
  const [dismissed, setDismissed] = React.useState(false);

  // Nothing to offer until Supabase is configured, and no point nagging after
  // the user has waved it away this session.
  if (!configured || dismissed) return null;

  // A finished, uneventful round retires itself via the hook; keep the bar for
  // rounds that actually did something, and for failures.
  const tone =
    phase === "error" ? "error" : phase === "done" ? "done" : "idle";

  const label =
    phase === "syncing"
      ? "Syncing…"
      : phase === "error"
        ? (message ?? "Sync failed")
        : phase === "done"
          ? (message ?? "Synced")
          : age === "never synced"
            ? "Not synced yet"
            : `Last synced ${age}`;

  const Icon = phase === "error" ? AlertTriangle : phase === "done" ? Check : RefreshCw;

  return (
    <div
      className={cn(
        "sync-notice flex items-center gap-3 border-b px-3 py-2",
        // The app's own 180ms enter curve. motion-safe only: the entrance is
        // decoration, and a reader who asked for less motion should not have
        // to sit through it.
        "motion-safe:animate-fade-in",
        tone === "error"
          ? "border-critical/30 bg-critical/10"
          : "border-line bg-surface-1",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "h-4 w-4 shrink-0",
          phase === "syncing" && "motion-safe:animate-spin",
          tone === "error" ? "text-critical" : tone === "done" ? "text-accent" : "text-ink-dim",
        )}
        strokeWidth={2}
      />

      {/* Announced politely: a status update should never steal focus from
          whatever the user is already doing. */}
      <p aria-live="polite" className="min-w-0 flex-1 truncate text-sm text-ink-dim">
        {label}
      </p>

      {phase !== "syncing" && (
        <button
          type="button"
          onClick={sync}
          className={cn(
            // 44px: the touch-target minimum, and the same height as the
            // primary CTA in VoiceLauncher so the two read as one system.
            "inline-flex h-11 shrink-0 cursor-pointer items-center rounded px-4",
            "text-sm font-medium transition-colors duration-150",
            "sync-action text-accent hover:bg-accent/10",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
          )}
        >
          {phase === "error" ? "Retry" : "Sync now"}
        </button>
      )}

      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss sync notice"
        className={cn(
          // Small glyph, full-size hit area — the icon is 16px, the target is
          // 44px square.
          "-mr-1 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded",
          "text-ink-dim transition-colors duration-150 hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        )}
      >
        <X aria-hidden className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}
