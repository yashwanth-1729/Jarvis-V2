"use client";

import { AudioLines, MessagesSquare } from "lucide-react";
import * as React from "react";

import { VIEWS } from "@/components/Rail";
import { cn } from "@/lib/utils";
import type { ViewKey } from "@/types";

/** What the phone is currently showing. The desktop shows several at once. */
export type MobilePane = ViewKey | "chat";

/**
 * Bottom navigation, phones only.
 *
 * The desktop rail is a vertical strip down the left edge, which works with a
 * mouse and a wide window. On a phone it spends scarce horizontal space on
 * chrome and puts every control at the top of a tall screen, furthest from the
 * thumb. This is the same navigation rebuilt for the platform: along the
 * bottom, inside reach, one destination at a time.
 *
 * Voice sits in the middle and is styled as the primary action rather than a
 * fifth peer, because JARVIS is voice-first and the middle of the bottom edge
 * is the easiest target on the screen.
 */
export function MobileNav({
  pane,
  onPaneChange,
  onVoice,
  voiceAvailable,
  counts,
  className,
}: {
  pane: MobilePane;
  onPaneChange: (pane: MobilePane) => void;
  onVoice: () => void;
  voiceAvailable: boolean;
  counts: Partial<Record<ViewKey, number>>;
  className?: string;
}) {
  // Board and Schedule on the left, Vault and Chat on the right, with voice
  // between them.
  const left = VIEWS.slice(0, 2);
  const right = [
    ...VIEWS.slice(2),
    { key: "chat" as const, label: "Chat", icon: MessagesSquare },
  ];

  const item = (entry: { key: string; label: string; icon: typeof MessagesSquare }) => {
    const active = pane === entry.key;
    const Icon = entry.icon;
    const count = counts[entry.key as ViewKey] ?? 0;

    return (
      <button
        key={entry.key}
        type="button"
        onClick={() => onPaneChange(entry.key as MobilePane)}
        aria-current={active ? "page" : undefined}
        className={cn(
          // 68px tall: comfortably past the 48dp Material minimum, and tall
          // enough to carry a label without crowding the icon.
          "nav-destination group relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1.5",
          "transition-colors duration-150",
          active ? "bg-accent/10 text-accent" : "text-ink-dim hover:text-ink-muted",
        )}
      >
        <span className="relative">
          <Icon aria-hidden className="h-[22px] w-[22px]" strokeWidth={active ? 2.2 : 1.8} />
          {count > 0 && active && (
            <span
              aria-hidden
              className={cn(
                "tnum absolute -right-2 -top-1 min-w-[15px] rounded-full px-1",
                "font-mono text-[9px] leading-[15px]",
                active ? "bg-accent text-accent-ink" : "bg-surface-4 text-ink-dim",
              )}
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </span>
        {/* Labelled, not icon-only: icon-only navigation is consistently the
            worst-performing pattern for discoverability. */}
        <span className="text-[11px] font-medium leading-none">{entry.key === "board" ? "Tasks" : entry.key === "vault" ? "Notes" : entry.label}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Main"
      className={cn(
        "mobile-nav flex items-center gap-1",
        // The bar owns the gesture-bar inset so its buttons stay above it.
        "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      {left.map(item)}

      <div className="voice-dock flex shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={onVoice}
          disabled={!voiceAvailable}
          aria-label="Talk to JARVIS"
          className={cn(
            "voice-dock-button flex h-14 w-14 cursor-pointer items-center justify-center rounded-2xl",
            "bg-accent text-accent-ink shadow-lg shadow-accent/20",
            "transition-transform duration-150 active:scale-95",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
            // Disabled has to look disabled, not merely be inert.
            "disabled:cursor-not-allowed disabled:bg-surface-4 disabled:text-ink-faint disabled:shadow-none",
          )}
        >
          <AudioLines aria-hidden className="h-6 w-6" strokeWidth={2} />
        </button>
      </div>

      {right.map(item)}
    </nav>
  );
}
