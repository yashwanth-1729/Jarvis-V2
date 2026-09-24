"use client";

import * as React from "react";
import { motion, useScroll, useTransform } from "framer-motion";

/**
 * A scrolling page with a big title that hands over to a compact sticky bar.
 *
 * Everything scroll-linked runs on motion values, so scrolling never
 * re-renders React: the title slides and fades, the bar's glass fades in, and
 * the actions stay reachable the whole way down.
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
  const ref = React.useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll({ container: ref });
  const barGlass = useTransform(scrollY, [8, 64], [0, 1]);
  const miniTitle = useTransform(scrollY, [52, 92], [0, 1]);
  const miniY = useTransform(scrollY, [52, 92], [8, 0]);
  const bigY = useTransform(scrollY, [0, 120], [0, -36]);
  const bigOpacity = useTransform(scrollY, [0, 80], [1, 0]);
  const bigScale = useTransform(scrollY, [0, 120], [1, 0.94]);

  return (
    <div ref={ref} className={`ph-screen ${className ?? ""}`} data-tone={tone} data-pad={bottomPad}>
      <div className="ph-topbar">
        <motion.div className="ph-topbar-glass" style={{ opacity: barGlass }} aria-hidden="true" />
        <div className="ph-topbar-lead">{leading}</div>
        <motion.span className="ph-topbar-title" style={{ opacity: miniTitle, y: miniY }} aria-hidden="true">
          {title}
        </motion.span>
        <div className="ph-topbar-actions">{actions}</div>
      </div>
      <header className="ph-hero">
        {eyebrow && <div className="ph-eyebrow">{eyebrow}</div>}
        <motion.h1 className="ph-title" style={{ y: bigY, opacity: bigOpacity, scale: bigScale, transformOrigin: "0% 100%" }}>
          {title}
        </motion.h1>
        {hero}
      </header>
      {children}
    </div>
  );
}
