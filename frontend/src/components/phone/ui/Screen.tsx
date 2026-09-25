"use client";

import * as React from "react";

/**
 * A scrolling page with a big title that hands over to a compact sticky bar.
 *
 * The big title simply scrolls with the page. An IntersectionObserver watches
 * a marker under it and flips `data-scrolled` on the page once the title has
 * passed under the bar; CSS then fades the bar's background and mini title in.
 * Nothing listens to scroll events and nothing is tied to the scroll position,
 * so flings stay entirely native. (A CSS scroll-driven animation did this
 * before, but in the Android WebView it held the page's scroll updates back
 * until a fling ended: the page froze, then jumped to where it stopped.)
 */
export function Screen({
  title,
  eyebrow,
  actions,
  leading,
  hero,
  children,
  tone = "lime",
  className,
  bottomPad = true,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  leading?: React.ReactNode;
  /** Extra content under the big title (counts, filters). */
  hero?: React.ReactNode;
  children: React.ReactNode;
  tone?: string;
  className?: string;
  /** Leave room for the dock. */
  bottomPad?: boolean;
}) {
  const page = React.useRef<HTMLDivElement>(null);
  const bar = React.useRef<HTMLDivElement>(null);
  const marker = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const root = page.current;
    const target = marker.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const barHeight = bar.current?.offsetHeight ?? 60;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Written straight to the DOM: no React render for a scroll effect.
        root.dataset.scrolled = String(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
      },
      { root, rootMargin: `-${barHeight}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={page} className={`ph-screen ${className ?? ""}`} data-tone={tone} data-pad={bottomPad} data-scrolled="false">
      <div ref={bar} className="ph-topbar">
        <div className="ph-topbar-glass" aria-hidden="true" />
        <div className="ph-topbar-lead">{leading}</div>
        <span className="ph-topbar-title" aria-hidden="true">
          {title}
        </span>
        <div className="ph-topbar-actions">{actions}</div>
      </div>
      <header className="ph-hero">
        {eyebrow && <div className="ph-eyebrow">{eyebrow}</div>}
        <h1 className="ph-title">{title}</h1>
        <span ref={marker} className="ph-title-marker" aria-hidden="true" />
        {hero}
      </header>
      {children}
    </div>
  );
}
