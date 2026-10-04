"use client";

/**
 * "Your week", as four calm screens (2026-10-04, after the owner saw people
 * not understanding what to type, and "lots of disturbance" on one busy
 * screen):
 * 1. **When's college?** Only for school, college or work.
 * 2. **What do you want to do every week?** One input, a plain list.
 * 3. **How much does each one matter?** A meter per item (priority, not a
 *    formula: the planner keeps a bath a bath and puts skin care after waking
 *    and before sleep).
 * 4. **Free time, or strict?** Then "Build my timetable".
 *
 * Then the review draws the plan: a donut of how the week splits, and one
 * ring per day. College never shows there; only their own time does.
 */
import * as React from "react";
import { Backpack, Briefcase, ChatCircleText, Coffee, GraduationCap, Lightning, LockSimple, Minus, Plus, Target, X } from "@phosphor-icons/react";

import { usePublicOptional } from "@/components/public/PublicContext";
import { emitFx } from "@/components/phone/fx/fxBus";
import { haptic } from "@/components/phone/lib/haptics";
import { useAppData } from "@/components/phone/PhoneContext";
import { TimeInput } from "@/components/phone/ui/Form";
import { Tap } from "@/components/phone/ui/Tap";
import type { Mood } from "./content";
import { Holo } from "./Holo";
import {
  activityTotals,
  busyOf,
  clampPoints,
  DEFAULT_POINTS,
  examples,
  FREE_TIME,
  freeTotals,
  groupKey,
  hoursLabel,
  hoursOf,
  MAX_ACTIVITIES,
  MAX_TWEAKS,
  planGroups,
  PlanError,
  planWeek,
  pointsMeaning,
  previousOf,
  shortName,
  toneFor,
  type PlanWeekRequest,
  type PlanWeekResponse,
  type WeekState,
} from "./planWeek";
import { PointsMeter } from "./PointsMeter";
import { examName, type Answers } from "./state";
import { Cta, DayToggles, OptionCard, Quiet, StepFrame } from "./ui";
import { DayDials, hoursText, WeekDonut, type DayDial, type Slice } from "./WeekCharts";
import { clock12, createBlock, DAY_LETTERS, DAY_NAMES, friendlySaveError, minutesOf, newId, type AddedBlock } from "./weekPlan";

type SetWeek = (update: (week: WeekState) => WeekState) => void;

const EYEBROW = "09 · Your week";

const COOK_LINES = [
  "Finding your golden hours…",
  "Negotiating with your sleep schedule…",
  "Spacing out the hard stuff…",
  "Balancing grind and chill…",
  "Double-checking the math…",
];

const TWEAK_LINES = ["Reading your notes…", "Moving things around…", "Rebalancing the week…", "Almost there…"];

/** What the planner is asked: their answers so far, the week's wishes, and any tweak. */
export function requestFor(answers: Answers, week: WeekState, tweak?: Pick<PlanWeekRequest, "previous" | "feedback" | "comment">): PlanWeekRequest {
  return {
    wake: answers.wake,
    sleep: answers.sleep,
    chronotype: answers.chronotype ?? undefined,
    stage: answers.stage ?? undefined,
    exam: examName(answers),
    goals: answers.goals,
    interests: answers.interests,
    busy: busyOf(week, answers.stage),
    freeTime: week.freeTime ?? false,
    activities: week.activities.map((activity) => ({ name: activity.name, points: clampPoints(activity.points) })),
    ...(tweak ?? {}),
  };
}

/** One planner call at a time, cancelled when the screen goes away. */
function useCook() {
  const pub = usePublicOptional();
  const token = pub?.session?.accessToken ?? null;
  const [cooking, setCooking] = React.useState(false);
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  const cook = React.useCallback(
    async (request: PlanWeekRequest): Promise<{ plan?: PlanWeekResponse; error?: PlanError }> => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        current.abort();
      }, 60_000);
      setCooking(true);
      try {
        return { plan: await planWeek(request, token, current.signal) };
      } catch (problem) {
        if (timedOut) return { error: new PlanError("That took too long. Try again, or set it up yourself.", 0, "timeout", true) };
        return { error: problem instanceof PlanError ? problem : new PlanError("Something went sideways. Try again?", 0, "unknown", true) };
      } finally {
        window.clearTimeout(timer);
        if (controller.current === current) {
          controller.current = null;
          setCooking(false);
        }
      }
    },
    [token],
  );
  return { cooking, cook };
}

