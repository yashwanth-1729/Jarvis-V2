"use client";

import { AudioLines } from "lucide-react";
import dynamic from "next/dynamic";
import * as React from "react";

import { cn } from "@/lib/utils";

// Same lazy chunk the full-screen HUD uses, so entering voice mode after this
// has rendered costs no extra download.
const JarvisCore = dynamic(
  () => import("@/components/three/JarvisCore").then((m) => m.JarvisCore),
  { ssr: false },
);

/**
 * The voice hero — the first thing on the console, and the loudest thing on
 * the screen.
 *
 * JARVIS is voice-first, so this is a composed panel rather than a button in a
 * row of buttons: the core sits behind as ambience (contained and scrimmed, not
 * a floating orb), and a single solid CTA carries the action. Typing lives
 * below it, deliberately quieter.
 */
export function VoiceLauncher({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-surface-2",
        className,
      )}
    >
      {/* Ambience. Clipped to the panel and heavily scrimmed so it never
          competes with the label sitting on top of it. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-45">
        <JarvisCore state="listening" className="h-full w-full" />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-surface-2 via-surface-2/85 to-surface-2/40"
      />

      <div className="relative flex flex-col items-center gap-1 px-4 pb-4 pt-5 text-center">
        <h2 className="font-display text-xl font-semibold tracking-tight text-ink">
          Talk to JARVIS
        </h2>
        <p className="mb-4 max-w-[34ch] text-sm leading-relaxed text-ink-dim">
          Ask what&rsquo;s on, add a task, or just think out loud. Say
          &ldquo;period&rdquo; when you&rsquo;re done.
        </p>

        <button
          type="button"
          onClick={onClick}
          className={cn(
            // 44px minimum target; the label carries the meaning, not the icon.
            "group flex h-11 w-full max-w-[300px] cursor-pointer items-center justify-center gap-2.5 rounded px-4",
            "bg-accent text-accent-ink",
            "transition-[background-color,transform] duration-150",
            "hover:bg-accent/90 active:scale-[0.99]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2",
          )}
        >
          <AudioLines className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
          <span className="text-md font-semibold tracking-tight">Start talking</span>
          <kbd className="ml-1 rounded-[3px] border border-accent-ink/25 bg-accent-ink/10 px-1.5 py-0.5 font-mono text-2xs font-medium">
            Ctrl J
          </kbd>
        </button>
      </div>
    </section>
  );
}
