"use client";

import * as React from "react";
import { motion } from "framer-motion";

import { haptic } from "../lib/haptics";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  count?: number;
}

/**
 * A row of choices with one lime pill that slides (and squashes a little on
 * the way) to the selected option.
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
  const id = React.useId();
  return (
    <div className="ph-seg" data-size={size} role="tablist" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            className="ph-seg-option"
            onClick={() => {
              if (active) return;
              haptic("select");
              onChange(option.value);
            }}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="ph-seg-pill"
                transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.8 }}
              />
            )}
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
