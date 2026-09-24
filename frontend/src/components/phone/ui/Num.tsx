"use client";

import NumberFlow from "@number-flow/react";

/**
 * A number whose digits roll when it changes. NumberFlow draws inside a
 * shadow root that screen readers do not reach, so the value is also given
 * as visually hidden text.
 */
export function Num({ value }: { value: number }) {
  return (
    <span className="ph-num">
      <NumberFlow value={value} aria-hidden="true" />
      <span className="ph-sr">{value}</span>
    </span>
  );
}
