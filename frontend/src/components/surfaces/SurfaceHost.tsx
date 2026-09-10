"use client";

/**
 * The layer that materialises over the globe when JARVIS has something to show.
 *
 * Three rules the panels inside it all inherit, because getting these wrong is
 * what makes an interface like this look impressive in a demo and feel awful to
 * use:
 *
 * 1. **The globe stays visible, and stays unobscured.** It is the anchor that
 *    makes this feel like one interface transforming rather than pages
 *    swapping. So the panel is glass, and on a wide screen it sits to one side
 *    with the globe breathing beside it — not a modal slapped over the middle.
 *
 * 2. **Information beats effect.** No transition delays the content: the panel
 *    animates in with its data already there. A pretty entrance that makes you
 *    wait to read the temperature is a regression, not a feature.
 *
 *    The entrance is slow — 560ms — and that is not in tension with the above.
 *    A 320ms entrance on a sheet covering two thirds of a phone screen does not
 *    read as fast, it reads as an appearance: the eye registers the end state
 *    without seeing the movement. The content is legible from the first frame
 *    either way; only the arrival takes longer.
 *
 * 3. **It is escapable.** Escape closes, the backdrop is not a trap, and the
 *    close control is a real button. An "instrument panel" you cannot dismiss
 *    is a modal wearing a costume.
 */

