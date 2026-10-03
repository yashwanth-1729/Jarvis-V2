"use client";

import * as React from "react";
import { ArrowRight, Check } from "@phosphor-icons/react";

import type { HapticKind } from "@/components/phone/lib/haptics";
import { Tap } from "@/components/phone/ui/Tap";
import type { Tone } from "./content";

/** One question: a big headline, a line under it, the answers, a pinned button. */
export function StepFrame({ eyebrow, title, sub, children, footer }: {
  eyebrow?: string;
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="ob-step">
      <div className="ob-step-body">
        {eyebrow && <span className="ob-eyebrow">{eyebrow}</span>}
        <h2 className="ob-title" data-ob-title tabIndex={-1}>{title}</h2>
        {sub && <p className="ob-sub">{sub}</p>}
        {children}
      </div>
      {footer && <div className="ob-step-foot">{footer}</div>}
    </div>
  );
}

/** The big go-on button. Springs into place the moment it can be pressed. */
export function Cta({ children, disabled = false, busy = false, onClick, arrow = true, feel = "heavy" }: {
  children: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
  arrow?: boolean;
  feel?: HapticKind | false;
}) {
  return (
    <Tap
      key={disabled ? "off" : "on"}
      className="ob-cta"
      data-ready={!disabled || undefined}
      data-busy={busy || undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      feel={feel}
      squish={0.94}
      onClick={onClick}
    >
      <span>{children}</span>
      {arrow && !busy && <ArrowRight size={20} weight="bold" aria-hidden="true" />}
    </Tap>
  );
}

/** A quiet text button under the main one ("Skip for now"). */
export function Quiet({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Tap className="ob-quiet" feel="tap" squish={0.96} onClick={onClick}>
      {children}
    </Tap>
  );
}

/** A multi-select chip with an emoji. */
export function Chip({ on, tone, emoji, label, onClick, index = 0, disabled = false }: {
  on: boolean;
  tone: Tone;
  emoji?: string;
  label: string;
  onClick: () => void;
  index?: number;
  disabled?: boolean;
}) {
  return (
    <Tap
      className="ob-chip"
      data-tone={tone}
      data-on={on}
      aria-pressed={on}
      feel={on ? "toggle-off" : "toggle-on"}
      squish={0.9}
      disabled={disabled}
      onClick={onClick}
      style={{ "--i": index, "--tilt": `${(index % 3) - 1}deg` } as React.CSSProperties}
    >
      {emoji && <span className="ob-chip-emoji" aria-hidden="true">{emoji}</span>}
      <span>{label}</span>
    </Tap>
  );
}

/** A big single-choice card (radio). */
export function OptionCard({ on, tone, emoji, title, line, badge, onClick, index = 0, dim = false }: {
  on: boolean;
  tone: Tone;
  emoji: string;
  title: React.ReactNode;
  line?: React.ReactNode;
  badge?: React.ReactNode;
  onClick: () => void;
  index?: number;
  dim?: boolean;
}) {
  return (
    <Tap
      role="radio"
      aria-checked={on}
      className="ob-card"
      data-tone={tone}
      data-on={on}
      data-dim={dim || undefined}
      feel="select"
      squish={0.95}
      onClick={onClick}
      style={{ "--i": index, "--tilt": `${index % 2 === 0 ? -1.2 : 1.2}deg` } as React.CSSProperties}
    >
      <span className="ob-card-emoji" aria-hidden="true">{emoji}</span>
      <span className="ob-card-text">
        <strong>{title}</strong>
        {line && <small>{line}</small>}
      </span>
      {badge}
      <span className="ob-card-check" aria-hidden="true"><Check size={16} weight="bold" /></span>
    </Tap>
  );
}

/** Seven day toggles, Monday first. */
export function DayToggles({ value, onChange, tone }: { value: number[]; onChange: (days: number[]) => void; tone: Tone }) {
  const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return (
    <div className="ob-days" role="group" aria-label="Days">
      {names.map((day, index) => {
        const on = value.includes(index);
        return (
          <Tap
            key={day}
            className="ob-day"
            data-tone={tone}
            data-on={on}
            aria-pressed={on}
            aria-label={day}
            feel={on ? "toggle-off" : "toggle-on"}
            squish={0.85}
            onClick={() => onChange(on ? value.filter((item) => item !== index) : [...value, index].sort((a, b) => a - b))}
          >
            {day.slice(0, 1)}
          </Tap>
        );
      })}
    </div>
  );
}
