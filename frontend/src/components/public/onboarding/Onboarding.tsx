"use client";

/**
 * JARVIS Public onboarding, "create your character" (docs/public-edition.md,
 * Onboarding). One question per screen, answered with taps and swipes, HOLO
 * reacting to every answer, and a progress bar building "your JARVIS".
 *
 * Renders inside the phone shell (`.ph`, every phone provider), on top of
 * the app's live background, which it steers: each screen picks a palette and
 * every answer ripples it through fxBus. The week step writes real schedule
 * entries and the must-do step real Lock-in marks; everything else is held
 * here until "Let's go", which saves the profile on the device, hands it to
 * the backend and calls `onFinish`.
 */
import * as React from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { CaretLeft } from "@phosphor-icons/react";

import { emitFx, fxScene, setFxScene, type FxScene } from "@/components/phone/fx/fxBus";
import { pushLayer, releaseLayer } from "@/components/phone/lib/backStack";
import { haptic } from "@/components/phone/lib/haptics";
import { Tap } from "@/components/phone/ui/Tap";
import { pushProfile, saveProfileLocal, type OnboardingProfile } from "@/lib/profile";
import {
  BootStep,
  EnemyStep,
  firstName,
  GoalsStep,
  InterestsStep,
  LanguageStep,
  NameStep,
  RhythmStep,
  StageStep,
  VibeStep,
  type StepProps,
} from "./AboutSteps";
import type { Mood } from "./content";
import { Bubble, Holo } from "./Holo";
import { LockinStep } from "./LockinStep";
import { NotifyStep } from "./NotifyStep";
import { RevealStep } from "./RevealStep";
import { buildProfile, clearDraft, EMPTY, loadDraft, saveDraft, STEPS, type Answers, type StepId } from "./state";
import { WeekStep } from "./WeekStep";
import type { AddedBlock } from "./weekPlan";
import "./onboarding.css";

const useClientLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** The live background's palette per screen. */
const SCENES: Record<StepId, FxScene> = {
  boot: "today",
  name: "today",
  vibe: "memory",
  stage: "memory",
  interests: "tasks",
  goals: "tasks",
  enemy: "tasks",
  rhythm: "plan",
  language: "plan",
  week: "plan",
  lockin: "tasks",
  notify: "today",
  reveal: "memory",
};

/** What HOLO says when a screen opens. */
function opener(step: StepId, answers: Answers): { mood: Mood; line: string } {
  const call = answers.callMe.trim() || firstName(answers.name) || "friend";
  switch (step) {
    case "boot":
      return { mood: "idle", line: "" };
    case "name":
      return { mood: "happy", line: "Let's start easy." };
    case "vibe":
      return { mood: "think", line: `Nice to meet you, ${call}. Now, how should I sound?` };
    case "stage":
      return { mood: "idle", line: "Tells me what your week looks like." };
    case "interests":
      return { mood: "excited", line: "The fun part. Go wild." };
    case "goals":
      return { mood: "fierce", line: "What actually matters this year?" };
    case "enemy":
      return { mood: "smirk", line: "Be honest. I won't judge. (Much.)" };
    case "rhythm":
      return { mood: "sleepy", line: "Drag the sliders. No lying about the 2 a.m. thing." };
    case "language":
      return { mood: "happy", line: "Pick the one that feels like home." };
    case "week":
      return { mood: "excited", line: "Add your regulars. Real entries, straight into your Plan." };
    case "lockin":
      return { mood: "fierce", line: "The ones you'd hate to miss. Be real." };
    case "notify":
      return { mood: "love", line: "I'll ping you like a friend, not a bank." };
    case "reveal":
      return { mood: "excited", line: `Okay ${call}. Look at you.` };
  }
}

const PANE: Variants = {
  enter: (direction: number) => ({ opacity: 0, transform: `translateX(${direction * 56}px) rotate(${direction * 2}deg) scale(0.98)` }),
  center: { opacity: 1, transform: "translateX(0px) rotate(0deg) scale(1)", transition: { type: "spring", stiffness: 360, damping: 32 } },
  exit: (direction: number) => ({
    opacity: 0,
    transform: `translateX(${direction * -56}px) rotate(${direction * -2}deg) scale(0.98)`,
    transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
  }),
};

