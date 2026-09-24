"use client";

import * as React from "react";
import { motion } from "framer-motion";

import type { Tone } from "../lib/derive";

/** A small tilted label, like a sticker slapped on a card. */
export function Sticker({ tone = "lime", tilt = -3, children, pulse = false }: {
  tone?: Tone;
  tilt?: number;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className="ph-sticker" data-tone={tone} style={{ rotate: `${tilt}deg` }}>
      {pulse && <span className="ph-live-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A flat tag for metadata. */
export function Chip({ tone, children, icon }: { tone?: Tone | null; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <span className="ph-chip" data-tone={tone ?? undefined}>
      {icon}
      {children}
    </span>
  );
}

/** Uppercase pixel-font section label with an optional trailing action. */
export function SectionHead({ title, action, count }: { title: string; action?: React.ReactNode; count?: number }) {
  return (
    <div className="ph-section-head">
      <h2>
        {title}
        {count !== undefined && <span className="ph-section-count">{String(count).padStart(2, "0")}</span>}
      </h2>
      {action}
    </div>
  );
}

/** Friendly empty state with a floating emoji-free glyph. */
export function Empty({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <motion.div
      className="ph-empty"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
    >
      <motion.span
        className="ph-empty-glyph"
        animate={{ y: [0, -6, 0], rotate: [0, -4, 0] }}
        transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
      >
        {icon}
      </motion.span>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </motion.div>
  );
}

/** Shimmering placeholder rows while the first data arrives. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="ph-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="ph-skeleton-row" style={{ animationDelay: `${index * 90}ms` }} />
      ))}
    </div>
  );
}

/** Words that arrive one after another, springing up into place. */
export function KineticText({ text, as: Tag = "span", className, delay = 0, step = 0.045 }: {
  text: string;
  as?: "span" | "h1" | "h2" | "p";
  className?: string;
  delay?: number;
  step?: number;
}) {
  const words = text.split(" ");
  return (
    <Tag className={className} aria-label={text}>
      {words.map((word, index) => (
        <motion.span
          key={`${word}-${index}`}
          aria-hidden="true"
          className="ph-kinetic-word"
          initial={{ opacity: 0, y: "0.6em", rotate: 4 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 22, delay: delay + index * step }}
        >
          {word}
          {index < words.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </Tag>
  );
}
