"use client";

import * as React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

import { haptic, type HapticKind } from "../lib/haptics";

type TapProps = Omit<HTMLMotionProps<"button">, "ref"> & {
  /** Feedback on press. `false` for none. */
  feel?: HapticKind | false;
  /** How far it squishes. */
  squish?: number;
};

/**
 * Every pressable thing: a spring squish on press, released with a little
 * bounce, plus a haptic tick. Transform-only, so it never triggers layout.
 */
export const Tap = React.forwardRef<HTMLButtonElement, TapProps>(function Tap(
  { feel = "tap", squish = 0.95, onClick, type = "button", ...props },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      type={type}
      whileTap={props.disabled ? undefined : { scale: squish }}
      transition={{ type: "spring", stiffness: 700, damping: 28, mass: 0.6 }}
      onClick={(event) => {
        if (feel) haptic(feel);
        onClick?.(event);
      }}
      {...props}
    />
  );
});
