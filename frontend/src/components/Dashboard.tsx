"use client";

import { CircleAlert, RotateCw } from "lucide-react";
import * as React from "react";

import { IdeaGrid } from "@/components/IdeaGrid";
import { VIEWS } from "@/components/Rail";
import { ScheduleTimeline } from "@/components/ScheduleTimeline";
import { SignalBar } from "@/components/SignalBar";
import { TaskTable } from "@/components/TaskTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/empty-state";
import { cn, formatTime } from "@/lib/utils";
import type { DashboardState, TaskStatus, ViewKey } from "@/types";

const VIEW_SUBTITLE: Record<ViewKey, string> = {
  board: "Everything you have committed to, ranked by when it is due.",
  schedule: "Time-blocked commitments for the next two weeks.",
  vault: "Captured ideas and the facts JARVIS remembers about you.",
};

interface DashboardProps {
  view: ViewKey;
  state: DashboardState | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onRegenerateBrief: () => void;
  onToggleTask: (taskId: number, next: TaskStatus) => Promise<void>;
}

export function Dashboard({
  view,
  state,
  loading,
  refreshing,
  error,
  onRefresh,
  onRegenerateBrief,
  onToggleTask,
}: DashboardProps) {
  const scheduleEvents = React.useMemo(() => {
    if (!state) return [];
    // `today` is a subset of `upcoming`; merge and de-duplicate by id.
    const byId = new Map(state.upcoming.map((event) => [event.id, event]));
    for (const event of state.today) byId.set(event.id, event);
    return [...byId.values()].sort((a, b) => a.time_start.localeCompare(b.time_start));
  }, [state]);

  const meta = VIEWS.find((entry) => entry.key === view)!;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface-0">
      <SignalBar
        brief={state?.brief ?? null}
        counts={state?.counts ?? null}
        loading={loading}
        refreshing={refreshing}
        onRegenerate={onRegenerateBrief}
      />

      {/* View header */}
      <header className="flex items-start gap-4 border-b border-line px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {meta.label}
          </h1>
          <p className="mt-0.5 truncate text-sm text-ink-faint">
            {VIEW_SUBTITLE[view]}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {state?.generated_at && (
            <span className="tnum hidden font-mono text-2xs text-ink-faint md:block">
              synced {formatTime(state.generated_at)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh"
          >
            <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="sr-only">Refresh dashboard</span>
          </Button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-critical/25 bg-critical/10 px-5 py-2.5 text-sm text-ink"
        >
          <CircleAlert className="mt-px h-4 w-4 shrink-0 text-critical" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Dashboard unavailable</p>
            <p className="break-words text-ink-dim">{error}</p>
          </div>
          <Button variant="outline" size="xs" onClick={onRefresh}>
            Retry
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {loading && !state ? (
          <LoadingPanels />
        ) : (
          <div key={view} className="h-full animate-fade-in">
            {view === "board" && (
              <TaskTable tasks={state?.tasks ?? []} onToggle={onToggleTask} />
            )}
            {view === "schedule" && <ScheduleTimeline events={scheduleEvents} />}
            {view === "vault" && (
              <IdeaGrid ideas={state?.ideas ?? []} memories={state?.memories ?? []} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function LoadingPanels() {
  return (
    <div className="space-y-px px-5 py-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 py-2.5">
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton
            className="h-3"
            // Ragged widths read as content loading rather than a progress bar.
            {...{ style: { width: `${38 + ((index * 13) % 42)}%` } }}
          />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
