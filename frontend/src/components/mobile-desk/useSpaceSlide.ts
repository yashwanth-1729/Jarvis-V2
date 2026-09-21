"use client";

import * as React from "react";
import { PAGE_SPRING, SNAP_SPRING, createSpring, rubberBand } from "./spring";

/** How much of the width, or how fast a flick, commits to the next space. */
const COMMIT_RATIO = 0.28;
const FLICK_SPEED = 420; // px/s
/** Horizontal intent must beat vertical by this much before the page follows. */
const ANGLE_BIAS = 1.3;
/** Fastest throw the spring will accept, in spaces per second. A real
 *  flick can measure far higher for one sample; uncapped it would sling the
 *  track past the last space and snap back. */
const MAX_THROW = 4.5;

/**
 * Spring-driven paging for the three spaces, with the finger in charge.
 *
 * Taps spring the track across; a drag moves it one-to-one and then throws it
 * with the speed it left your finger, which is what makes the movement feel
 * continuous rather than played back. The dock pill and the glass highlight
 * ride the same value, so they can never fall out of step with the page.
 */
export function useSpaceSlide(index: number, enabled: boolean, onIndex?: (next: number) => void) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const selectionRef = React.useRef<HTMLSpanElement>(null);
  const spring = React.useRef<ReturnType<typeof createSpring> | null>(null);
  const latest = React.useRef(index);
  const reduce = React.useRef(false);
  const commit = React.useRef(onIndex);
  latest.current = index;
  commit.current = onIndex;

  React.useLayoutEffect(() => {
    const track = trackRef.current;
    const pill = selectionRef.current;
    if (!enabled || !track || !pill) return;
    const shell = track.closest<HTMLElement>(".desk-shell");
    const viewport = track.parentElement as HTMLElement | null;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    reduce.current = preference.matches;

    let width = viewport?.clientWidth || track.clientWidth || 1;
    const measure = () => { width = viewport?.clientWidth || track.clientWidth || width; };
    const observer = new ResizeObserver(measure);
    if (viewport) observer.observe(viewport);

    const paint = (raw: number, velocity = 0) => {
      // Never paint beyond the ends: past them the surface resists, so a fast
      // throw can never expose a void beside the first or last space.
      const position = raw < 0
        ? -rubberBand(-raw * width, width) / width
        : raw > 2 ? 2 + rubberBand((raw - 2) * width, width) / width : raw;
      track.style.transform = `translate3d(${-position * 100}%,0,0)`;
      pill.style.transform = `translate3d(${position * 100}%,0,0)`;
      // How hard the surface is moving right now, for the glass to answer to.
      shell?.style.setProperty("--slide-energy", Math.min(1, Math.abs(velocity) / 3).toFixed(3));
      // Glass and depth read this: highlights slide with real movement
      // instead of drifting on an unrelated timer.
      shell?.style.setProperty("--space-position", position.toFixed(4));
      const settled = Math.abs(position - Math.round(position)) < 0.002;
      if (shell) shell.dataset.sliding = settled ? "false" : "true";
    };
    const controller = createSpring(latest.current, paint, PAGE_SPRING);
    spring.current = controller;
    paint(latest.current);

    // --- drag ------------------------------------------------------------
    let pointer = 0;
    let startX = 0;
    let startY = 0;
    let startPosition = latest.current;
    let axis: "none" | "x" | "y" = "none";
    let lastX = 0;
    let lastTime = 0;
    let speed = 0;

    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if ((event.target as HTMLElement).closest("input,textarea,select,button,a,[role='button'],[data-no-drag]")) return;
      pointer = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      startPosition = controller.value;
      axis = "none";
      speed = 0;
      lastTime = event.timeStamp;
    };

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (axis === "none") {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // A vertical intent belongs to the scroller, and once given away it is
        // not taken back for this gesture -- that is what stops the "sticky,
        // fighting" feel when a list and a pager share the same surface.
        axis = Math.abs(dx) > Math.abs(dy) * ANGLE_BIAS ? "x" : "y";
        if (axis === "x") track.setPointerCapture(event.pointerId);
      }
      if (axis !== "x") return;
      event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - lastTime);
      speed = ((event.clientX - lastX) / elapsed) * 1000;
      lastX = event.clientX;
      lastTime = event.timeStamp;

      let next = startPosition - dx / width;
      // Past the first or last space, resistance builds instead of a wall.
      if (next < 0) next = -rubberBand(-next * width, width) / width;
      else if (next > 2) next = 2 + rubberBand((next - 2) * width, width) / width;
      controller.set(next, clampThrow(-speed / width));
    };

    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = 0;
      if (axis !== "x") { axis = "none"; return; }
      axis = "none";
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
      const moved = controller.value - startPosition;
      const flicked = Math.abs(speed) > FLICK_SPEED;
      let destination = Math.round(controller.value);
      if (flicked) destination = speed < 0 ? Math.ceil(startPosition + 0.001) : Math.floor(startPosition - 0.001);
      else if (Math.abs(moved) > COMMIT_RATIO) destination = moved > 0 ? Math.ceil(startPosition) : Math.floor(startPosition);
      else destination = Math.round(startPosition);
      destination = Math.max(0, Math.min(2, destination));
      // The finger's speed becomes the spring's, so release is seamless.
      controller.throwTo(destination, clampThrow(-speed / width));
      if (destination !== latest.current) commit.current?.(destination);
    };

    const cancel = () => { pointer = 0; axis = "none"; controller.to(Math.max(0, Math.min(2, Math.round(controller.value)))); };

    track.addEventListener("pointerdown", down, { passive: true });
    track.addEventListener("pointermove", move, { passive: false });
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", cancel);

    const update = () => {
      reduce.current = preference.matches;
      if (preference.matches) controller.jump(latest.current);
    };
    const hide = () => { if (document.hidden) controller.jump(latest.current); };
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", hide);
    return () => {
      controller.dispose();
      spring.current = null;
      observer.disconnect();
      track.removeEventListener("pointerdown", down);
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", cancel);
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [enabled]);

  React.useLayoutEffect(() => {
    const controller = spring.current;
    if (!controller) return;
    if (reduce.current || document.hidden) controller.jump(index);
    else controller.to(index);
  }, [index]);

  return { trackRef, selectionRef };
}

function clampThrow(velocity: number): number {
  return Math.max(-MAX_THROW, Math.min(MAX_THROW, velocity));
}

export { SNAP_SPRING };
