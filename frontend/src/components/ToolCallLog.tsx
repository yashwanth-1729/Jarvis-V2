"use client";

import {
  Brain,
  CalendarPlus,
  Check,
  ChevronRight,
  CircleAlert,
  LayoutDashboard,
  Loader2,
  Lightbulb,
  ListPlus,
  RotateCw,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import type { ToolCall } from "@/types";

const TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  add_task: { label: "Creating task", icon: ListPlus },
  update_task_status: { label: "Updating task", icon: Check },
  get_dashboard_summary: { label: "Reading state", icon: LayoutDashboard },
  save_idea_or_note: { label: "Saving note", icon: Lightbulb },
  search_memory: { label: "Searching memory", icon: Search },
  generate_proactive_brief: { label: "Building brief", icon: RotateCw },
  add_schedule_event: { label: "Scheduling", icon: CalendarPlus },
};

function meta(name: string) {
  return TOOL_META[name] ?? { label: name, icon: Wrench };
}

/**
 * Inline execution log — one row per tool call, streamed as it happens. Styled
 * as instrumentation (mono, hairline rules) rather than as chat content, so it
 * reads as something the machine did, not something it said.
 */
export function ToolCallLog({ calls }: { calls: ToolCall[] }) {
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (!calls.length) return null;

  return (
    <ol className="my-2 overflow-hidden rounded border border-line bg-surface-0/60">
      {calls.map((call) => {
        const { label, icon: Icon } = meta(call.name);
        const open = expanded === call.id;
        const hasDetail = Boolean(call.summary);

        return (
          <li key={call.id} className="border-b border-line last:border-0">
            <button
              type="button"
              onClick={() => hasDetail && setExpanded(open ? null : call.id)}
              aria-expanded={hasDetail ? open : undefined}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
                hasDetail ? "cursor-pointer hover:bg-surface-2" : "cursor-default",
              )}
            >
              {/* State glyph */}
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {call.state === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-accent" />
                ) : call.state === "ok" ? (
                  <Check className="h-3 w-3 text-positive" strokeWidth={3} />
                ) : (
                  <CircleAlert className="h-3 w-3 text-critical" />
                )}
              </span>

              <Icon
                className="h-3 w-3 shrink-0 text-ink-faint"
                strokeWidth={1.75}
              />

              <span className="truncate text-xs text-ink-dim">{label}</span>
              <span className="truncate font-mono text-2xs text-ink-faint">
                {call.name}
              </span>

              {hasDetail && (
                <ChevronRight
                  className={cn(
                    "ml-auto h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200",
                    open && "rotate-90",
                  )}
                />
              )}
            </button>

            {open && call.summary && (
              <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-surface-0 px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-dim">
                {call.summary}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Collapsible summarized-reasoning block. */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = React.useState(false);
  if (!text.trim()) return null;

  return (
    <div className="my-2 overflow-hidden rounded border border-line bg-surface-0/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2"
      >
        <Brain
          className={cn("h-3 w-3 shrink-0", live ? "animate-breathe text-accent" : "text-ink-faint")}
          strokeWidth={1.75}
        />
        <span className="text-xs text-ink-dim">{live ? "Thinking…" : "Reasoning"}</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <p className="scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap border-t border-line bg-surface-0 px-2.5 py-2 text-xs leading-relaxed text-ink-dim">
          {text}
        </p>
      )}
    </div>
  );
}
