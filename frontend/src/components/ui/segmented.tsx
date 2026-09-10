"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  "aria-label": string;
}

/**
 * Compact filter control. Roving tabindex + arrow keys, matching the
 * `radiogroup` semantics screen readers expect from a single-select filter.
 */
export function Segmented<T extends string>({
  options,
  value,
  onValueChange,
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + options.length) % options.length;
    onValueChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("ui-segmented inline-flex items-center gap-px rounded bg-surface-2 p-px", className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "cursor-pointer rounded-[3px] px-2 py-1 text-xs transition-colors duration-150",
              // 24px tall as drawn, which is not a touch target. The segments
              // sit flush against each other, so the box is expanded only
              // vertically — expanding sideways would have each segment
              // stealing taps from the one beside it.
              "relative before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']",
              selected
                ? "bg-surface-4 font-medium text-ink"
                : "text-ink-faint hover:text-ink-muted",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="tnum ml-1.5 font-mono text-2xs opacity-60">
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