import { X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { DUR, usePresence, useReducedMotion } from "@/lib/motion";
import { SURFACE_TITLE, type SurfaceDescriptor } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

/**
 * Where the panel is being mounted.
 *
 * `"pane"` is the app shell: the panel covers the dashboard panes and stops at
 * the bottom bar. `"voice"` is the full-screen HUD, which is a `fixed`,
 * opaque, z-50 overlay — so a panel anchored to the shell renders perfectly
 * and is painted underneath it. That is not hypothetical: on the phone, where
 * every interaction is voice, the panels had never once been seen.
 */
export type SurfacePlacement = "pane" | "voice";

interface SurfaceHostProps {
  surface: SurfaceDescriptor | null;
  onClose: () => void;
  placement?: SurfacePlacement;
  children: React.ReactNode;
}

export function SurfaceHost({
  surface,
  onClose,
  placement = "pane",
  children,
}: SurfaceHostProps) {
  const voice = placement === "voice";
  const reduced = useReducedMotion();

  // The frame outlives the panels inside it.
  //
  // This container used to carry `key={surface.seq}`, and seq rises on every
  // descriptor — so React tore the whole panel down and built a new one each
  // time, every time. Weather to tasks was never a transition; it was an
  // unmount and a mount, with no shared element for the browser to interpolate
  // between, which is why no amount of CSS ever smoothed it.
  //
  // `usePresence` also gives the panel an exit. `if (!surface) return null`
  // meant closing was one frame of panel and one frame of nothing.
  const frame = usePresence(surface, DUR.exit);
  const shown = frame.rendered;

  // The panel on its way out, held for the length of its exit and drawn
  // underneath the arriving one so there is never an empty frame between two
  // panels. React elements are ordinary values; keeping the previous children
  // and rendering them once more costs nothing.
  const contentKey = surface ? `${surface.kind}:${surface.seq}` : null;
  const previous = React.useRef<{ key: string; node: React.ReactNode } | null>(null);
  const [outgoing, setOutgoing] = React.useState<{
    key: string;
    node: React.ReactNode;
  } | null>(null);

  React.useEffect(() => {
    const last = previous.current;
    previous.current = contentKey ? { key: contentKey, node: children } : null;

    if (!contentKey || !last || last.key === contentKey || reduced) return;

    setOutgoing(last);
    const timer = setTimeout(() => setOutgoing(null), DUR.exit);
    return () => clearTimeout(timer);
    // `children` is deliberately not a dependency: this must fire when the
    // panel changes, not when live data inside the current one updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey, reduced]);

  React.useEffect(() => {
    if (!surface) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [surface, onClose]);

  if (!shown) return null;

  const settled = frame.state === "present";
  const leaving = frame.state === "leaving";

  return (
    <div
      className={cn(
        "pointer-events-none flex items-stretch justify-end",
        // Covers the pane area, which is exactly what `main` is — never the
        // bottom bar, which is `main`'s sibling.
        //
        // Two earlier attempts were wrong in instructive ways. Inside the
        // dashboard column, the panel inherited that column's `display:none`
        // whenever the console was open, so asking a question on a phone
        // opened it into a hidden pane: measured 0x0 on the device. Fixed to
        // the viewport with a `calc(3.5rem + env(safe-area-inset-bottom))`
        // bottom inset, the arithmetic disagreed with the real bar by 17px and
        // buried the top of the navigation.
        //
        // Anchoring to `main` needs no arithmetic and cannot drift: whatever
        // the bar's height, the safe area, or the device, the panel covers the
        // panes and stops.
        placement === "pane" && "absolute inset-0 z-40",

        // Over the HUD the panel floats — it does not divide the screen.
        //
        // It was a full-bleed sheet anchored to three edges, and edge-to-edge
        // is exactly what makes a surface read as a *pane*: the eye takes any
        // element touching two opposite edges as a division of the window
        // rather than an object in it. The result felt like split screen, and
        // the core felt cut in half rather than sitting behind something.
        //
        // Detached from every edge, with the core visible all the way around
        // it, the same panel reads as a card hovering in the same space the
        // core occupies. Nothing about the content changed; only whether it
        // touches the sides.
        // Centred, and deployed rather than slid in.
        //
        // It used to be anchored to the bottom and rise. That is a sheet — a
        // phone UI convention — and it reads as one however it is dressed. A
        // HUD element does not travel in from an edge; it is projected where
        // it is going to be, and it unfolds there. So this is centred on both
        // axes and nothing about it translates.
        voice && ["fixed inset-0 z-[60] items-center justify-center p-4"],
      )}
      // Deliberately unkeyed. This carried `key={surface.seq}`, which made a
      // second "what's the weather" visibly re-materialise — but it did the
      // same for weather-to-tasks, tearing down a panel that should have been
      // transforming into the next one. Re-acknowledging a repeat is now the
      // content's job (it crossfades on `seq`) rather than the frame's.
    >
      {/* The beam: a dot that becomes a line, at the panel's eventual width.
          It hands over to the panel, which grows breadth out of it, and then
          fades — so the line the user watches draw is the line the rectangle
          is built on rather than a separate flourish. */}
      {voice && !leaving && (
        <span
          key={`beam:${shown.seq}`}
          aria-hidden
          className="pointer-events-none absolute h-[2px] w-[min(88vw,30rem)] animate-deploy-beam"
          style={{
            background:
              "linear-gradient(90deg, transparent, hsl(var(--accent)) 10%, #fff 50%, hsl(var(--accent)) 90%, transparent)",
            // A hot white core inside an accent bloom — this is what makes it
            // read as projected light rather than a drawn rule.
            boxShadow:
              "0 0 6px hsl(var(--accent)), 0 0 18px hsl(var(--accent) / 0.9), 0 0 42px hsl(var(--accent) / 0.5)",
          }}
        />
      )}

      <div
        role="region"
        aria-label={SURFACE_TITLE[shown.kind]}
        className={cn(
          "pointer-events-auto relative flex flex-col",
          voice ? "max-h-[76%] w-[min(88vw,30rem)]" : "h-full w-full",
          // Breadth grows out of the line; length never changes. `origin-center`
          // is what makes it unfold symmetrically rather than drop downward.
          voice && !leaving && "origin-center animate-deploy-panel",
          // Wide: a panel beside the globe, which keeps breathing next to it.
          // Narrow: full width, because a half-width panel on a small window is
          // just a cramped one.
          !voice && "lg:w-[clamp(30rem,46%,44rem)]",
          // No backdrop-blur over the HUD, and no fill.
          //
          // Blur is what made this read as a *window* — a rectangle of
          // differently-treated background sitting on the scene, with a visible
          // seam where the blur starts. That seam is the "part of the screen"
          // feeling: two backgrounds instead of one.
          //
          // A projection has one background. The readout is light drawn in the
          // same space as the core, so the panel contributes nothing of its own
          // and the scene behind it is continuous through the edge. Legibility
          // comes from dimming the core (VoiceMode) and from glow on the text,
          // never from putting a surface between them.
          !voice && "backdrop-blur-2xl",
          // Holographic, not a card.
          //
          // A rounded rectangle with a fill and a shadow is website furniture —
          // it reads as a component pasted over the scene. The Stark-HUD
          // language is the opposite: the surface is its *edge*, the fill is
          // almost nothing, and the corners are cut rather than rounded. So no
          // border-radius here at all; the shape comes from a bevelled
          // clip-path and the frame comes from corner brackets drawn below.
          voice
            ? "bg-[color:var(--surface-glass)] [clip-path:var(--hud-clip)]"
            : "rounded-none border-l border-[color:var(--surface-edge)] bg-[color:var(--surface-glass)]",
          // Leaving folds back the way it came — breadth first, so the
          // rectangle collapses to the line it grew out of.
          voice && [
            "transition-[opacity,transform] duration-[300ms] ease-[cubic-bezier(0.33,0,0.67,1)]",
            leaving && "scale-y-0 opacity-0",
          ],
          // The shell panel keeps its slide; it is a pane, not a projection.
          !voice && [
            "transition-[opacity,transform] duration-[560ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
            settled ? "translate-x-0 opacity-100" : "translate-x-10 opacity-0",
          ],
        )}
        style={
          {
            // Real glass over the HUD, not a wall.
            //
            // This was 88% opaque, which is legible and wrong: the whole point
            // of the panel living over the core is that the core is still
            // there behind it. At 88% it may as well have been a solid sheet.
            //
            // The legibility that opacity was buying is bought instead by
            // calming what is behind: when a panel opens, VoiceMode shrinks
            // the core, moves it clear and dims it. A quiet background needs
            // far less covering than a moving one, so the glass can be glass.
            // Nothing at all over the HUD.
            //
            // 88% was a wall, 58% a tinted window, 30% a faint one — every one
            // of them still a distinct rectangle of background laid over the
            // scene. The panel now paints no background whatsoever, so the
            // core behind it is exactly as bright inside the readout as
            // outside it, and there is no edge where one background becomes
            // another. What makes the text readable is the core dimming, which
            // is where that job belongs.
            "--surface-glass": voice
              ? "transparent"
              : "color-mix(in srgb, hsl(var(--surface-0)) 72%, transparent)",
            "--surface-edge": voice
              ? "hsl(var(--accent) / 0.55)"
              : "hsl(var(--accent) / 0.22)",
            // Cut corners rather than rounded ones. This single property is
            // most of the difference between "HUD" and "card".
            "--hud-clip":
              "polygon(0 16px, 16px 0, calc(100% - 16px) 0, 100% 16px, 100% calc(100% - 16px), calc(100% - 16px) 100%, 16px 100%, 0 calc(100% - 16px))",
            // The accent wash is gone too. Even at 7% it tinted a rectangle,
            // which is the same seam in a quieter colour.
          } as React.CSSProperties
        }
      >
        {voice ? (
          <>
            {/* The frame: four corner brackets rather than a continuous
                border. A closed outline draws a box; brackets imply one, and
                let the core read straight through the sides. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-deploy-readout"
              style={{
                background: `
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 0 0 / 26px 1px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 0 0 / 1px 26px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 100% 0 / 26px 1px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 100% 0 / 1px 26px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 0 100% / 26px 1px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 0 100% / 1px 26px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 100% 100% / 26px 1px no-repeat,
                  linear-gradient(hsl(var(--accent) / 0.75), hsl(var(--accent) / 0.75)) 100% 100% / 1px 26px no-repeat
                `,
                filter: "drop-shadow(0 0 6px hsl(var(--accent) / 0.5))",
              }}
            />
            {/* The bevelled edge itself, as a hairline. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 [clip-path:var(--hud-clip)]"
              style={{
                boxShadow: "inset 0 0 0 1px hsl(var(--accent) / 0.20)",
              }}
            />
            {/* No scanlines here. The HUD already draws them across the whole
                screen, and adding a second set inside the panel produced a
                rectangle of doubled lines — which is exactly the seam this
                design is trying not to have. The panel sits in the HUD's
                scanlines rather than carrying its own. */}
          </>
        ) : (
          /* A hairline of accent along the leading edge — the one piece of pure
             decoration, because it is what reads as "this materialised" rather
             than "a div appeared". */
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-px"
            style={{
              background:
                "linear-gradient(to bottom, transparent, hsl(var(--accent) / 0.55), transparent)",
            }}
          />
        )}

        <header
          className={cn(
            "relative flex shrink-0 items-center gap-3",
            voice ? "px-5 pb-2 pt-4" : "px-5 py-3",
          )}
        >
          {/* Re-keyed on seq so the marker pulses whenever a new descriptor
              arrives — including a repeat of the same panel. This is what now
              acknowledges "asked again", which the frame used to do by
              destroying itself. */}
          <span
            key={`dot:${shown.seq}`}
            aria-hidden
            className={cn(
              "animate-count-pop bg-accent",
              // A square tick, not a dot. Round dots are UI; ticks are
              // instrumentation, and every marker on the HUD behind this is
              // drawn from straight lines.
              voice ? "h-2 w-[3px]" : "h-1.5 w-1.5 rounded-full",
            )}
            style={{ boxShadow: "0 0 10px hsl(var(--accent))" }}
          />
          {/* Title and tool are the two things that change on every new panel,
              so they crossfade rather than cut. Relabelling in place is a
              surprising amount of what reads as "a different component just
              appeared". */}
          <h2
            key={`title:${shown.kind}`}
            className={cn(
              "animate-surface-in font-mono uppercase",
              voice
                ? "text-2xs tracking-[0.42em] text-accent/90"
                : "text-2xs tracking-[0.32em] text-ink-dim",
            )}
            style={voice ? { textShadow: "0 0 14px hsl(var(--accent) / 0.55)" } : undefined}
          >
            {SURFACE_TITLE[shown.kind]}
          </h2>
          <span
            key={`tool:${shown.tool}`}
            className="ml-auto animate-surface-in font-mono text-[0.6rem] uppercase tracking-[0.2em] text-ink-faint"
          >
            {shown.tool}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>

        {/* A ruled underline with tick marks, the way a readout is separated
            from its label on an instrument. A plain 1px border would be a card
            divider; the ticks are what make it read as a scale. */}
        {voice && (
          <span
            aria-hidden
            className="mx-5 mb-2 h-[7px] shrink-0"
            style={{
              background: `
                linear-gradient(hsl(var(--accent) / 0.45), hsl(var(--accent) / 0.45)) 0 0 / 100% 1px no-repeat,
                repeating-linear-gradient(90deg, hsl(var(--accent) / 0.45) 0 1px, transparent 1px 14px) 0 0 / 100% 5px no-repeat
              `,
            }}
          />
        )}

        <div className="relative min-h-0 flex-1">
          {/* The outgoing panel: absolutely positioned so it cannot shove the
              arriving one around while both are on screen, and inert so it
              cannot be clicked on its way out. */}
          {outgoing && (
            <div
              key={outgoing.key}
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-surface-out overflow-hidden px-5 pb-5"
            >
              {outgoing.node}
            </div>
          )}
          <div
            key={contentKey ?? "content"}
            className={cn(
              "h-full overflow-y-auto overscroll-contain px-5 pb-5",
              // On the HUD the readout is the last beat of the deploy, so it
              // waits for the rectangle to finish forming. In the shell there
              // is no deploy to wait for.
              !reduced && (voice ? "animate-deploy-readout" : "animate-surface-in"),
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Shared chrome for a labelled reading inside a panel.
 *
 * Exists so the secondary metrics across every surface line up: same label
 * size, same number weight, same alignment. Four panels each inventing their
 * own is how a set of instruments stops looking like one instrument.
 */
export function Metric({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line/60 bg-surface-1/40 px-3 py-2.5 backdrop-blur-sm",
        className,
      )}
    >
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 tnum text-lg font-medium leading-none text-ink">{value}</p>
      {hint && <p className="mt-1 text-2xs text-ink-dim">{hint}</p>}
    </div>
  );
}
