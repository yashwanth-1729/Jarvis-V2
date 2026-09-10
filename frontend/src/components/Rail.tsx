"use client";

import {
  CalendarRange,
  LibraryBig,
  ListChecks,
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
  onViewChange: (view: ViewKey) => void;
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

export function Rail({ view, onViewChange, counts, status, onOpenSettings }: RailProps) {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-rail shrink-0 flex-col items-center border-r border-line bg-surface-0/80 py-3 backdrop-blur-sm"
    >
      <div
        className="flex h-8 w-8 items-center justify-center text-accent"
        title="JARVIS"
      >
        <Mark className="h-[18px] w-[18px]" />
      </div>

      <div className="mt-5 flex flex-1 flex-col items-center gap-1">
        {VIEWS.map(({ key, label, icon: Icon }) => {
          const active = key === view;
          const count = counts[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onViewChange(key)}
              aria-current={active ? "page" : undefined}
              title={label}
              className={cn(
                "group relative flex h-9 w-9 cursor-pointer items-center justify-center rounded",
                "transition-colors duration-150",
                active
                  ? "bg-surface-3 text-accent"
                  : "text-ink-faint hover:bg-surface-2 hover:text-ink-muted",
              )}
            >
              {/* Active marker: a 2px edge tick, not a colour-only change. */}
              <span
                aria-hidden
                className={cn(
                  "absolute -left-3 h-4 w-[2px] rounded-r transition-all duration-200",
                  active ? "bg-accent opacity-100" : "opacity-0",
                )}
              />
              <Icon className="h-[17px] w-[17px]" strokeWidth={1.75} />
              <span className="sr-only">{label}</span>

              {count > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "tnum absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full px-1",
                    "font-mono text-[9px] leading-[15px]",
                    active
                      ? "bg-accent text-accent-ink"
                      : "bg-surface-4 text-ink-dim group-hover:text-ink-muted",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* No voice control here. The console carries the single primary CTA;
          a second entry point in the rail competed with it and made the
          hierarchy ambiguous. */}
      {/* Connection settings. Sits with the status dot rather than the view
          switcher: both answer "what is this thing talking to", which is a
          different question from "what am I looking at". */}
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Connection settings"
        title="Connection settings"
        className={cn(
          "inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded",
          "text-ink-faint transition-colors duration-150 hover:text-ink-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        )}
      >
        <Settings2 aria-hidden className="h-4 w-4" strokeWidth={2} />
      </button>

      <div
        className="flex h-8 w-8 items-center justify-center"
        title={STATUS_COPY[status]}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
        <span className="sr-only">{STATUS_COPY[status]}</span>
      </div>
    </nav>
  );
}
