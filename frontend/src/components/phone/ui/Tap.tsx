"use client";

import * as React from "react";

import { haptic, type HapticKind } from "../lib/haptics";

type TapProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Feedback on press. `false` for none. */
  feel?: HapticKind | false;
  /** How far it squishes. */
  squish?: number;
};

/**
 * Every pressable thing: it squishes while held and springs back with a
 * little bounce, plus a haptic tick (which also ripples the live background).
 *
 * The squish is a CSS transition on `transform` (see `.ph-tap`), so the
 * compositor plays it even when the tap kicks off heavy work in React.
 */
export const Tap = React.forwardRef<HTMLButtonElement, TapProps>(function Tap(
  { feel = "tap", squish = 0.95, onClick, type = "button", className, style, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={className ? `ph-tap ${className}` : "ph-tap"}
      style={{ "--squish": squish, ...style } as React.CSSProperties}
      onClick={(event) => {
        if (feel) haptic(feel);
        onClick?.(event);
      }}
      {...props}
    />
  );
});
