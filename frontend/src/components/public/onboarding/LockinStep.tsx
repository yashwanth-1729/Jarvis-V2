"use client";

import * as React from "react";
import { LockSimple, LockSimpleOpen } from "@phosphor-icons/react";

import { emitFx } from "@/components/phone/fx/fxBus";
import { haptic } from "@/components/phone/lib/haptics";
import { useAppData } from "@/components/phone/PhoneContext";
import { Tap } from "@/components/phone/ui/Tap";
import { pick, type Mood } from "./content";
import { Cta, Quiet, StepFrame } from "./ui";
import { clock12, daysLabel, lockIn, resolveRecords, type AddedBlock } from "./weekPlan";

const PICK_LINES = ["Locked. No escape now. 😈", "That one's sacred. Got it.", "Non-negotiable. Respect.", "Okay, serious mode for that one."];

/**
 * "Which of these can you NOT skip?" Each pick becomes serious in Lock-in
 * (Start → Done, skips counted), via the same /api/focus marks the Lock-in
 * screen writes. Picking any asks for the free 3-day trial.
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
  const leave = React.useRef<number>();
  React.useEffect(() => () => window.clearTimeout(leave.current), []);

  const toggle = (block: AddedBlock) => {
    setError(null);
    if (mustDo.includes(block.id)) {
      setMustDo(mustDo.filter((id) => id !== block.id));
      react("calm", "Fair. That one can bend.");
      return;
    }
    setMustDo([...mustDo, block.id]);
    react("fierce", pick(PICK_LINES));
  };

  const resolveAll = (list: AddedBlock[]) => list.map((block) => ({ ...block, records: resolveRecords(block, appRef.current.state?.schedule) }));

  const commit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let all = resolveAll(blocks);
    // Where the backend owns the records their uids come from the dashboard,
    // which may not have caught up with the writes yet.
    if (all.some((block) => mustDo.includes(block.id) && block.records.some((record) => !record.uid))) {
      await appRef.current.refresh().catch(() => undefined);
      for (let tries = 0; tries < 10; tries += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        all = resolveAll(blocks);
        if (all.every((block) => !mustDo.includes(block.id) || block.records.every((record) => record.uid))) break;
      }
    }
    onResolved(all);
    const picked = all.filter((block) => mustDo.includes(block.id));
    const result = await lockIn(picked, marked, appRef.current.state?.schedule);
    setMarked(result.marked);
    setBusy(false);
    if (result.marked.length === 0) {
      setError("Couldn't lock them in yet. Your JARVIS may still be starting up. Try again in a moment.");
      haptic("warning");
      react("oops", "Ugh, my brain's still booting. One more try?");
      return;
    }
    haptic("success");
    emitFx("success", { x: 0.5, y: 0.5 });
    setStamped(true);
    react("fierce", result.missing || result.failed ? "Most of it's locked in. You can finish the rest in Lock-in." : `${picked.length === 1 ? "Locked in" : `All ${picked.length} locked in`}. 3 days free, starting now.`);
    leave.current = window.setTimeout(next, 900);
  };

  const skip = () => {
    if (marked.length) void lockIn([], marked, null).then(() => setMarked([]));
    setMustDo([]);
    next();
  };

  const count = mustDo.length;
  return (
    <StepFrame
      eyebrow="10 · Must-dos"
      title="Which of these can you NOT skip?"
      footer={
        <>
          <Cta disabled={count === 0} busy={busy || stamped} arrow={!stamped} onClick={() => void commit()}>
            {stamped ? "Locked in 🔒" : busy ? "Locking in…" : count === 0 ? "Pick at least one" : `Lock ${count === 1 ? "it" : `${count}`} in`}
          </Cta>
          {!stamped && <Quiet onClick={skip}>Not now</Quiet>}
        </>
      }
    >
      <div className="ob-lockin-card">
        <span className="ob-lockin-tag"><LockSimple size={13} weight="fill" aria-hidden="true" /> Lock-in · 3 days free</span>
        <p>Hit <b>Start</b>. Hit <b>Done</b>. Every skip gets counted. The first 3 days are on me.</p>
      </div>
      <div className="ob-must" role="group" aria-label="Your blocks">
        {blocks.map((block, index) => {
          const on = mustDo.includes(block.id);
          return (
            <Tap
              key={block.id}
              className="ob-must-row"
              data-tone={block.tone}
              data-on={on}
              data-stamped={(stamped && on) || undefined}
              aria-pressed={on}
              feel={on ? "toggle-off" : "heavy"}
              squish={0.96}
              disabled={busy || stamped}
              style={{ "--i": index } as React.CSSProperties}
              onClick={() => toggle(block)}
            >
              <span className="ob-must-emoji" aria-hidden="true">{block.emoji}</span>
              <span className="ob-must-text">
                <strong>{block.name}</strong>
                <small>{daysLabel(block.days)} · {clock12(block.start)}–{clock12(block.end)}</small>
              </span>
              <span className="ob-must-lock" aria-hidden="true">
                {on ? <LockSimple size={20} weight="fill" /> : <LockSimpleOpen size={20} weight="bold" />}
              </span>
              {stamped && on && <span className="ob-stamp" aria-hidden="true">LOCKED</span>}
            </Tap>
          );
        })}
      </div>
      {error && <p className="ob-error" role="alert">{error}</p>}
    </StepFrame>
  );
}