export function Onboarding({ onFinish }: { onFinish: (profile: OnboardingProfile) => void }) {
  const [step, setStep] = React.useState<StepId>("boot");
  const [direction, setDirection] = React.useState<1 | -1>(1);
  const [answers, setAnswers] = React.useState<Answers>(EMPTY);
  const [blocks, setBlocks] = React.useState<AddedBlock[]>([]);
  const [mustDo, setMustDo] = React.useState<string[]>([]);
  const [marked, setMarked] = React.useState<string[]>([]);
  const [holo, setHolo] = React.useState<{ mood: Mood; line: string; kick: number }>({ mood: "idle", line: "", kick: 0 });
  const [hydrated, setHydrated] = React.useState(false);
  const [armed, setArmed] = React.useState(0);
  const holoRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const finished = React.useRef(false);
  const resumed = React.useRef(false);

  const flow = React.useMemo(() => STEPS.filter((id) => id !== "lockin" || blocks.length > 0), [blocks.length]);
  const index = Math.max(0, flow.indexOf(step));
  const latest = React.useRef({ flow, step, answers, mustDo });
  latest.current = { flow, step, answers, mustDo };

  // Pick up a half-finished onboarding where it was left.
  useClientLayoutEffect(() => {
    const draft = loadDraft();
    if (draft) {
      const step = draft.step === "lockin" && draft.blocks.length === 0 ? "week" : draft.step;
      resumed.current = step !== "boot";
      setStep(step);
      setAnswers(draft.answers);
      setBlocks(draft.blocks);
      setMustDo(draft.mustDo);
      setMarked(draft.marked);
    }
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (hydrated && !finished.current) saveDraft({ v: 1, step, answers, blocks, mustDo, marked });
  }, [hydrated, step, answers, blocks, mustDo, marked]);

  // Hand the background back the way it was found.
  React.useEffect(() => {
    const initial = fxScene();
    return () => setFxScene(initial);
  }, []);

  // A new screen: HOLO opens with its line, the background changes palette,
  // and focus moves to the question for screen readers and keyboards.
  React.useEffect(() => {
    // The first render's "boot" effect can run after the restore was
    // scheduled, so the welcome waits for the restored screen.
    const welcome = resumed.current && step !== "boot";
    if (welcome) resumed.current = false;
    const { mood, line } = welcome ? { mood: "happy" as Mood, line: "Welcome back! Picking up where we left off." } : opener(step, latest.current.answers);
    setHolo((current) => ({ mood, line, kick: current.kick + 1 }));
    setFxScene(SCENES[step]);
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(`.ob-pane[data-step="${step}"] [data-ob-title]`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  const go = React.useCallback((by: 1 | -1) => {
    const { flow, step } = latest.current;
    const target = flow[flow.indexOf(step) + by];
    if (!target) return;
    setDirection(by);
    setStep(target);
    emitFx("tab", undefined, by);
  }, []);
  const next = React.useCallback(() => go(1), [go]);
  const back = React.useCallback(() => go(-1), [go]);

  // Android's back button steps back through the questions.
  const canBack = index > 0;
  React.useEffect(() => {
    if (!canBack) return;
    let used = false;
    const id = pushLayer(() => {
      used = true;
      back();
      setArmed((count) => count + 1);
    });
    return () => {
      if (!used) releaseLayer(id);
    };
  }, [canBack, armed, back]);

  const patch = React.useCallback((change: Partial<Answers>) => setAnswers((current) => ({ ...current, ...change })), []);

  const react = React.useCallback((mood: Mood, line: string) => {
    setHolo((current) => ({ mood, line, kick: current.kick + 1 }));
    // HOLO answers with its own ripple, a beat after the tap's.
    window.setTimeout(() => emitFx("open", holoRef.current), 140);
  }, []);

  const finish = React.useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    const { answers, mustDo } = latest.current;
    const profile = buildProfile(answers, mustDo.length > 0);
    saveProfileLocal(profile);
    void pushProfile(profile);
    clearDraft();
    haptic("heavy");
    onFinish(profile);
  }, [onFinish]);

  const props: StepProps = { answers, patch, react, next };
  const screen = (() => {
    switch (step) {
      case "boot":
        return <BootStep next={next} />;
      case "name":
        return <NameStep {...props} />;
      case "vibe":
        return <VibeStep {...props} />;
      case "stage":
        return <StageStep {...props} />;
      case "interests":
        return <InterestsStep {...props} />;
      case "goals":
        return <GoalsStep {...props} />;
      case "enemy":
        return <EnemyStep {...props} />;
      case "rhythm":
        return <RhythmStep {...props} />;
      case "language":
        return <LanguageStep {...props} />;
      case "week":
        return <WeekStep answers={answers} blocks={blocks} onAdded={(block) => setBlocks((list) => [...list, block])} react={react} next={next} />;
      case "lockin":
        return <LockinStep blocks={blocks} mustDo={mustDo} setMustDo={setMustDo} marked={marked} setMarked={setMarked} onResolved={setBlocks} react={react} next={next} />;
      case "notify":
        return <NotifyStep answers={answers} blocks={blocks} react={react} next={next} />;
      case "reveal":
        return <RevealStep answers={answers} react={react} onGo={finish} />;
    }
  })();

  const percent = Math.round((index / (flow.length - 1)) * 100);

  return (
    <div ref={rootRef} className="ob" data-step={step}>
      <span className="ob-scrim" aria-hidden="true" />
      {step !== "boot" && (
        <header className="ob-head">
          <div className="ob-top">
            <Tap className="ob-back" aria-label="Back" feel="tap" squish={0.85} onClick={back}>
              <CaretLeft size={20} weight="bold" />
            </Tap>
            <Progress percent={percent} done={step === "reveal"} />
          </div>
          <div ref={holoRef} className="ob-holo-row">
            <Holo mood={holo.mood} kick={holo.kick} size={72} />
            <Bubble line={holo.line} />
          </div>
        </header>
      )}
      <main className="ob-stage">
        <AnimatePresence initial={false} custom={direction}>
          <motion.section
            key={step}
            className="ob-pane"
            data-step={step}
            custom={direction}
            variants={PANE}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {screen}
          </motion.section>
        </AnimatePresence>
      </main>
    </div>
  );
}

function Progress({ percent, done }: { percent: number; done: boolean }) {
  return (
    <div className="ob-progress" role="progressbar" aria-label="Building your JARVIS" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="ob-progress-label">
        {done ? "Your JARVIS is ready" : "Building your JARVIS…"} <b key={percent} className="ob-pct">{percent}%</b>
      </span>
      <span className="ob-progress-track">
        <span className="ob-progress-fill" style={{ transform: `scaleX(${Math.max(0.04, percent / 100)})` }} />
      </span>
    </div>
  );
}
