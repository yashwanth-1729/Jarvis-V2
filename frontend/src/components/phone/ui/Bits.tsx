"use client";

import * as React from "react";

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

/** Friendly empty state; its glyph floats (a CSS loop, so it costs no JavaScript). */
export function Empty({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="ph-empty ph-rise">
      <span className="ph-empty-glyph">{icon}</span>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
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

/**
 * Words that arrive one after another, springing up into place. Each word is
 * a CSS animation with its own delay, so the cascade plays on the compositor.
 */
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
        <React.Fragment key={`${word}-${index}`}>
          <span aria-hidden="true" className="ph-kinetic-word" style={{ animationDelay: `${Math.round((delay + index * step) * 1000)}ms` }}>
            {word}
          </span>
          {/* The space sits between the words: inside an inline-block it would be trimmed. */}
          {index < words.length - 1 ? " " : null}
        </React.Fragment>
      ))}
    </Tag>
  );
}

/** Stagger index for the CSS entrance classes (`ph-rise`, `ph-slide-in`, `ph-drop-in`). */
export function stagger(index: number): React.CSSProperties {
  return { "--i": Math.min(index, 8) } as React.CSSProperties;
}
