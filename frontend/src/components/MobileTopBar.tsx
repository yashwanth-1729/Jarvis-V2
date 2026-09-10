"use client";

import { Settings2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/BrandMark";

const STATUS_COPY = {
  online: "Connected",
  syncing: "Syncing",
  offline: "Offline",
} as const;

const STATUS_DOT = {
  online: "bg-accent",
  syncing: "bg-accent motion-safe:animate-breathe",
  offline: "bg-critical",
} as const;

/**
 * Slim top bar, phones only.
 *
 * The desktop rail carries three things: navigation, connection status, and
 * settings. Moving navigation to the bottom bar left the other two without a
 * home — settings in particular became unreachable, which on a phone is where
 * the runtime address and provider key have to be entered in the first place.
 *
 * Kept deliberately thin. Vertical space is the scarce resource on a phone, and
 * this exists to hold two controls, not to be a header.
 */
export function MobileTopBar({
  status,
  onOpenSettings,
  className,
}: {
  status: "online" | "syncing" | "offline";
  onOpenSettings: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mobile-topbar flex shrink-0 items-center gap-3",
        className,
      )}
    >
      <BrandMark />
      <div className="brand-wordmark">JARVIS<span>PERSONAL INTELLIGENCE</span></div>
      {/* The dot alone conveys nothing to a screen reader, and colour alone
          conveys nothing to anyone who cannot distinguish it. */}
      <span role="status" className="connection-indicator"><i aria-hidden className={STATUS_DOT[status]} />{STATUS_COPY[status]}</span>

      <span className="flex-1" />

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Connection settings"
        className={cn(
          "settings-trigger inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded",
          "text-ink-dim transition-colors duration-150 hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        )}
      >
        <Settings2 aria-hidden className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
    </div>
  );
}