/** HOLO thinking hard, with lines that keep changing. */
function Cooking({ title, lines }: { title: string; lines: string[] }) {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % lines.length), 1700);
    return () => window.clearInterval(timer);
  }, [lines.length]);
  return (
    <div className="ob-cook" role="status" aria-live="polite">
      <Holo mood="think" kick={index} size={132} />
      <strong className="ob-cook-title">{title}</strong>
      <span key={index} className="ob-cook-line">{lines[index]}</span>
      <span className="ob-cook-bar" aria-hidden="true"><i /></span>
    </div>
  );
}

function PlanErrorCard({ error, onManual }: { error: PlanError; onManual: () => void }) {
  return (
    <div className="ob-plan-error ob-rise" role="alert">
      <p>{error.message}</p>
      {error.fallback && (
        <Tap className="ob-plan-error-btn" feel="tap" squish={0.95} onClick={onManual}>
          I&apos;ll set it up myself
        </Tap>
      )}
    </div>
  );
}

/** "5:30–6:30 PM", or "11:30 AM–1 PM" across noon. */
function range12(start: string, end: string): string {
  const from = clock12(start);
  const to = clock12(end);
  const suffix = (text: string) => text.slice(-2);
  return suffix(from) === suffix(to) ? `${from.slice(0, -3)}–${to}` : `${from}–${to}`;
}

/* ------------------------------------------------- 1. when's college? */

export function HoursStep({ answers, week, setWeek, next }: { answers: Answers; week: WeekState; setWeek: SetWeek; next: () => void }) {
  const stage = answers.stage;
  const label = hoursLabel(stage);
  const hours = hoursOf(week, stage);
  const Icon = stage === "working" ? Briefcase : stage === "school" ? Backpack : GraduationCap;
  const setHours = (change: Partial<NonNullable<WeekState["hours"]>>) =>
    setWeek((current) => ({ ...current, hours: { ...hoursOf(current, stage), ...change } }));
  const ready = hours.off || (hours.days.length > 0 && minutesOf(hours.end) > minutesOf(hours.start));
  return (
    <StepFrame
      eyebrow={EYEBROW}
      title={`When's ${label.toLocaleLowerCase()}?`}
      sub="JARVIS plans only the time around it."
      footer={<Cta disabled={!ready} onClick={next}>Next</Cta>}
    >
      <div className="ob-hours-card" data-off={hours.off || undefined}>
        <span className="ob-hours-badge" aria-hidden="true"><Icon size={22} weight="fill" /></span>
        {hours.off ? (
          <p className="ob-hours-none">No fixed {label.toLocaleLowerCase()} hours. Your whole day is yours to plan.</p>
        ) : (
          <>
            <span className="ob-label">Days</span>
            <DayToggles value={hours.days} tone="sky" onChange={(days) => setHours({ days })} />
            <div className="ob-times">
              <div>
                <span className="ob-label">From</span>
                <TimeInput label={`${label} starts`} value={hours.start} onChange={(start) => setHours({ start })} />
              </div>
              <div>
                <span className="ob-label">To</span>
                <TimeInput label={`${label} ends`} value={hours.end} onChange={(end) => setHours({ end })} />
              </div>
            </div>
          </>
        )}
      </div>
      <Quiet onClick={() => setHours({ off: !hours.off })}>
        {hours.off ? `I do have ${label.toLocaleLowerCase()} hours` : `I don't have fixed ${label.toLocaleLowerCase()} hours`}
      </Quiet>
    </StepFrame>
  );
}

/* ------------------------------------- 2. what do you want to do weekly? */

