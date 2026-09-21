"use client";

import * as React from "react";
import Image from "next/image";
import { AudioLines, MicOff } from "lucide-react";
import type { VoiceSessionState } from "@/types";

/** Decorative motion follows session state; amplitude only comes from real audio. */
export function VoiceSculpture({ state, level, muted }: { state: VoiceSessionState; level: number; muted: boolean }) {
  const audible = state === "speaking" || (state === "hearing" && !muted);
  const amplitude = audible && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return <div className="pocket-sculpture" data-state={state} data-muted={muted} aria-hidden="true">
    <div className="pocket-sculpture-aura" />
    <div className="pocket-sculpture-orbit pocket-orbit-one" />
    <div className="pocket-sculpture-orbit pocket-orbit-two" />
    <div className="pocket-sculpture-response" style={{ transform: `scale(${1 + amplitude * .075})` }}>
      <div className="pocket-sculpture-turn"><Image src="/mobile/sea-glass-loop.png" width={1254} height={1254} alt="" unoptimized priority draggable={false} /></div>
    </div>
    <div className="pocket-sculpture-center glass">{muted ? <MicOff size={27} /> : <AudioLines size={27} />}</div>
    <div className="pocket-sculpture-thinking"><i /><i /><i /></div>
  </div>;
}
