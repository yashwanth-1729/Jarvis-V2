"use client";

import * as React from "react";
import { prefersQuietMotion } from "@/lib/uiMotion";

/** Animate only the displacement of records which already existed. */
export function useListMotion(signature: string) {
  const root = React.useRef<HTMLDivElement>(null);
  const positions = React.useRef(new Map<string, number>());
  const running = React.useRef<Animation[]>([]);
  React.useLayoutEffect(() => {
    running.current.forEach(animation => animation.cancel());
    running.current = [];
    const next = new Map<string, number>();
    const parent = root.current;
    if (!parent) return;
    const scroll = parent.closest('.workspace-page')?.scrollTop ?? 0;
    for (const element of parent.querySelectorAll<HTMLElement>('[data-motion-key]')) {
      const key = element.dataset.motionKey!;
      const top = element.getBoundingClientRect().top + scroll;
      next.set(key, top);
      const old = positions.current.get(key);
      if (old === undefined || prefersQuietMotion() || Math.abs(old - top) < 1 || Math.abs(old - top) > 600) continue;
      running.current.push(element.animate([
        { transform: `translateY(${old - top}px)` }, { transform: 'translateY(0)' },
      ], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' }));
    }
    positions.current = next;
  }, [signature]);
  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => running.current.forEach(animation => animation.cancel());
    media.addEventListener('change', stop);
    return () => { stop(); media.removeEventListener('change', stop); };
  }, []);
  return root;
}
