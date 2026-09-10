"use client";

import { CircleAlert, RotateCw, Sparkles } from "lucide-react";
import * as React from "react";

import { IdeaGrid } from "@/components/IdeaGrid";
import type { RecordsMode } from "@/lib/records";
import { ScheduleBoard } from "@/components/ScheduleBoard";
import { SignalBar } from "@/components/SignalBar";
import { TaskTable } from "@/components/TaskTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { DashboardState, GroupedSchedule, TaskStatus, ViewKey } from "@/types";

const VIEW_SUBTITLE: Record<ViewKey, string> = {
  board: "A clear space for what comes next.",
  schedule: "Give your day a little structure.",
  vault: "Your ideas. Your knowledge. All here.",
};
const VIEW_TITLE = { board: "Your focus.", schedule: "Your rhythm.", vault: "Your library." };
const VIEW_LABEL = { board: "TASKS & PRIORITIES", schedule: "SCHEDULE & ROUTINES", vault: "NOTES & MEMORY" };

interface DashboardProps {
  view: ViewKey;
  state: DashboardState | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onRegenerateBrief: () => void;
  onToggleTask: (taskId: number, next: TaskStatus) => Promise<void>;
  /** Which store is authoritative — the backend, or IndexedDB on mobile. */
  mode: RecordsMode;
  /** Reload after a hand edit. */
  onChanged: () => void;
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
  mode,
  onChanged,
}: DashboardProps) {
  const emptySchedule: GroupedSchedule = {
    college: [],
    routine: [],
    session: [],
    conflicts: [],
  };

  return (
    /**
     * One scroll region for the whole page.
     *
     * Every band above the list used to be fixed — the brief, the view header,
     * the section tabs, the overlap notice — which on a 363x800 phone left the
     * list about two hundred pixels to live in. Scrolling then moved only that
     * strip, with cards clipped mid-row at both ends, which is what made the
     * page feel broken rather than merely dense.
     *
     * The brief and the header now scroll away with the content, so reading
     * the schedule gives the schedule the whole screen. Only the section tabs
     * stay put, because they are navigation *for* the list underneath them and
     * losing them means scrolling back up to change section.
     */
    <section className="mobile-ui workspace-page flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-surface-0">
      {/* View header */}
      <header className="page-heading flex min-h-[52px] items-center gap-4 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="page-kicker">{VIEW_LABEL[view]}</p>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {VIEW_TITLE[view]}
          </h1>
          <p className="page-description mt-0.5 text-sm text-ink-dim">
            {VIEW_SUBTITLE[view]}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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

      {view === "board" && (
        <details className="daily-brief">
          <summary>
            <Sparkles size={15} aria-hidden /> <span>Daily briefing</span>
            <span className="brief-hint">{state?.brief?.urgent_count ? `${state.brief.urgent_count} need attention` : "Open overview"}</span>
          </summary>
          <SignalBar brief={state?.brief ?? null} counts={state?.counts ?? null}
            loading={loading} refreshing={refreshing} onRegenerate={onRegenerateBrief} />
        </details>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-critical/25 bg-critical/10 px-4 py-2.5 text-sm text-ink"
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

      <div className="workspace-content min-h-0 flex-1">
        {loading && !state ? (
          <LoadingPanels />
        ) : (
          <div key={view} className="workspace-view">
            {view === "board" && (
              <TaskTable
                tasks={state?.tasks ?? []}
                onToggle={onToggleTask}
                mode={mode}
                onChanged={onChanged}
              />
            )}
            {view === "schedule" && (
              <ScheduleBoard
                mode={mode}
                onChanged={onChanged}
                schedule={state?.schedule ?? emptySchedule}
                today={state?.today ?? []}
              />
            )}
            {view === "vault" && (
              <IdeaGrid
                ideas={state?.ideas ?? []}
                memories={state?.memories ?? []}
                pages={state?.note_pages ?? []}
                mode={mode}
                onChanged={onChanged}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function LoadingPanels() {
  return (
    <div className="space-y-px px-4 py-4">
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