export function PlanAskStep({ answers, week, setWeek, react, next, onManual, onKeep }: {
  answers: Answers;
  week: WeekState;
  setWeek: SetWeek;
  react: (mood: Mood, line: string) => void;
  next: () => void;
  onManual: () => void;
  /** Skip building a week (a redone setup that already has one). */
  onKeep?: () => void;
}) {
  const { app } = useAppData();
  const schedule = app.state?.schedule;
  const hasWeek = Boolean(schedule && schedule.college.length + schedule.routine.length + schedule.session.length > 0);
  const items = week.activities;
  const [draft, setDraft] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  const ideas = React.useMemo(() => examples(answers.goals, answers.interests).map(shortName), [answers.goals, answers.interests]);
  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

  const add = () => {
    const name = draft.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) return;
    setDraft("");
    input.current?.focus();
    // Quiet on purpose: HOLO only speaks up when something needs fixing.
    if (same(name, FREE_TIME)) {
      react("smirk", "Free time gets its own question in a moment.");
      return;
    }
    if (items.some((item) => same(item.name, name))) {
      react("think", `${name}'s already on the list.`);
      return;
    }
    if (items.length >= MAX_ACTIVITIES) {
      haptic("warning");
      react("oops", `${MAX_ACTIVITIES} things is a full week. Drop one first.`);
      return;
    }
    haptic("toggle-on");
    setWeek((current) => ({ ...current, activities: [...current.activities, { name, points: DEFAULT_POINTS }] }));
  };

  const remove = (name: string) => setWeek((current) => ({ ...current, activities: current.activities.filter((item) => !same(item.name, name)) }));

  if (week.saved) {
    return (
      <StepFrame eyebrow={EYEBROW} title="Your week's locked in." sub="It's already in your Plan. Change anything there, anytime." footer={<Cta onClick={next}>See it</Cta>}>
        <span />
      </StepFrame>
    );
  }

  const [a, b, c] = ideas.length >= 3 ? ideas : ["Gym", "DSA", "Guitar"];
  return (
    <StepFrame
      eyebrow={EYEBROW}
      title="What do you want to do every week?"
      sub={
        <>
          Type one thing at a time, like <b>{a}</b>, <b>{b}</b> or <b>{c}</b>. JARVIS fits them into your free time.
        </>
      }
      footer={
        <>
          <Cta disabled={items.length === 0} arrow={items.length > 0} onClick={next}>
            {items.length === 0 ? "Add at least one" : "Next"}
          </Cta>
          {hasWeek && onKeep ? (
            <Quiet onClick={onKeep}>Keep my current week</Quiet>
          ) : (
            <Quiet onClick={onManual}>I&apos;ll set it up myself</Quiet>
          )}
        </>
      }
    >
      <form
        className="ob-adder"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          ref={input}
          className="ob-input ob-add-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 40))}
          placeholder="Type one thing…"
          aria-label="Something you want or need to do every week"
          maxLength={40}
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
        <Tap type="submit" className="ob-add-go" feel={false} squish={0.9} disabled={!draft.trim()} aria-label="Add">
          <Plus size={20} weight="bold" aria-hidden="true" />
        </Tap>
      </form>

      {items.length > 0 && (
        <ul className="ob-list" aria-label="Your list">
          {items.map((item, index) => (
            <li key={item.name} className="ob-list-row" data-tone={toneFor(item.name, items)} style={{ "--i": index } as React.CSSProperties}>
              <span className="ob-list-dot" aria-hidden="true" />
              <strong>{item.name}</strong>
              <Tap className="ob-list-x" aria-label={`Remove ${item.name}`} feel="toggle-off" squish={0.85} onClick={() => remove(item.name)}>
                <X size={14} weight="bold" />
              </Tap>
            </li>
          ))}
        </ul>
      )}
    </StepFrame>
  );
}

/* ------------------------------------------- 3. how much of your week? */

export function WeightStep({ week, setWeek, next }: { week: WeekState; setWeek: SetWeek; next: () => void }) {
  const items = week.activities;
  const setPoints = (name: string, points: number) =>
    setWeek((current) => ({ ...current, activities: current.activities.map((item) => (item.name === name ? { ...item, points } : item)) }));
  return (
    <StepFrame
      eyebrow={EYEBROW}
      title="How much does each one matter?"
      sub="Drag it. JARVIS works out how often and how long, the real-life way."
      footer={<Cta disabled={items.length === 0} onClick={next}>Next</Cta>}
    >
      <ul className="ob-weights">
        {items.map((item, index) => {
          const tone = toneFor(item.name, items);
          const points = clampPoints(item.points);
          return (
            <li key={item.name} className="ob-weight" data-tone={tone} data-max={points >= 11 || undefined} style={{ "--i": index } as React.CSSProperties}>
              <div className="ob-weight-head">
                <strong>{item.name}</strong>
                <span key={pointsMeaning(points)} className="ob-weight-mean">{pointsMeaning(points)}</span>
              </div>
              <PointsMeter value={points} label={item.name} tone={tone} onChange={(value) => setPoints(item.name, value)} />
            </li>
          );
        })}
      </ul>
    </StepFrame>
  );
}

/* ------------------------------------------- 4. free time, or strict? */

