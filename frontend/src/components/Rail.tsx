"use client";

import {
  CalendarRange,
  LibraryBig,
  ListChecks,
  MessagesSquare,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import type { ViewKey } from "@/types";

export const VIEWS: { key: ViewKey; label: string; icon: LucideIcon }[] = [
  { key: "board", label: "Task Board", icon: ListChecks },
  { key: "schedule", label: "Schedule", icon: CalendarRange },
  { key: "vault", label: "Notes & Ideas", icon: LibraryBig },
];

/** Geometric brand mark — an aperture. Vector, themeable, never an emoji. */
function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.5 16.5 12 12 16.5 7.5 12 12 7.5Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}

interface RailProps {
  view: ViewKey;
  /** Whether Chat currently owns the one content pane, instead of `view`. */
  chatOpen: boolean;
  /** Switches the content pane to a workspace view, closing Chat. */
  onSelectView: (view: ViewKey) => void;
  /** Switches the content pane to Chat. */
  onOpenChat: () => void;
  counts: Partial<Record<ViewKey, number>>;
  /** Drives the status lamp: live, syncing, or unreachable. */
  status: "online" | "syncing" | "offline";
  onOpenSettings: () => void;
}

const STATUS_COPY: Record<RailProps["status"], string> = {
  online: "Connected",
  syncing: "Syncing…",
  offline: "Backend unreachable",
};

const STATUS_DOT: Record<RailProps["status"], string> = {
  online: "bg-positive",
  syncing: "bg-accent animate-breathe",
  offline: "bg-critical",
};

/** One labelled row: an icon, a name, and an optional trailing count. */
function RailButton({
  active,
  label,
  icon: Icon,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: LucideIcon;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="rail-item group cursor-pointer"
    >
      <Icon
        aria-hidden
        className={cn("h-[18px] w-[18px] shrink-0", active ? "text-accent" : "text-ink-faint group-hover:text-ink-muted")}
        strokeWidth={active ? 2 : 1.75}
      />
      <span className="rail-label">{label}</span>
      {!!count && count > 0 && (
        <span aria-hidden className={cn("rail-count", active ? "text-accent" : "text-ink-faint")}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

export function Rail({
  view,
  chatOpen,
  onSelectView,
  onOpenChat,
  counts,
  status,
  onOpenSettings,
}: RailProps) {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-rail shrink-0 flex-col border-r border-line bg-surface-0/80 backdrop-blur-sm"
    >
      {/* Wordmark, not just the mark: at this width there is room to say what
          this is, not merely to hint at it with a glyph. */}
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-5 text-accent">
        <Mark className="h-[19px] w-[19px] shrink-0" />
        <span className="truncate font-display text-[13px] font-semibold tracking-[0.02em] text-ink">
          JARVIS
        </span>
      </div>

      <div className="mt-4 flex flex-1 flex-col gap-0.5 px-2.5">
        {/* Chat is a destination, not a permanent column — see page.tsx. It
            leads the list because it is the primary way in, the same reason
            it leads the console on a phone. */}
        <RailButton
          active={chatOpen}
          label="Chat"
          icon={MessagesSquare}
          onClick={onOpenChat}
        />

        <div className="my-2 h-px shrink-0 bg-line" aria-hidden />

        {VIEWS.map(({ key, label, icon }) => (
          <RailButton
            key={key}
            active={!chatOpen && key === view}
            label={label}
            icon={icon}
            count={counts[key]}
            onClick={() => onSelectView(key)}
          />
        ))}
      </div>

      {/* No voice control here. The console carries the single primary CTA;
          a second entry point in the rail competed with it and made the
          hierarchy ambiguous. */}
      <div className="flex flex-col gap-0.5 px-2.5 pb-4">
        <button
          type="button"
          onClick={onOpenSettings}
          className="rail-item cursor-pointer"
        >
          <Settings2 aria-hidden className="h-[17px] w-[17px] shrink-0 text-ink-faint group-hover:text-ink-muted" strokeWidth={1.85} />
          <span className="rail-label">Settings</span>
        </button>

        {/* Connection settings and the status lamp answer the same question
            ("what is this thing talking to"), so they sit together rather
            than the lamp floating alone. */}
        <div className="flex items-center gap-2.5 px-4 py-2 text-[11px] text-ink-faint" title={STATUS_COPY[status]}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
          <span className="truncate">{STATUS_COPY[status]}</span>
        </div>
      </div>
    </nav>
  );
}
