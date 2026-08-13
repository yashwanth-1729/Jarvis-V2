"use client";

import { Check, Circle, Loader2, ListChecks, Minus } from "lucide-react";
import * as React from "react";

import { PRIORITY_BAR, PRIORITY_LABEL, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented } from "@/components/ui/segmented";
import { cn, formatDateTime, isOverdue, relativeLabel } from "@/lib/utils";
import type { Task, TaskStatus } from "@/types";

type StatusFilter = "ALL" | TaskStatus;
type SortKey = "due" | "priority" | "created";

const PRIORITY_RANK: Record<Task["priority"], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Clicking the status control advances one step around this cycle. */
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  PENDING: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED",
  COMPLETED: "PENDING",
};

const SORTS: { value: SortKey; label: string }[] = [
  { value: "due", label: "Due" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest" },
];

interface TaskTableProps {
  tasks: Task[];
  onToggle: (taskId: number, next: TaskStatus) => Promise<void>;
}

export function TaskTable({ tasks, onToggle }: TaskTableProps) {
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("ALL");
  const [sortKey, setSortKey] = React.useState<SortKey>("due");
  const [pending, setPending] = React.useState<Set<number>>(new Set());

  const counts = React.useMemo(() => {
    const map: Record<StatusFilter, number> = {
      ALL: tasks.length,
      PENDING: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
    };
    for (const task of tasks) map[task.status] += 1;
    return map;
  }, [tasks]);

  const visible = React.useMemo(() => {
    const filtered =
      statusFilter === "ALL" ? tasks : tasks.filter((task) => task.status === statusFilter);

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      // Finished work always sinks to the bottom, whatever the sort key —
      // otherwise a task completed last week outranks one due tomorrow.
      const doneDelta = Number(a.status === "COMPLETED") - Number(b.status === "COMPLETED");
      if (doneDelta !== 0) return doneDelta;

      if (sortKey === "priority") {
        const delta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (delta !== 0) return delta;
      }
      if (sortKey === "created") {
        return b.created_at.localeCompare(a.created_at);
      }
      // Undated work sinks below dated work.
      if (!a.due_date && !b.due_date) return b.created_at.localeCompare(a.created_at);
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
    return sorted;
  }, [tasks, statusFilter, sortKey]);

  async function handleToggle(task: Task) {
    if (pending.has(task.id)) return;
    setPending((current) => new Set(current).add(task.id));
    try {
      await onToggle(task.id, NEXT_STATUS[task.status]);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <Segmented
          aria-label="Filter tasks by status"
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: "ALL", label: "All", count: counts.ALL },
            { value: "PENDING", label: "Open", count: counts.PENDING },
            { value: "IN_PROGRESS", label: "Active", count: counts.IN_PROGRESS },
            { value: "COMPLETED", label: "Done", count: counts.COMPLETED },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <span className="eyebrow hidden sm:block">Sort</span>
          <Segmented
            aria-label="Sort tasks"
            value={sortKey}
            onValueChange={setSortKey}
            options={SORTS}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState
            icon={<ListChecks className="h-4 w-4" />}
            title={statusFilter === "ALL" ? "No tasks yet" : "Nothing in this view"}
            hint={
              statusFilter === "ALL"
                ? 'Try: "Remind me to renew the domain on Friday at 10am — high priority"'
                : "Switch filters to see the rest of the board."
            }
          />
        </div>
      ) : (
        <>
          {/* Column header lives OUTSIDE the scroll region: a `sticky` element
              inside a mask-faded container inherits the fade, which would eat
              its top edge. Keeping it a sibling gives the same fixed-header
              behaviour with none of that. */}
          <div className="grid shrink-0 grid-cols-[28px_1fr_112px_64px] items-center gap-3 border-y border-line bg-surface-1/95 px-5 py-1.5 md:grid-cols-[28px_1fr_92px_132px_64px]">
            <span className="sr-only">Status control</span>
            <span className="eyebrow">Task</span>
            <span className="eyebrow hidden md:block">Category</span>
            <span className="eyebrow">Due</span>
            <span className="eyebrow text-right">State</span>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <ul className="divide-y divide-line">
            {visible.map((task) => {
              const done = task.status === "COMPLETED";
              const overdue = !done && isOverdue(task.due_date);
              const busy = pending.has(task.id);

              return (
                <li
                  key={task.id}
                  className={cn(
                    "group relative grid grid-cols-[28px_1fr_112px_64px] items-center gap-3 px-5 py-2.5",
                    "transition-colors duration-150 hover:bg-surface-2/60",
                    "md:grid-cols-[28px_1fr_92px_132px_64px]",
                    done && "opacity-45",
                  )}
                >
                  {/* Priority as a left edge bar — shape + position, never colour alone
                      (the P1/P2/P3 label is announced to screen readers). */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 w-[2px]",
                      done ? "bg-line-strong" : PRIORITY_BAR[task.priority],
                    )}
                  />
                  <span className="sr-only">
                    {PRIORITY_LABEL[task.priority]} — {task.priority} priority
                  </span>

                  {/* Status control */}
                  <button
                    type="button"
                    onClick={() => void handleToggle(task)}
                    disabled={busy}
                    aria-label={`Advance "${task.title}" to ${NEXT_STATUS[task.status]
                      .toLowerCase()
                      .replace("_", " ")}`}
                    className={cn(
                      "relative flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border",
                      "transition-colors duration-150",
                      // Expand the touch target to 40px without affecting layout.
                      "before:absolute before:-inset-[11px] before:content-['']",
                      done
                        ? "border-positive/60 bg-positive/20 text-positive"
                        : task.status === "IN_PROGRESS"
                          ? "border-ember/60 bg-ember/15 text-ember"
                          : "border-line-strong text-transparent hover:border-ember/50 hover:text-ember/40",
                      busy && "opacity-60",
                    )}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin text-ink-faint" />
                    ) : done ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : task.status === "IN_PROGRESS" ? (
                      <Minus className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      <Circle className="h-2 w-2 fill-current" />
                    )}
                  </button>

                  {/* Title */}
                  <p
                    className={cn(
                      "min-w-0 break-words text-base leading-snug text-ink",
                      done && "line-through decoration-ink-faint",
                    )}
                  >
                    {task.title}
                  </p>

                  {/* Category */}
                  <span className="hidden truncate font-mono text-2xs uppercase tracking-[0.08em] text-ink-faint md:block">
                    {task.category}
                  </span>

                  {/* Due */}
                  <div className="min-w-0">
                    {task.due_date ? (
                      <>
                        <span
                          className={cn(
                            "tnum block truncate font-mono text-xs",
                            overdue ? "text-critical" : "text-ink-dim",
                          )}
                        >
                          {formatDateTime(task.due_date)}
                        </span>
                        {!done && (
                          <span
                            className={cn(
                              "tnum block font-mono text-2xs",
                              overdue ? "text-critical/70" : "text-ink-faint",
                            )}
                          >
                            {relativeLabel(task.due_date)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="font-mono text-xs text-ink-faint">—</span>
                    )}
                  </div>

                  {/* State */}
                  <div className="flex justify-end">
                    <StatusBadge status={task.status} />
                  </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </>
      )}

      <p className="shrink-0 border-t border-line px-5 py-2 font-mono text-2xs text-ink-faint">
        Click the dot to advance: open → active → done
      </p>
    </div>
  );
}