export function FreeTimeStep({ answers, week, setWeek, react, next, onManual }: {
  answers: Answers;
  week: WeekState;
  setWeek: SetWeek;
  react: (mood: Mood, line: string) => void;
  next: () => void;
  onManual: () => void;
}) {
  const [error, setError] = React.useState<PlanError | null>(null);
  const { cooking, cook } = useCook();
  const choose = (freeTime: boolean) => setWeek((current) => ({ ...current, freeTime }));

  const build = async () => {
    if (cooking || week.freeTime === null || week.activities.length === 0) return;
    setError(null);
    react("think", "Building it. Give me a few seconds.");
    const result = await cook(requestFor(answers, week));
    if (result.plan) {
      const plan = result.plan;
      setWeek((current) => ({ ...current, plan, tweaks: 0 }));
      haptic("success");
      next();
      return;
    }
    if (result.error && result.error.code !== "aborted") {
      setError(result.error);
      haptic("warning");
      react("oops", result.error.message);
    }
  };

  return (
    <div className="ob-step">
      <StepFrame
        eyebrow={EYEBROW}
        title="Free time in your week?"
        sub="Gaps that are just yours, or every hour planned."
        footer={
          <Cta disabled={week.freeTime === null} busy={cooking} arrow={week.freeTime !== null} onClick={() => void build()}>
            {cooking ? "Building…" : "Build my timetable"}
          </Cta>
        }
      >
        <div className="ob-duo ob-duo-tall" role="radiogroup" aria-label="Free time in your week">
          <OptionCard
            on={week.freeTime === true}
            tone="mint"
            emoji={<Coffee size={30} weight="duotone" />}
            title="Yes, leave me free time"
            line="Breathing room between things"
            onClick={() => choose(true)}
          />
          <OptionCard
            on={week.freeTime === false}
            tone="red"
            emoji={<Target size={30} weight="duotone" />}
            title="No, keep it strict"
            line="Every hour has a job"
            index={1}
            onClick={() => choose(false)}
          />
        </div>
        {error && <PlanErrorCard error={error} onManual={onManual} />}
      </StepFrame>
      {cooking && <Cooking title="Building your week…" lines={COOK_LINES} />}
    </div>
  );
}

/* ---------------------------------------------------------- the review */

