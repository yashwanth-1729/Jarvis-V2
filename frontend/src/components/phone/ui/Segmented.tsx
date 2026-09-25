"use client";

import * as React from "react";

import { haptic } from "../lib/haptics";
import { useSlidingPill } from "../lib/motion";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  count?: number;
}

/**
 * A row of choices with one lime pill that glides (stretching on the way,
 * squashing as it lands) to the selected option.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "md" | "sm";
}) {
  const active = options.findIndex((option) => option.value === value);
  const { container, pill } = useSlidingPill<HTMLDivElement, HTMLSpanElement>(active, ".ph-seg-option");
  return (
    <div ref={container} className="ph-seg" data-size={size} role="tablist" aria-label={label}>
      <span ref={pill} className="ph-seg-pill" aria-hidden="true" />
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            className="ph-seg-option"
            onClick={() => {
              if (on) return;
              haptic("select");
              onChange(option.value);
            }}
          >
            <span className="ph-seg-label">
              {option.label}
              {option.count !== undefined && option.count > 0 && <span className="ph-seg-count">{option.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
