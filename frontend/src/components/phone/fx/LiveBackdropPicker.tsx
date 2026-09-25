"use client";

import * as React from "react";

import { haptic } from "../lib/haptics";
import { Icon3D, type Icon3DName } from "../ui/Icon3D";
import { useLook } from "../PhoneContext";
import { emitFx } from "./fxBus";
import type { FxMode } from "./LiveBackground";

const BACKDROPS: Array<{ value: FxMode; label: string; hint: string; icon: Icon3DName }> = [
  { value: "vivid", label: "Vivid", hint: "Colour that flows and answers every tap", icon: "sparkle" },
  { value: "wild", label: "Wild", hint: "Louder flow, bigger shockwaves, sparks", icon: "bolt" },
  { value: "calm", label: "Calm", hint: "A slow, quiet glow", icon: "leaf" },
  { value: "off", label: "Off", hint: "Plain background, nothing moving", icon: "stop" },
];

/** The live background's modes as swatch cards; each previews its own motion. */
export function LiveBackdropPicker() {
  const { fx, setFx } = useLook();
  return (
    <div className="ph-backdrops" role="radiogroup" aria-label="Live background">
      {BACKDROPS.map(({ value, label, hint, icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={fx === value}
          className="ph-backdrop-choice ph-tap"
          data-mode={value}
          data-on={fx === value}
          onClick={(event) => {
            if (fx === value) return;
            const origin = event.currentTarget;
            setFx(value);
            haptic("select", false);
            // Show off the new mode right where it was chosen.
            window.setTimeout(() => emitFx(value === "wild" ? "success" : "heavy", origin), 60);
          }}
        >
          <span className="ph-backdrop-swatch" aria-hidden="true"><i /><i /><i /></span>
          <span className="ph-backdrop-copy">
            <strong><Icon3D name={icon} size={20} /> {label}</strong>
            <small>{hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