export function PlanReviewStep({ answers, week, setWeek, blocks, onAdded, react, next, onManual }: {
  answers: Answers;
  week: WeekState;
  setWeek: SetWeek;
  blocks: AddedBlock[];
  onAdded: (block: AddedBlock) => void;
  react: (mood: Mood, line: string) => void;
  next: () => void;
  onManual: () => void;
}) {
  const { app, mode } = useAppData();
  const plan = week.plan;
  const busy = busyOf(week, answers.stage);
  const today = (new Date().getDay() + 6) % 7;
  const [day, setDay] = React.useState(today);
  const [feedback, setFeedback] = React.useState<Record<string, "less" | "more">>({});
  const [comment, setComment] = React.useState("");
  const [talking, setTalking] = React.useState(false);
  const [error, setError] = React.useState<PlanError | null>(null);
  const [saving, setSaving] = React.useState<{ done: number; total: number } | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const chart = React.useRef<HTMLDivElement>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    // Set here too: a development remount (StrictMode) runs the cleanup once.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { cooking, cook } = useCook();

  if (!plan) {
    return (
      <StepFrame eyebrow={EYEBROW} title="No plan yet." sub="Go back and tell me what goes in your week." footer={<Cta onClick={onManual}>Set it up myself</Cta>}>
        <span />
      </StepFrame>
    );
  }

  const activities = week.activities;
  const totals = activityTotals(plan);
  const free = freeTotals(plan);
  const tweaksLeft = MAX_TWEAKS - week.tweaks;
  const changes = Object.keys(feedback).length > 0 || comment.trim().length > 0;
  const locked = week.saved;

  // The waking day, which each day's ring goes round.
  const wake = minutesOf(answers.wake || "07:00");
  let sleep = minutesOf(answers.sleep || "23:00");
  if (sleep <= wake) sleep = 24 * 60;
  const span = Math.max(60, sleep - wake);
  const at = (clock: string) => Math.min(1, Math.max(0, (minutesOf(clock) - wake) / span));

  const minutesOfBlock = (start: string, end: string) => {
    const length = minutesOf(end) - minutesOf(start);
    return length <= 0 ? length + 1440 : length;
  };
  const freeMinutes = plan.blocks.filter((block) => block.free).reduce((sum, block) => sum + minutesOfBlock(block.start, block.end), 0);
  const slices: Slice[] = [
    ...totals.map((total) => ({
      key: total.activity,
      minutes: plan.blocks.filter((block) => !block.free && block.activity === total.activity).reduce((sum, block) => sum + minutesOfBlock(block.start, block.end), 0),
      tone: toneFor(total.activity, activities),
    })),
    ...(free.blocks > 0 ? [{ key: FREE_TIME, minutes: freeMinutes, tone: "mint" as const, free: true }] : []),
  ].filter((slice) => slice.minutes > 0);

  const dials: DayDial[] = DAY_LETTERS.map((letter, index) => ({
    index,
    letter,
    label: `${DAY_NAMES[index]}: ${plan.blocks.filter((block) => block.day === index && !block.free).length} things`,
    segments: plan.blocks
      .filter((block) => block.day === index)
      .sort((x, y) => minutesOf(x.start) - minutesOf(y.start))
      .map((block, order) => ({
        key: `${block.activity}-${block.start}-${order}`,
        from: at(block.start),
        to: Math.max(at(block.start) + 0.012, at(block.end)),
        tone: toneFor(block.activity, activities),
        free: block.free,
      })),
  }));
  const slots = plan.blocks.filter((block) => block.day === day).sort((x, y) => minutesOf(x.start) - minutesOf(y.start));

  const nudge = (activity: string, change: "less" | "more") => {
    setFeedback((current) => {
      const nextFeedback = { ...current };
      if (nextFeedback[activity] === change) delete nextFeedback[activity];
      else nextFeedback[activity] = change;
      return nextFeedback;
    });
  };

  const tweak = async () => {
    if (cooking || !changes || tweaksLeft <= 0) return;
    setError(null);
    react("think", "Remixing your week…");
    const result = await cook(
      requestFor(answers, week, {
        previous: previousOf(plan),
        feedback: Object.entries(feedback).map(([activity, change]) => ({ activity, change })),
        comment: comment.trim().slice(0, 300) || null,
      }),
    );
    if (result.plan) {
      const fresh = result.plan;
      setWeek((current) => ({ ...current, plan: fresh, tweaks: current.tweaks + 1 }));
      setFeedback({});
      setComment("");
      setTalking(false);
      haptic("success");
      emitFx("success", chart.current);
      react("excited", fresh.summary ? `Remixed. ${fresh.summary}`.slice(0, 160) : "Remixed. Better?");
      return;
    }
    if (result.error && result.error.code !== "aborted") {
      setError(result.error);
      haptic("warning");
      react("oops", result.error.message);
    }
  };

  // Save what is not saved yet, entry by entry, so a retry never doubles up.
  // Fixed hours are saved too (they're their real week); they just aren't drawn here.
  const save = async () => {
    if (saving || cooking) return;
    setSaveError(null);
    const groups = planGroups(plan, busy, answers.stage, activities);
    const todo = groups
      .map((group) => {
        const done = blocks.filter((block) => groupKey(block) === groupKey(group)).flatMap((block) => block.days);
        return { ...group, days: group.days.filter((dayIndex) => !done.includes(dayIndex)) };
      })
      .filter((group) => group.days.length > 0);
    setSaving({ done: 0, total: todo.length });
    let problem: string | null = null;
    for (const [index, spec] of todo.entries()) {
      const result = await createBlock(mode, spec);
      if (result.records.length) {
        const created = new Set(result.records.map((record) => record.day));
        onAdded({ ...spec, days: spec.days.filter((dayIndex) => created.has(dayIndex)), id: newId(), records: result.records });
      }
      if (result.error) {
        problem = friendlySaveError(result.error);
        break;
      }
      setSaving({ done: index + 1, total: todo.length });
    }
    app.handleRecordChanged();
    setSaving(null);
    if (problem) {
      setSaveError(`${problem} Tap Lock it in to finish the rest.`);
      haptic("warning");
      react("oops", "Some of it didn't save. One more tap?");
      return;
    }
    setWeek((current) => ({ ...current, saved: true }));
    haptic("heavy");
    react("fierce", "Locked into your Plan. Now we make it real.");
    if (alive.current) next();
  };

  return (
    <div className="ob-step">
      <StepFrame
        eyebrow={EYEBROW}
        title="Here's your week."
        sub={locked ? "It's in your Plan. Change anything there, anytime." : "Too much or too little of something? Tap − or +."}
        footer={
          locked ? (
            <Cta onClick={next}>Next</Cta>
          ) : (
            <>
              {changes && (
                <Tap className="ob-tweak" feel="heavy" squish={0.95} disabled={tweaksLeft <= 0 || cooking} onClick={() => void tweak()}>
                  <Lightning size={18} weight="fill" aria-hidden="true" />
                  {tweaksLeft <= 0 ? "No tweaks left. Edit it later in Plan." : `Rebuild with my changes · ${tweaksLeft} left`}
                </Tap>
              )}
              <Cta variant="lock" icon={<LockSimple size={19} weight="fill" />} busy={Boolean(saving)} disabled={cooking} onClick={() => void save()}>
                {saving ? `Saving… ${saving.done}/${saving.total}` : "Lock it in"}
              </Cta>
            </>
          )
        }
      >
        <section ref={chart} className="ob-split" aria-label="How your week splits">
          <WeekDonut key={`donut-${week.tweaks}`} slices={slices} />
          <ul className="ob-legend">
            {totals.map((total) => {
              const said = feedback[total.activity];
              return (
                <li key={total.activity} data-tone={toneFor(total.activity, activities)} data-said={said}>
                  <span className="ob-legend-dot" aria-hidden="true" />
                  <span className="ob-legend-text">
                    <strong>{total.activity}</strong>
                    <small>
                      {total.timesPerWeek}× · {hoursText(total.minutesPerSession)}
                      {said && <em> · {said === "less" ? "less" : "more"}</em>}
                    </small>
                  </span>
                  {!locked && (
                    <span className="ob-legend-btns">
                      <Tap className="ob-legend-btn" aria-label={`Less ${total.activity}`} aria-pressed={said === "less"} data-on={said === "less" || undefined} feel="select" squish={0.85} disabled={cooking} onClick={() => nudge(total.activity, "less")}>
                        <Minus size={15} weight="bold" />
                      </Tap>
                      <Tap className="ob-legend-btn" aria-label={`More ${total.activity}`} aria-pressed={said === "more"} data-on={said === "more" || undefined} feel="select" squish={0.85} disabled={cooking} onClick={() => nudge(total.activity, "more")}>
                        <Plus size={15} weight="bold" />
                      </Tap>
                    </span>
                  )}
                </li>
              );
            })}
            {free.blocks > 0 && (
              <li data-free>
                <span className="ob-legend-dot" aria-hidden="true" />
                <span className="ob-legend-text">
                  <strong>{FREE_TIME}</strong>
                  <small>{hoursText(freeMinutes)} a week, just yours</small>
                </span>
              </li>
            )}
          </ul>
        </section>

        <section className="ob-days-view" aria-label="Day by day">
          <DayDials
            key={`dials-${week.tweaks}`}
            days={dials}
            selected={day}
            today={today}
            onSelect={(index) => {
              haptic("select");
              setDay(index);
            }}
          />
          <div className="ob-daylist" role="tabpanel" aria-label={DAY_NAMES[day]}>
            <h3 className="ob-daylist-name">{DAY_NAMES[day]}</h3>
            {slots.length === 0 ? (
              <p className="ob-hint">Nothing planned. A rest day.</p>
            ) : (
              <ul>
                {slots.map((slot) => (
                  <li key={`${slot.activity}-${slot.start}`} data-tone={slot.free ? undefined : toneFor(slot.activity, activities)} data-free={slot.free || undefined}>
                    <time>{range12(slot.start, slot.end)}</time>
                    <span className="ob-daylist-dot" aria-hidden="true" />
                    <strong>{slot.free ? FREE_TIME : slot.activity}</strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {!locked &&
          (talking ? (
            <section className="ob-section ob-tweak-box">
              <textarea
                className="ob-input ob-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value.slice(0, 300))}
                placeholder="e.g. no gym on Sundays, DSA in the mornings"
                aria-label="What should change"
                maxLength={300}
                rows={2}
                autoFocus
              />
            </section>
          ) : (
            <Quiet onClick={() => setTalking(true)}>
              <ChatCircleText size={16} weight="bold" aria-hidden="true" /> Something else off? Tell JARVIS
            </Quiet>
          ))}
        {error && <PlanErrorCard error={error} onManual={onManual} />}
        {saveError && <p className="ob-error" role="alert">{saveError}</p>}
      </StepFrame>
      {cooking && <Cooking title="Rebuilding your week…" lines={TWEAK_LINES} />}
    </div>
  );
}
