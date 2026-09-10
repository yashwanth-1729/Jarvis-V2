import * as React from "react";

import { cn } from "@/lib/utils";
import type { IdeaStatus, MemoryCategory, Priority, TaskStatus } from "@/types";

type Tone = "neutral" | "accent" | "critical" | "positive" | "outline";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-dim border-line",
  accent: "bg-accent/12 text-accent border-accent/25",
  critical: "bg-critical/12 text-critical border-critical/25",
  positive: "bg-positive/12 text-positive border-positive/25",
  outline: "bg-transparent text-ink-faint border-line-strong",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[3px] border px-1.5 py-px",
        "font-mono text-2xs font-medium uppercase tracking-[0.08em]",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/* --------------------------------------------------------------------------
 * Semantic mappings. Priority and status never rely on colour alone — each
 * carries a text label, and the task rows additionally encode priority as a
 * left edge bar.
 * ----------------------------------------------------------------------- */

export const PRIORITY_TONE: Record<Priority, Tone> = {
  HIGH: "critical",
  MEDIUM: "accent",
  LOW: "outline",
};

/** Left edge bar colour used by the task rows. */
export const PRIORITY_BAR: Record<Priority, string> = {
  HIGH: "bg-critical",
  MEDIUM: "bg-accent/70",
  LOW: "bg-line-strong",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  HIGH: "P1",
  MEDIUM: "P2",
  LOW: "P3",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge tone={PRIORITY_TONE[priority]} title={`${priority} priority`}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

const STATUS_TONE: Record<TaskStatus, Tone> = {
  PENDING: "neutral",
  IN_PROGRESS: "accent",
  COMPLETED: "positive",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: "Open",
  IN_PROGRESS: "Active",
  COMPLETED: "Done",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

const IDEA_TONE: Record<IdeaStatus, Tone> = {
  DRAFT: "outline",
  ACTIVE: "accent",
  ARCHIVED: "neutral",
};

export function IdeaStatusBadge({ status }: { status: IdeaStatus }) {
  return <Badge tone={IDEA_TONE[status]}>{status}</Badge>;
}

const MEMORY_TONE: Record<MemoryCategory, Tone> = {
  LONG_TERM: "neutral",
  GOAL: "accent",
  PREFERENCE: "outline",
};

export function MemoryBadge({ category }: { category: MemoryCategory }) {
  return <Badge tone={MEMORY_TONE[category]}>{category.replace("_", " ")}</Badge>;
}
