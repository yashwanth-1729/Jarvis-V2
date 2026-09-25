"use client";

import * as React from "react";

/*
 * Motion that stays smooth while React is busy.
 *
 * The browser's compositor can run `transform` and `opacity` animations on
 * its own thread, but only when they are real CSS or Web Animations, not a
 * JavaScript loop writing styles each frame. So springs are sampled once into
 * a CSS `linear()` easing and handed to `element.animate()`; the result looks
 * like a framer spring but keeps moving even while a screen mounts.
 */

export interface SpringTiming {
  easing: string;
  /** Milliseconds until the spring settles. */
  duration: number;
}

const springs = new Map<string, SpringTiming>();

/** A damped spring from 0 to 1, as a `linear()` easing plus its duration. */
export function spring(stiffness: number, damping: number, mass = 1): SpringTiming {
  const key = `${stiffness}/${damping}/${mass}`;
  const cached = springs.get(key);
  if (cached) return cached;
  const dt = 1 / 1000;
  let x = 0;
  let v = 0;
  let t = 0;
  let settledAt = -1;
  const samples: number[] = [];
  while (t < 3) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    t += dt;
    samples.push(x);
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) {
      if (settledAt < 0) settledAt = t;
      if (t - settledAt > 0.05) break;
    } else {
      settledAt = -1;
    }
  }
  const duration = Math.max(0.05, settledAt > 0 ? settledAt : t);
  const points = 40;
  const stops: string[] = ["0"];
  for (let i = 1; i < points; i += 1) {
    const index = Math.min(samples.length - 1, Math.round(((i / points) * duration) / dt));
    stops.push(samples[index].toFixed(4));
  }
  stops.push("1");
  const timing = { easing: `linear(${stops.join(", ")})`, duration: Math.round(duration * 1000) };
  springs.set(key, timing);
  return timing;
}

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function translateX(element: HTMLElement): number {
  const value = getComputedStyle(element).transform;
  if (!value || value === "none") return 0;
  try {
    return new DOMMatrixReadOnly(value).m41;
  } catch {
    return 0;
  }
}

/**
 * Glide `pill` to `x`, stretching along the way and squashing as it lands.
 * Interrupting it mid-flight starts the next glide from wherever it is.
 */
export function glide(pill: HTMLElement, x: number, instant = false): void {
  const from = translateX(pill);
  for (const animation of pill.getAnimations()) animation.cancel();
  pill.style.transform = `translateX(${x}px)`;
  const distance = x - from;
  if (instant || Math.abs(distance) < 0.5 || reducedMotion() || typeof pill.animate !== "function") return;
  const stretch = 1 + Math.min(0.32, Math.abs(distance) / 480);
  const { easing, duration } = spring(520, 34);
  // Past the target the last segment extrapolates, so the overshoot comes
  // out as a small squash: the pill lands instead of stopping dead.
  pill.animate(
    [
      { transform: `translateX(${from}px) scaleX(1)` },
      { transform: `translateX(${from + distance * 0.5}px) scaleX(${stretch})`, offset: 0.32 },
      { transform: `translateX(${x}px) scaleX(1)` },
    ],
    { duration, easing },
  );
}

/**
 * A highlight that slides between a row of options (tabs, segments, days).
 *
 * The pill is one absolutely placed element inside `container`; it is sized
 * to the chosen option and glides on the compositor, instead of a shared
 * layout animation that framer would measure and drive from JavaScript.
 */
export function useSlidingPill<C extends HTMLElement, P extends HTMLElement>(active: number, selector: string) {
  const container = React.useRef<C>(null);
  const pill = React.useRef<P>(null);
  const placed = React.useRef(false);

  const place = React.useCallback(
    (instant: boolean) => {
      const box = container.current;
      const node = pill.current;
      if (!box || !node) return;
      const item = box.querySelectorAll<HTMLElement>(selector)[active];
      if (!item) {
        node.style.opacity = "0";
        return;
      }
      node.style.opacity = "1";
      node.style.width = `${item.offsetWidth}px`;
      node.style.height = `${item.offsetHeight}px`;
      node.style.top = `${item.offsetTop}px`;
      glide(node, item.offsetLeft, instant || !placed.current);
      placed.current = true;
    },
    [active, selector],
  );

  const latest = React.useRef(place);
  latest.current = place;

  React.useLayoutEffect(() => {
    place(false);
  }, [place]);

  // A resize (rotation, font scale) re-seats the pill without animating.
  React.useEffect(() => {
    const box = container.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) initial = false;
      else latest.current(true);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return { container, pill };
}
