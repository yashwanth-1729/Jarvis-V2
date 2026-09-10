"use client";

/**
 * The board, grouped by what actually demands attention.
 *
 * Not a second task table. The board sorts; this one *triages* — overdue first,
 * then due today, then the rest — because the question behind "what do I have
 * today" is which of these is about to bite, and priority alone does not answer
 * that. A low-priority thing that was due yesterday outranks a high-priority
 * thing due next week.
 *
 * Everything here is live: the checkbox completes, the row opens the editor,
 * the priority chip cycles. A panel that only displays would be a screenshot.
 */

import { Check, Circle, Loader2, Minus } from "lucide-react";
import * as React from "react";

import { PRIORITY_BAR } from "@/components/ui/badge";
import type { Task, TaskStatus } from "@/types";
import { cn, isOverdue, relativeLabel } from "@/lib/utils";

const NEXT: Record<TaskStatus, TaskStatus> = {
  PENDING: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED",
  COMPLETED: "PENDING",
};

type Bucket = { key: string; label: string; tone: string; tasks: Task[] };

function triage(tasks: Task[]): Bucket[] {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const overdue: Task[] = [];
  const todayDue: Task[] = [];
  const active: Task[] = [];
  const rest: Task[] = [];

  for (const task of tasks) {
    if (task.status === "COMPLETED") continue;
    if (isOverdue(task.due_date)) overdue.push(task);
    else if (task.due_date && new Date(task.due_date) <= endOfToday) todayDue.push(task);
    else if (task.status === "IN_PROGRESS") active.push(task);
    else rest.push(task);
  }

  return [
    { key: "overdue", label: "Overdue", tone: "text-critical", tasks: overdue },
    { key: "today", label: "Due today", tone: "text-accent", tasks: todayDue },
    { key: "active", label: "In progress", tone: "text-ink-dim", tasks: active },
    { key: "rest", label: "Everything else", tone: "text-ink-faint", tasks: rest },
  ].filter((bucket) => bucket.tasks.length > 0);
}

interface TaskSurfaceProps {
  tasks: Task[];
  onToggle: (id: number, next: TaskStatus) => Promise<void>;
  onEdit: (task: Task) => void;
}

export function TaskSurface({ tasks, onToggle, onEdit }: TaskSurfaceProps) {
  const [busy, setBusy] = React.useState<Set<number>>(new Set());

  /**
   * Triaged, then capped.
   *
   * "Everything else" is honest as a category and ruinous as a list: with
   * twenty-one open tasks the panel became a wall of rows, which is the board
   * again, in a worse place, over the HUD. Urgent buckets are shown whole —
   * overdue is the whole point of triage — and the tail is trimmed, because a
   * spoken question was answered by the first few lines either way.
   */
  const { buckets, hidden } = React.useMemo(() => {
    const all = triage(tasks);
    let budget = 7;
    const kept: ReturnType<typeof triage> = [];
    let dropped = 0;
    for (const bucket of all) {
      if (budget <= 0) {
        dropped += bucket.tasks.length;
        continue;
      }
      const slice = bucket.tasks.slice(0, budget);
      dropped += bucket.tasks.length - slice.length;
      budget -= slice.length;
      kept.push({ ...bucket, tasks: slice });
    }
    return { buckets: kept, hidden: dropped };
  }, [tasks]);

  const open = tasks.filter((t) => t.status !== "COMPLETED").length;
  const done = tasks.length - open;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const advance = async (task: Task) => {
    setBusy((current) => new Set(current).add(task.id));
    try {
      await onToggle(task.id, NEXT[task.status]);
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 pt-1">
      <div>
        <div className="flex items-baseline gap-3">
          <h3 className="font-display text-2xl font-semibold tracking-tight text-ink">
            {open === 0 ? "All clear" : `${open} open`}
          </h3>
          <p className="font-mono text-2xs uppercase tracking-[0.2em] text-ink-dim">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
        </div>

        {tasks.length > 0 && (
          <div className="mt-3">
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Completed today"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1.5 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
              {done} done · {open} to go
            </p>
          </div>
        )}
      </div>

      {buckets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Check className="h-6 w-6 text-positive" strokeWidth={1.5} />
          <p className="text-sm text-ink-dim">Nothing outstanding.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          {buckets.map((bucket) => (
            <section key={bucket.key}>
              <div className="mb-2 flex items-baseline gap-2">
                <h4
                  className={cn(
                    "font-mono text-[0.6rem] uppercase tracking-[0.24em]",
                    bucket.tone,
                  )}
                >
                  {bucket.label}
                </h4>
                <span className="tnum font-mono text-[0.6rem] text-ink-faint">
                  {String(bucket.tasks.length).padStart(2, "0")}
                </span>
                <span aria-hidden className="h-px flex-1 bg-line/50" />
              </div>

              <ul className="space-y-1.5">
                {bucket.tasks.map((task) => {
                  const working = busy.has(task.id);
                  return (
                    <li
                      key={task.id}
                      className={cn(
                        "group relative flex items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5",
                        "border-line/60 bg-surface-1/40 transition-colors duration-150",
                        "hover:border-accent/25 hover:bg-surface-2/50",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn("absolute inset-y-0 left-0 w-[2px]", PRIORITY_BAR[task.priority])}
                      />

                      <button
                        type="button"
                        onClick={() => void advance(task)}
                        disabled={working}
                        aria-label={`Advance "${task.title}"`}
                        className={cn(
                          "relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border",
                          "transition-colors duration-150",
                          "before:absolute before:-inset-[11px] before:content-['']",
                          task.status === "IN_PROGRESS"
                            ? "border-accent/60 bg-accent/15 text-accent"
                            : "border-line-strong text-transparent hover:border-accent/50 hover:text-accent/40",
                        )}
                      >
                        {working ? (
                          <Loader2 className="h-3 w-3 animate-spin text-ink-faint" />
                        ) : task.status === "IN_PROGRESS" ? (
                          <Minus className="h-3 w-3" strokeWidth={3} />
                        ) : (
                          <Circle className="h-2 w-2 fill-current" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => onEdit(task)}
                        title="Edit"
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-sm text-ink">{task.title}</span>
                        {task.due_date && (
                          <span
                            className={cn(
                              "tnum block font-mono text-[0.6rem]",
                              isOverdue(task.due_date) ? "text-critical" : "text-ink-faint",
                            )}
                          >
                            {relativeLabel(task.due_date)}
                          </span>
                        )}
                      </button>

                      <span className="shrink-0 font-mono text-[0.55rem] uppercase tracking-[0.14em] text-ink-faint">
                        {task.category}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {hidden > 0 && (
            <p className="pt-1 font-mono text-2xs text-ink-faint">
              {hidden} more on the board.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
