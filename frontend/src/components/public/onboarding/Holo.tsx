"use client";

import * as React from "react";

import type { Mood, Persona } from "./content";

/** Who HOLO is talking to; the onboarding root provides it once she answers. */
export const PersonaContext = React.createContext<Persona>(null);

/**
 * HOLO for onboarding: a bigger, more expressive take on the dock's CSS face
 * (voice/HoloFace.tsx), so it can pull a face for every answer without
 * loading three.js on first launch.
 *
 * The face is a stack of eye and mouth shapes; `data-mood` decides which are
 * showing, and they swap with a spring on transform and opacity only. Bumping
 * `kick` restarts the hop (the wrapper is re-keyed). `glitchIn` plays the boot
 * materialisation once. Under reduced motion everything holds still.
 *
 * For her (PersonaContext), one small touch: a bow tied on the antenna.
 */
export function Holo({ mood, kick = 0, size, glitchIn = false, className }: {
  mood: Mood;
  kick?: number;
  size: number;
  glitchIn?: boolean;
  className?: string;
}) {
  const persona = React.useContext(PersonaContext);
  return (
    <span
      className={className ? `ob-holo ${className}` : "ob-holo"}
      data-mood={mood}
      data-glitch-in={glitchIn || undefined}
      data-persona={persona ?? undefined}
      style={{ "--s": `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="ob-holo-float">
        <span key={kick} className="ob-holo-body" data-kick={kick > 0 || undefined}>
          <span className="ob-holo-ghost" data-c="a" />
          <span className="ob-holo-ghost" data-c="b" />
          <span className="ob-holo-antenna">
            <i />
            {persona === "her" && (
              <span className="ob-holo-bow">
                <b data-side="l" />
                <b data-side="r" />
                <em />
              </span>
            )}
          </span>
          <span className="ob-holo-ear" data-side="l" />
          <span className="ob-holo-ear" data-side="r" />
          <span className="ob-holo-head">
            <span className="ob-holo-rim" />
            <span className="ob-holo-visor">
              <span className="ob-holo-brows"><i /><i /></span>
              <span className="ob-holo-eyes">
                <Eye />
                <Eye />
              </span>
              <span className="ob-holo-shades"><i /><i /></span>
              <span className="ob-holo-mouth">
                <i data-m="smile" />
                <i data-m="grin" />
                <i data-m="o" />
                <i data-m="flat" />
                <i data-m="smirk" />
              </span>
              <span className="ob-holo-blush"><i /><i /></span>
              <span className="ob-holo-scan" />
            </span>
          </span>
          <span className="ob-holo-zz">z</span>
        </span>
      </span>
      <span className="ob-holo-pad" />
    </span>
  );
}

function Eye() {
  return (
    <span className="ob-eye">
      <i data-e="pill" />
      <i data-e="arc" />
      <i data-e="calm" />
      <i data-e="line" />
      <i data-e="ring" />
      <i data-e="heart">♥</i>
      <i data-e="star">✦</i>
    </span>
  );
}

/** HOLO's speech bubble: the line pops in word by word. */
export function Bubble({ line, tone = "lime" }: { line: string; tone?: string }) {
  const words = line.split(/\s+/).filter(Boolean);
  return (
    <p key={line} className="ob-bubble" data-tone={tone} aria-live="polite">
      {words.map((word, index) => (
        <React.Fragment key={`${word}-${index}`}>
          <span className="ob-word" style={{ "--i": index } as React.CSSProperties}>{word}</span>
          {index < words.length - 1 ? " " : null}
        </React.Fragment>
      ))}
    </p>
  );
}
