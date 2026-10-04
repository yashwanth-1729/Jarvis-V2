"use client";

/**
 * "Fit it back in": what slipped this week, and JARVIS's catch-up plan for it.
 * The plan comes from GPT-6 Luna, checked by the backend, or from the plain
 * placer when the model can't be reached. Untick what you don't want, then
 * lock the rest in: each becomes a serious block with Start, and anything not
 * kept is let go.
 */
import * as React from "react";
import { ArrowsClockwise, Check, LockSimple, Sparkle, Wind } from "@phosphor-icons/react";
import { toast } from "sonner";

import { proposeCatchUp, resetFocus, type CatchUpPlan } from "@/lib/focus";
import { emitFx } from "../fx/fxBus";
import { haptic } from "../lib/haptics";
import { useAppData, useNow } from "../PhoneContext";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";
import { applyCatchUp, busyFor, dayName, letGo, missedLabel, spoken } from "./catchUp";
import { emberBurst } from "./embers";
import { useSerious } from "./SeriousContext";

type Phase = "loading" | "ready" | "error" | "saving";

const LOADING_LINES = ["Bending your week…", "Finding time that actually works…", "Moving things, not breaking them…"];

export function CatchUpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { app, mode } = useAppData();
  const serious = useSerious();
  const now = useNow(60_000);
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [plan, setPlan] = React.useState<CatchUpPlan | null>(null);
  const [keep, setKeep] = React.useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = React.useState("");
  const [line, setLine] = React.useState(0);
  // Read at the moment of asking, so a refresh while open doesn't re-plan.
  const schedule = React.useRef(app.state?.schedule);
  schedule.current = app.state?.schedule;

  const load = React.useCallback(async () => {
    setPhase("loading");
    setProblem("");
    try {
      const next = await proposeCatchUp(busyFor(schedule.current, new Date()));
      setPlan(next);
      setKeep(new Set(next.sessions.map((_, index) => index)));
      setPhase("ready");
      haptic(next.sessions.length ? "success" : "select");
    } catch {
      setProblem("Couldn't reach JARVIS to plan this. Check the assistant is running, then try again.");
      setPhase("error");
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  React.useEffect(() => {
    if (!open || phase !== "loading") return;
    const timer = window.setInterval(() => setLine((value) => (value + 1) % LOADING_LINES.length), 1800);
    return () => window.clearInterval(timer);
  }, [open, phase]);

  const toggle = (index: number) => {
    setKeep((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const lockIn = async (origin: HTMLElement) => {
    if (!plan) return;
    setPhase("saving");
    try {
      const result = await applyCatchUp(mode, plan, keep);
      app.handleRecordChanged();
      serious?.reload();
      if (result.saved) {
        emitFx("forge", origin);
        emberBurst(origin, "forge");
        haptic("success");
        toast.success("Week bent, not broken.", {
          description: `${result.saved} catch-up${result.saved === 1 ? "" : "s"} locked in.${result.failed ? ` ${result.failed} didn't save; it's still on the list.` : ""}`,
        });
      } else {
        toast("Let go. Clean slate.", { description: result.failed ? "The catch-ups didn't save. Try again in a moment." : undefined });
      }
      onClose();
    } catch {
      haptic("warning");
      toast.error("Couldn't lock those in", { description: "Try again in a moment." });
      setPhase("ready");
    }
  };

  const release = async () => {
    const missed = plan?.missed ?? serious?.missed ?? [];
    if (!missed.length) {
      onClose();
      return;
    }
    try {
      await letGo(missed);
      serious?.reload();
      haptic("select");
      toast("Let go. Clean slate.", {
        description: "The stats still count it. Next one's yours.",
        action: {
          label: "Undo",
          onClick: () => {
            void Promise.all(missed.map((miss) => resetFocus(miss.uid, miss.occurrence))).then(() => serious?.reload());
          },
        },
      });
      onClose();
    } catch {
      toast.error("Couldn't do that", { description: "Try again in a moment." });
    }
  };

  const missedFor = (uid: string, occurrence: string) => plan?.missed.find((miss) => miss.uid === uid && miss.occurrence === occurrence);
  const sessions = plan?.sessions ?? [];
  const left = plan?.left ?? [];
  const nothing = phase === "ready" && plan !== null && plan.missed.length === 0;

  const footer =
    phase === "ready" || phase === "saving" ? (
      nothing ? (
        <Tap className="ph-btn ph-btn-wide" onClick={onClose}>Nice</Tap>
      ) : sessions.length ? (
        <div className="ph-cu-actions">
          <Tap
            className="ph-btn ph-btn-ember ph-btn-wide"
            disabled={phase === "saving"}
            onClick={(event) => void lockIn(event.currentTarget)}
            feel="heavy"
            squish={0.96}
          >
            <LockSimple size={18} weight="fill" />
            {keep.size === 0 ? "Let them go" : keep.size === 1 ? "Lock it in" : `Lock ${keep.size} in`}
          </Tap>
          <Tap className="ph-cu-letgo" disabled={phase === "saving"} onClick={() => void release()} feel="select">
            Let it all go
          </Tap>
        </div>
      ) : (
        <Tap className="ph-btn ph-btn-wide" onClick={() => void release()}>
          <Wind size={18} weight="bold" /> Let it go · clean slate
        </Tap>
      )
    ) : phase === "error" ? (
      <Tap className="ph-btn ph-btn-wide" onClick={() => void load()}>
        <ArrowsClockwise size={18} weight="bold" /> Try again
      </Tap>
    ) : null;

  return (
    <Sheet open={open} onClose={onClose} title="Fit it back in" eyebrow="PLANS BEND · THEY DON'T BREAK" tone="ember" footer={footer}>
      <div className="ph-cu" data-phase={phase}>
        {phase === "loading" && (
          <div className="ph-cu-loading" role="status">
            <span className="ph-cu-orb" aria-hidden="true">
              <LockSimple size={28} weight="fill" />
            </span>
            <strong key={line} className="ph-cu-loading-line">{LOADING_LINES[line]}</strong>
            <span>JARVIS is looking at the rest of your week.</span>
          </div>
        )}

        {phase === "error" && <p className="ph-cu-problem">{problem}</p>}

        {(phase === "ready" || phase === "saving") && plan && (
          <>
            <p className="ph-cu-say">
              <Sparkle size={16} weight="fill" aria-hidden="true" />
              <span>{nothing ? "Nothing slipped. Clean week so far. 🔥" : plan.message}</span>
            </p>

            {sessions.length > 0 && (
              <>
                <h3 className="ph-cu-head">Catch-ups</h3>
                <ul className="ph-cu-list">
                  {sessions.map((session, index) => {
                    const on = keep.has(index);
                    const missed = session.covers ? missedFor(session.covers.uid, session.covers.occurrence) : undefined;
                    return (
                      <li key={`${session.title}-${session.date}-${session.start}`}>
                        <Tap
                          className="ph-cu-row"
                          data-on={on}
                          aria-pressed={on}
                          onClick={() => toggle(index)}
                          feel={on ? "toggle-off" : "toggle-on"}
                          squish={0.97}
                        >
                          <span className="ph-cu-check" aria-hidden="true">{on && <Check size={14} weight="bold" />}</span>
                          <span className="ph-cu-main">
                            <strong>{session.title}</strong>
                            <span>
                              {spoken(session.start)} – {spoken(session.end)} · {session.minutes} min
                            </span>
                            {missed && <em>for {missedLabel(missed)}</em>}
                          </span>
                          <span className="ph-cu-day">{dayName(session.date, now)}</span>
                        </Tap>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {left.length > 0 && (
              <>
                <h3 className="ph-cu-head">Didn&apos;t fit · letting go</h3>
                <ul className="ph-cu-left">
                  {left.map((miss) => (
                    <li key={`${miss.uid}-${miss.occurrence}`}>
                      <Wind size={14} weight="bold" aria-hidden="true" /> {missedLabel(miss)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
