"use client";

import * as React from "react";
import { LockSimple } from "@phosphor-icons/react";

import { haptic } from "@/components/phone/lib/haptics";
import { reducedMotion } from "@/components/phone/lib/motion";
import { useAppData } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { pick, type Mood } from "./content";
import { Cta, Quiet, StepFrame } from "./ui";
import { clock12, daysLabel, lockIn, resolveRecords, type AddedBlock } from "./weekPlan";

const PICK_LINES = ["Locked. No way out now.", "That one's sacred.", "Non-negotiable.", "Serious mode: on.", "Noted. No excuses."];

/**
 * The slam: a heavy haptic, a red flash over the whole screen and a short
 * shake of everything on it. The flash and the shake are Web Animations on
 * opacity and transform, so the compositor plays them; reduced motion keeps
 * only the haptic.
 */
function slam(from: Element | null, big: boolean) {
  haptic("heavy");
  if (reducedMotion()) return;
  const root = from?.closest(".ob");
  root?.querySelector(".ob-lk-flash")?.animate(
    [{ opacity: 0 }, { opacity: big ? 0.62 : 0.3, offset: 0.16 }, { opacity: 0 }],
    { duration: big ? 640 : 340, easing: "ease-out" },
  );
  const amount = big ? 10 : 5;
  const frames = [0, -amount, amount * 0.8, -amount * 0.5, amount * 0.3, 0].map((x, index) => ({
    transform: `translate(${x}px, ${index % 2 ? amount * 0.25 : 0}px)`,
  }));
  root?.querySelectorAll(".ob-head, .ob-stage").forEach((element) => element.animate(frames, { duration: big ? 460 : 280, easing: "ease-out" }));
}

/** A lock whose shackle drops shut when it is picked. */
function LockGlyph({ on }: { on: boolean }) {
  return (
    <span className="ob-lk-lock" data-on={on || undefined} aria-hidden="true">
      <i className="ob-lk-shackle" />
      <i className="ob-lk-body" />
    </span>
  );
}

/**
 * "Pick the ones you won't skip." Each pick becomes serious in Lock-in
 * (Start → Done, skips counted), via the same /api/focus marks the Lock-in
 * screen writes. Picking any asks for the free 3-day trial. Free time from
 * the generated timetable is never offered here.
 *
 * Deliberately not cute: black and red, a slow heartbeat behind it (the
 * onboarding root draws that while this step is up), and every pick slams.
 */
export function LockinStep({ blocks, mustDo, setMustDo, marked, setMarked, onResolved, react, next }: {
  blocks: AddedBlock[];
  mustDo: string[];
  setMustDo: (ids: string[]) => void;
  marked: string[];
  setMarked: (uids: string[]) => void;
  onResolved: (blocks: AddedBlock[]) => void;
  react: (mood: Mood, line: string) => void;
  next: () => void;
}) {
  const { app } = useAppData();
  const appRef = React.useRef(app);
  appRef.current = app;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stamped, setStamped] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const leave = React.useRef<number>();
  React.useEffect(() => () => window.clearTimeout(leave.current), []);

  const lockable = blocks.filter((block) => block.template !== "free");
  const picked = lockable.filter((block) => mustDo.includes(block.id));
  const count = picked.length;

  const toggle = (block: AddedBlock, element: Element) => {
    setError(null);
    if (mustDo.includes(block.id)) {
      setMustDo(mustDo.filter((id) => id !== block.id));
      haptic("toggle-off");
      react("calm", "Fair. That one can bend.");
      return;
    }
    setMustDo([...mustDo, block.id]);
    slam(element, false);
    react("fierce", pick(PICK_LINES));
  };

  const resolveAll = (list: AddedBlock[]) => list.map((block) => ({ ...block, records: resolveRecords(block, appRef.current.state?.schedule) }));

  const commit = async () => {
    if (busy || count === 0) return;
    setBusy(true);
    setError(null);
    let all = resolveAll(blocks);
    // Where the backend owns the records their uids come from the dashboard,
    // which may not have caught up with the writes yet.
    const unresolved = () => all.some((block) => mustDo.includes(block.id) && block.template !== "free" && block.records.some((record) => !record.uid));
    if (unresolved()) {
      await appRef.current.refresh().catch(() => undefined);
      for (let tries = 0; tries < 10 && unresolved(); tries += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        all = resolveAll(blocks);
      }
    }
    onResolved(all);
    const chosen = all.filter((block) => block.template !== "free" && mustDo.includes(block.id));
    const result = await lockIn(chosen, marked, appRef.current.state?.schedule);
    setMarked(result.marked);
    setBusy(false);
    if (result.marked.length === 0) {
      setError("Couldn't lock them in yet. Your JARVIS may still be starting up. Try again in a moment.");
      haptic("warning");
      react("oops", "My brain's still booting. One more try.");
      return;
    }
    setStamped(true);
    slam(root.current, true);
    react("fierce", result.missing || result.failed ? "Most of it's locked. Finish the rest in Lock-in." : "Locked in. No take-backs.");
    leave.current = window.setTimeout(next, reducedMotion() ? 1100 : 1800);
  };

  const skip = () => {
    if (marked.length) void lockIn([], marked, null).then(() => setMarked([]));
    setMustDo([]);
    next();
  };

  return (
    <div ref={root} className="ob-step ob-lk">
      <StepFrame
        eyebrow="10 · Lock-in"
        title="Pick the ones you won't skip."
        sub="No excuses. Every skip gets counted."
        footer={
          <>
            <Cta
              variant="lock"
              icon={<LockSimple size={19} weight="fill" />}
              feel="tap"
              disabled={count === 0}
              busy={busy || stamped}
              onClick={() => void commit()}
            >
              {stamped ? "Locked in" : busy ? "Locking in…" : count === 0 ? "Pick at least one" : count === 1 ? "Lock it in" : `Lock ${count} in`}
            </Cta>
            {!stamped && <Quiet onClick={skip}>Not now</Quiet>}
          </>
        }
      >
        <div className="ob-lk-brief">
          <span className="ob-lk-tag"><LockSimple size={12} weight="fill" aria-hidden="true" /> Lock-in · 3-day trial</span>
          <p>Hit <b>Start</b>. Hit <b>Done</b>. Miss it, and it&apos;s on the record.</p>
        </div>
        <div className="ob-lk-list" role="group" aria-label="Your blocks">
          {lockable.map((block, index) => {
            const on = mustDo.includes(block.id);
            // The entrance lives on a wrapper so un-picking a row never replays it.
            return (
              <div key={block.id} className="ob-lk-enter" style={{ "--i": index } as React.CSSProperties}>
                <Tap
                  className="ob-lk-row"
                  data-on={on || undefined}
                  aria-pressed={on}
                  feel={false}
                  squish={0.97}
                  disabled={busy || stamped}
                  onClick={(event) => toggle(block, event.currentTarget)}
                >
                  <span className="ob-lk-num" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className="ob-lk-text">
                    <strong>{block.name}</strong>
                    <small>{daysLabel(block.days)} · {clock12(block.start)}–{clock12(block.end)}</small>
                  </span>
                  <LockGlyph on={on} />
                </Tap>
              </div>
            );
          })}
        </div>
        {error && <p className="ob-error ob-lk-error" role="alert">{error}</p>}
      </StepFrame>
      {stamped && (
        <div className="ob-lk-stamp" role="status">
          <span className="ob-lk-stamp-word">Locked in</span>
          <span className="ob-lk-stamp-sub">{count} must-do{count === 1 ? "" : "s"} · 3-day trial is on</span>
        </div>
      )}
    </div>
  );
}
