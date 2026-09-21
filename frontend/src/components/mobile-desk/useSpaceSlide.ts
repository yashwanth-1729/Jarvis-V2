"use client";

import * as React from "react";
import { createLinearSlide } from "./linearSlide";

export function useSpaceSlide(index: number, enabled: boolean) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const selectionRef = React.useRef<HTMLSpanElement>(null);
  const slide = React.useRef<ReturnType<typeof createLinearSlide> | null>(null);
  const latest = React.useRef(index);
  const reduce = React.useRef(false);
  latest.current = index;

  React.useLayoutEffect(() => {
    if (!enabled || !trackRef.current || !selectionRef.current) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    reduce.current = preference.matches;
    const controller = createLinearSlide([
      { element: trackRef.current, percent: -100 },
      { element: selectionRef.current, percent: 100 },
    ], latest.current);
    slide.current = controller;
    const update = () => {
      reduce.current = preference.matches;
      if (preference.matches) controller.move(latest.current, true);
    };
    const hide = () => { if (document.hidden) controller.move(latest.current, true); };
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", hide);
    return () => {
      controller.dispose();
      slide.current = null;
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [enabled]);

  React.useLayoutEffect(() => {
    slide.current?.move(index, reduce.current || document.hidden);
  }, [index]);
  return { trackRef, selectionRef };
}
