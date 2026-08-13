"use client";

import * as React from "react";

import { Chat } from "@/components/Chat";
import { Dashboard } from "@/components/Dashboard";
import { Rail } from "@/components/Rail";
import { ShaderBackground } from "@/components/ui/simplex-noise-first-contact";
import { ApiError, fetchDashboard, regenerateBrief, toggleTask } from "@/lib/api";
import type { DashboardState, RefreshDomain, TaskStatus, ViewKey } from "@/types";

/** Background poll interval. The chat stream pushes targeted refreshes, so this
 *  only has to catch drift (e.g. an event becoming "now"). */
const POLL_MS = 60_000;

export default function CommandCenterPage() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [view, setView] = React.useState<ViewKey>("board");
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Guards against two refreshes landing out of order and showing stale data.
  const requestSeq = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      const next = await fetchDashboard();
      if (seq !== requestSeq.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not load the dashboard. Is the backend running?",
      );
    } finally {
      if (seq === requestSeq.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The agent tells us which panels its tools invalidated. The dashboard is one
  // aggregate endpoint, so any non-empty domain list means "refetch".
  const handleAgentRefresh = React.useCallback(
    (domains: RefreshDomain[]) => {
      if (domains.length) void refresh();
    },
    [refresh],
  );

  const handleRegenerateBrief = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const brief = await regenerateBrief();
      setState((current) => (current ? { ...current, brief } : current));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not regenerate the brief.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleToggleTask = React.useCallback(
    async (taskId: number, next: TaskStatus) => {
      // Optimistic: the row flips immediately, then the server response
      // reconciles the task, counters and brief in one shot.
      setState((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === taskId ? { ...task, status: next } : task,
              ),
            }
          : current,
      );

      try {
        const result = await toggleTask(taskId, next);
        setState((current) =>
          current
            ? {
                ...current,
                counts: result.counts,
                brief: result.brief,
                tasks: current.tasks.map((task) =>
                  task.id === result.task.id ? result.task : task,
                ),
              }
            : current,
        );
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not update that task.");
        void refresh(); // roll the optimistic update back to server truth
      }
    },
    [refresh],
  );

  const railCounts = React.useMemo(
    () => ({
      board: state ? state.counts.PENDING + state.counts.IN_PROGRESS : 0,
      schedule: state?.today.length ?? 0,
      vault: state ? state.ideas.length + state.memories.length : 0,
    }),
    [state],
  );

  const status = error ? "offline" : refreshing ? "syncing" : "online";

  return (
    <div className="relative h-dvh overflow-hidden bg-surface-0">
      {/* Ambient field. Two scrims sit between it and the UI: a heavy gradient
          for contrast safety, and a hairline grid for drafting-table structure.
          Everything above renders on opaque surfaces, so token contrast ratios
          hold regardless of what the shader is doing underneath. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.28]">
        <ShaderBackground className="h-full w-full" speed={0.5} />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-surface-0/85"
      />
      <div
        aria-hidden
        className="grid-texture pointer-events-none absolute inset-0 opacity-40"
      />

      {/* Shell: rail · console · work surface.
          Below `lg` the console and work surface stack, rail stays fixed. */}
      <main
        className={
          "relative grid h-full grid-cols-[var(--rail-w)_1fr] grid-rows-[minmax(0,44%)_minmax(0,1fr)] overflow-hidden " +
          "lg:grid-cols-[var(--rail-w)_var(--console-w)_1fr] lg:grid-rows-1"
        }
      >
        <div className="row-span-2 lg:row-span-1">
          <Rail
            view={view}
            onViewChange={setView}
            counts={railCounts}
            status={status}
          />
        </div>

        <div className="min-h-0 border-b border-line lg:border-b-0">
          <Chat onRefresh={handleAgentRefresh} />
        </div>

        <div className="min-h-0 overflow-hidden">
          <Dashboard
            view={view}
            state={state}
            loading={loading}
            refreshing={refreshing}
            error={error}
            onRefresh={() => void refresh()}
            onRegenerateBrief={() => void handleRegenerateBrief()}
            onToggleTask={handleToggleTask}
          />
        </div>
      </main>
    </div>
  );
}
