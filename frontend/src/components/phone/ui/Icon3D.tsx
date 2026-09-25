"use client";

import * as React from "react";

/**
 * The phone's 3D icon set: glossy candy-toy objects generated with Higgsfield
 * (three 4x4 sheets, sliced into `public/icons3d/*.webp`, 192 px each).
 *
 * Used only where an icon is decoration: empty states, Settings rows, chat
 * prompt cards and notebook covers. Buttons, the dock, voice controls, forms
 * and inline glyphs keep line icons; the full 3D set everywhere was too loud.
 */
export type Icon3DName =
  | "add" | "bell" | "bolt" | "broom" | "bulb" | "cap" | "chat" | "clock" | "compass" | "copy"
  | "eye" | "fire" | "flask" | "hand" | "home" | "hourglass" | "key" | "keyboard" | "leaf" | "memory"
  | "mic" | "mic-off" | "moon" | "notebook" | "offline" | "party" | "phone" | "pin" | "plan" | "plug"
  | "refresh" | "repeat" | "search" | "send" | "server" | "settings" | "shield" | "sparkle" | "speaker"
  | "stop" | "sun" | "sync" | "target" | "tasks" | "translate" | "trash" | "warning" | "waveform";

export function Icon3D({ name, size = 28, className }: { name: Icon3DName; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className ? `ph-i3d ${className}` : "ph-i3d"}
      src={`/icons3d/${name}.webp`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
    />
  );
}
