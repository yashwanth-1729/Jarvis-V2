"use client";

import { ArrowUpRight, RotateCw, Signal } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/empty-state";
import { cn, formatTime } from "@/lib/utils";
import type { Brief, TaskCounts } from "@/types";

interface SignalBarProps {
  brief: Brief | null;
  counts: TaskCounts | null;
  loading: boolean;
  refreshing: boolean;
  onRegenerate: () => void;
}

/** Renders the inline `**bold**` emphasis the brief generator emits. */
function Emphasised({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="font-medium text-ink">
            {part}
          </span>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "accent" | "critical";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          "tnum font-mono text-lg font-medium leading-none",
          tone === "critical" && "text-critical",
          tone === "accent" && "text-accent",
          tone === "neutral" && "text-ink",
        )}
      >
        {String(value).padStart(2, "0")}
      </span>
      <span className="eyebrow">{label}</span>
    </div>
  );
}

/**
 * The always-visible "what's up" band. Horizontal rather than a card so it
 * reads as instrumentation across the top of the work surface — the brief is
 * ambient context, not a piece of content to manage.
 */
export function SignalBar({
  brief,
  counts,
  loading,
  refreshing,
  onRegenerate,
}: SignalBarProps) {
  const urgent = brief?.urgent_count ?? 0;
  const alert = urgent > 0;

  const bullets = React.useMemo(() => {
    if (!brief) return [];
    if (brief.bullets.length) return brief.bullets;
    return brief.summary_text
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }, [brief]);

  return (
    <section
      aria-label="Proactive brief"
      className="relative border-b border-line bg-surface-1/60"
    >
      {/* Attention rule: a single hairline that goes accent when work is urgent. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-px transition-colors duration-500",
          alert
            ? "bg-gradient-to-r from-transparent via-critical/70 to-transparent"
            : "bg-gradient-to-r from-transparent via-accent/40 to-transparent",
        )}
      />

      <div className="flex flex-col gap-4 px-4 py-4 xl:flex-row xl:items-center xl:gap-8">
        {/* Metrics block. Wraps at narrow widths — at 375px the title and four
            metrics cannot share a line, and clipping them would silently drop
            the counters rather than just tightening the layout. */}
        <div className="flex shrink-0 flex-wrap items-start gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <Signal
              className={cn(
                "h-3.5 w-3.5",
                alert ? "text-critical" : "text-accent",
                refreshing && "animate-breathe",
              )}
              strokeWidth={2}
            />
            <h2 className="font-display text-base font-semibold tracking-tight text-ink">
              What&apos;s up
            </h2>
          </div>

          <div className="flex flex-wrap items-start gap-x-5 gap-y-3 border-line sm:border-l sm:pl-5">
            <Metric
              label="Urgent"
              value={urgent}
              tone={alert ? "critical" : "neutral"}
            />
            <Metric label="Open" value={counts?.PENDING ?? 0} />
            <Metric
              label="Active"
              value={counts?.IN_PROGRESS ?? 0}
              tone={counts?.IN_PROGRESS ? "accent" : "neutral"}
            />
            <Metric
              label="Overdue"
              value={counts?.OVERDUE ?? 0}
              tone={counts?.OVERDUE ? "critical" : "neutral"}
            />
          </div>
        </div>

        {/* Bullets */}
        <div className="min-w-0 flex-1 xl:border-l xl:border-line xl:pl-8">
          {loading && !brief ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ) : bullets.length ? (
            <ol className="grid gap-1.5 lg:grid-cols-3 lg:gap-x-6">
              {bullets.slice(0, 3).map((line, index) => (
                <li
                  key={`${index}-${line.slice(0, 20)}`}
                  className="flex min-w-0 items-baseline gap-2 text-sm leading-snug text-ink-dim"
                >
                  <span
                    className={cn(
                      "tnum shrink-0 font-mono text-2xs",
                      index === 0 && alert ? "text-critical" : "text-ink-faint",
                    )}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <Emphasised text={line} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-faint">
              <ArrowUpRight className="h-3.5 w-3.5" />
              Nothing on the board — ask JARVIS to capture something.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-3">
          {brief?.generated_at && (
            <span className="tnum hidden font-mono text-2xs text-ink-faint 2xl:block">
              {formatTime(brief.generated_at)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRegenerate}
            disabled={refreshing}
            title="Regenerate brief"
          >
            <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="sr-only">Regenerate brief</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
