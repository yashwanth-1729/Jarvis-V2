"use client";

/**
 * What is about to be deleted, and then it burning away.
 *
 * The most important panel in the application, and it is a safety device
 * before it is anything else.
 *
 * A real loss produced it. Asked to delete three tasks named "File the tax
 * return", the model called `bulk_delete_tasks` with `scope="open"`. The tool
 * refused and said, in plain words, that this would delete all 19 open tasks.
 * The model then told the user "3 tasks named 'File the tax return' will be
 * deleted", got a yes, and nineteen went.
 *
 * The consent was genuine; the number attached to it was not. A count that
 * reaches a person through a sentence the model composes is a channel the
 * model can get wrong. The tool now refuses to act unless the count it was
 * shown is quoted back to it, which closes the hole in code. This panel closes
 * it in the one place the model has no say: it renders the tool's own number
 * and the tool's own list, and nineteen rows on a screen cannot be talked
 * down to three.
 *
 * There is deliberately no confirm button here. Confirmation happens out loud,
 * in the conversation, the way it already does — this panel is the evidence,
 * not the control. Adding a button would put a second, competing consent on
 * screen and make it ambiguous which one actually counted.
 */

import { AlertTriangle, Check, Trash2 } from "lucide-react";
import * as React from "react";

import { DUR, stagger, useReducedMotion } from "@/lib/motion";
import type { ConfirmPayload } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

const NOUN: Record<ConfirmPayload["record_type"], [string, string]> = {
  task: ["task", "tasks"],
  event: ["event", "events"],
  idea: ["idea", "ideas"],
  memory: ["memory", "memories"],
};

/** Per-row delay in the burn sequence, and the cap that bounds the whole run. */
const BURN_STEP_MS = 45;
const BURN_CAP = 8;

function describe(payload: ConfirmPayload): string {
  const [one, many] = NOUN[payload.record_type];
  const noun = payload.count === 1 ? one : many;

  if (payload.matching) return `${payload.count} ${noun} matching “${payload.matching}”`;
  if (payload.scope && payload.scope !== "all") {
    return `${payload.count} ${payload.scope} ${noun}`;
  }
  return `${payload.count} ${noun}`;
}

export function ConfirmSurface({ payload }: { payload: ConfirmPayload }) {
  const reduced = useReducedMotion();
  const done = payload.stage === "done";
  const cancelled = payload.stage === "cancelled";
  const shown = payload.items.length;
  const hidden = Math.max(0, payload.count - shown);

  return (
    <div className="space-y-4 pt-1">
      {/* The count, as the subject of the panel rather than a detail in it.
          This is the number that was mis-relayed, so it is the largest thing
          on screen and it comes from the tool, not from the reply. */}
      <div className="flex items-baseline gap-3">
        <span
          key={`count:${payload.count}:${payload.stage}`}
          className={cn(
            "tnum font-display text-5xl font-semibold leading-none",
            done ? "text-ink-dim" : "text-critical",
            !reduced && "animate-count-pop",
          )}
        >
          {done ? payload.removed?.length ?? payload.count : payload.count}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-ink">
            {done ? "deleted" : cancelled ? "kept" : "will be deleted"}
          </p>
          <p className="text-2xs text-ink-dim">{describe(payload)}</p>
        </div>
      </div>

      {/* Status line. Nothing has happened until it says otherwise, and it
          never claims a clear board while anything is left on it. */}
      <p
        aria-live="polite"
        className={cn(
          "flex items-start gap-2 rounded-md border px-3 py-2 text-2xs leading-relaxed",
          done
            ? "border-line bg-surface-1/50 text-ink-dim"
            : cancelled
              ? "border-line bg-surface-1/50 text-ink-dim"
              : "border-critical/35 bg-critical/10 text-ink",
        )}
      >
        {done ? (
          <Check aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-positive" />
        ) : (
          <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-critical" />
        )}
        <span>
          {done
            ? payload.remaining && payload.remaining > 0
              ? `${payload.remaining} still on the board.`
              : "The board is clear."
            : cancelled
              ? "Nothing was deleted."
              : "Nothing has been deleted yet. Say yes to confirm."}
        </span>
      </p>

      {/* Every condemned record. Truncating silently would recreate the exact
          failure this panel exists to prevent, so when the list is capped it
          says so rather than quietly showing fewer than it deletes. */}
      <ul className="space-y-1">
        {payload.items.map((item, index) => {
          const burning =
            done && (payload.removed?.length === 0 || payload.removed?.includes(item.id ?? -1));
          const delay = Math.min(index, BURN_CAP) * (done ? BURN_STEP_MS : 26);

          return (
            <li
              key={item.id ?? `${item.title}:${index}`}
              style={{ animationDelay: `${delay}ms`, transitionDelay: `${delay}ms` }}
              className={cn(
                "relative grid overflow-hidden rounded-md border transition-[grid-template-rows,opacity]",
                // The one sanctioned layout-adjacent transition. Collapsing by
                // height needs a measured pixel value; `1fr -> 0fr` closes the
                // gap without ever knowing it, so a burning row takes its space
                // with it instead of leaving a hole.
                "duration-[420ms] ease-[cubic-bezier(0.4,0,1,1)]",
                burning && !reduced ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
                burning && reduced && "hidden",
                cancelled
                  ? "border-line bg-surface-1/40"
                  : done
                    ? "border-line bg-surface-1/30"
                    : "border-critical/30 bg-critical/[0.07]",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={cn(
                    "relative flex items-start gap-2.5 px-3 py-2",
                    burning && !reduced && "animate-burn",
                  )}
                >
                  {/* The heat. A swept gradient rather than an animated
                      `filter`, which would be the obvious way to do this and
                      is far too expensive per frame on a phone. */}
                  {burning && !reduced && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 -inset-x-2 animate-ember-sweep"
                      style={{
                        animationDelay: `${delay}ms`,
                        background:
                          "linear-gradient(90deg, transparent, hsl(var(--critical) / 0.55), hsl(var(--critical) / 0.15), transparent)",
                      }}
                    />
                  )}

                  {/* Condemned state carried by an icon and a word, not by red
                      alone — and never by a strike-through, which reads as
                      "already gone" on a row that is still very much there. */}
                  <Trash2
                    aria-hidden
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      done || cancelled ? "text-ink-faint" : "text-critical",
                    )}
                  />

                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm leading-snug text-ink">{item.title}</p>
                    {(item.subtitle || item.meta) && (
                      <p className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-2xs text-ink-faint">
                        {item.subtitle && <span className="tnum">{item.subtitle}</span>}
                        {item.meta && <span className="uppercase tracking-[0.08em]">{item.meta}</span>}
                      </p>
                    )}
                  </div>

                  {!done && !cancelled && (
                    <span className="sr-only">marked for deletion</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <p className="font-mono text-2xs text-ink-dim">
          Showing {shown} of {payload.count}. All {payload.count} are included.
        </p>
      )}
    </div>
  );
}

export { DUR as CONFIRM_DUR, stagger as confirmStagger };
