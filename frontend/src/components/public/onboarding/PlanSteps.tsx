"use client";

import * as React from "react";
import { Backpack, Briefcase, Coffee, GraduationCap, Lightning, LockSimple, Minus, Plus, Target, X } from "@phosphor-icons/react";

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
  emojiFor,
  examples,
  FREE_TIME,
  freeTotals,
  groupKey,
  hoursLabel,
  hoursOf,
  MAX_ACTIVITIES,
  MAX_TWEAKS,
  needsHours,
  phaseOf,
  planGroups,
  PlanError,
  planWeek,
  POINTS_MAX,
  previousOf,
  toneFor,
  type Phase,
  type PlannedBlock,
  type PlanWeekRequest,
  type PlanWeekResponse,
  type WeekState,
} from "./planWeek";
import { PointsMeter } from "./PointsMeter";
import { examName, type Answers } from "./state";
import { Cta, DayToggles, OptionCard, Quiet, StepFrame } from "./ui";
import { clock12, createBlock, DAY_LETTERS, DAY_NAMES, daysLabel, friendlySaveError, minutesOf, newId, weekBars, type AddedBlock } from "./weekPlan";

type SetWeek = (update: (week: WeekState) => WeekState) => void;

const COOK_LINES = [
  "Finding your golden hours…",
  "Negotiating with your sleep schedule…",
  "Spacing out the hard stuff…",
  "Balancing grind and chill…",
  "Moving reels to never o'clock…",
  "Double-checking the math…",
];

const TWEAK_LINES = ["Reading your notes…", "Moving things around…", "Rebalancing the week…", "Almost there…"];

const PHASE_LABEL: Record<Phase, string> = { morning: "🌅 Morning", afternoon: "☀️ Afternoon", evening: "🌆 Evening", night: "🌙 Night" };
const PHASES: Phase[] = ["morning", "afternoon", "evening", "night"];

/** What HOLO says when a meter settles. */
function pointsLine(name: string, points: number): { mood: Mood; line: string } {
  if (points >= POINTS_MAX) return { mood: "fierce", line: `${name} at MAX. Everything else bends around it.` };
  if (points >= 8) return { mood: "excited", line: `${name}: a big chunk of your week.` };
  if (points >= 5) return { mood: "happy", line: `${name}: a solid slice.` };
  if (points >= 3) return { mood: "smirk", line: `${name}: a little, regularly.` };
  return { mood: "calm", line: `${name}: just a sprinkle.` };
}

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

/** College/school/work hours as one line; Edit opens the days and times. */
function HoursLine({ stage, week, setWeek, react }: { stage: Answers["stage"]; week: WeekState; setWeek: SetWeek; react: (mood: Mood, line: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const hours = hoursOf(week, stage);
  const label = hoursLabel(stage);
  const Icon = stage === "working" ? Briefcase : stage === "school" ? Backpack : GraduationCap;
  const setHours = (change: Partial<NonNullable<WeekState["hours"]>>) => setWeek((current) => ({ ...current, hours: { ...hoursOf(current, stage), ...change } }));
  const summary = hours.off
    ? `No fixed ${label.toLocaleLowerCase()} hours`
    : hours.days.length === 0
      ? `${label} · no days picked`
      : `${label} · ${daysLabel(hours.days)} · ${clock12(hours.start)}–${clock12(hours.end)}`;
  return (
    <div className="ob-hours-wrap" data-open={open || undefined}>
      <div className="ob-hours-line">
        <span className="ob-hours-icon" aria-hidden="true"><Icon size={17} weight="fill" /></span>
        <span className="ob-hours-text">{summary}</span>
        <Tap className="ob-hours-edit" aria-expanded={open} feel="select" squish={0.9} onClick={() => setOpen((current) => !current)}>
          {open ? "Done" : "Edit"}
        </Tap>
      </div>
      {open && (
        <div className="ob-hours ob-rise">
          <Tap
            className="ob-toggle-chip"
            data-on={hours.off || undefined}
            aria-pressed={hours.off}
            feel={hours.off ? "toggle-off" : "toggle-on"}
            squish={0.92}
            onClick={() => {
              setHours({ off: !hours.off });
              if (!hours.off) react("cool", "No fixed hours. I'll plan around you.");
            }}
          >
            No fixed hours
          </Tap>
          {!hours.off && (
            <>
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
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the ask */

export function PlanAskStep({ answers, week, setWeek, react, next, onManual }: {
  answers: Answers;
  week: WeekState;
  setWeek: SetWeek;
  react: (mood: Mood, line: string) => void;
  next: () => void;
  onManual: () => void;
}) {
  const items = week.activities;
  const hints = React.useMemo(() => examples(answers.goals, answers.interests), [answers.goals, answers.interests]);
  const [hint, setHint] = React.useState(0);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<PlanError | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const { cooking, cook } = useCook();

  // The placeholder quietly cycles through a few of their own examples.
  React.useEffect(() => {
    if (hints.length < 2) return;
    const timer = window.setInterval(() => setHint((current) => (current + 1) % hints.length), 2600);
    return () => window.clearInterval(timer);
  }, [hints.length]);

  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

  const add = () => {
    const name = draft.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) return;
    setDraft("");
    input.current?.focus();
    if (same(name, FREE_TIME)) {
      react("smirk", "Free time is its own question. Just below.");
      return;
    }
    if (items.some((item) => same(item.name, name))) {
      react("think", `${name}'s already in.`);
      return;
    }
    if (items.length >= MAX_ACTIVITIES) {
      haptic("warning");
      react("oops", `${MAX_ACTIVITIES} things is a full week. Drop one first.`);
      return;
    }
    haptic("toggle-on");
    setWeek((current) => ({ ...current, activities: [...current.activities, { name, points: DEFAULT_POINTS }] }));
    react("excited", `${name}, in. Drag how much of your week it gets.`);
  };

  const remove = (name: string) => setWeek((current) => ({ ...current, activities: current.activities.filter((item) => !same(item.name, name)) }));
  const setPoints = (name: string, points: number) =>
    setWeek((current) => ({ ...current, activities: current.activities.map((item) => (item.name === name ? { ...item, points } : item)) }));
  const chooseFree = (freeTime: boolean) => {
    setWeek((current) => ({ ...current, freeTime }));
    react(freeTime ? "calm" : "fierce", freeTime ? "Breathing room it is. I'll leave gaps that are just yours." : "Strict it is. Every hour gets a job.");
  };

  const ready = items.length > 0 && week.freeTime !== null;
  const build = async () => {
    if (cooking || !ready) return;
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

  if (week.saved) {
    return (
      <StepFrame
        eyebrow="09 · Your week"
        title="Your week's locked in."
        sub="It's already in your Plan. Change anything there, anytime."
        footer={<Cta onClick={next}>See it</Cta>}
      >
        <span />
      </StepFrame>
    );
  }

  return (
    <div className="ob-step">
      <StepFrame
        eyebrow="09 · Your week"
        title="What goes in your week?"
        sub="Add what you want or need to do. JARVIS turns it into your timetable."
        footer={
          <>
            <Cta disabled={!ready} busy={cooking} arrow={ready} onClick={() => void build()}>
              {cooking ? "Building…" : items.length === 0 ? "Add at least one thing" : week.freeTime === null ? "Free blocks or strict?" : "Build my timetable"}
            </Cta>
            {!cooking && <Quiet onClick={onManual}>I&apos;ll set it up myself</Quiet>}
          </>
        }
      >
        {needsHours(answers.stage) && <HoursLine stage={answers.stage} week={week} setWeek={setWeek} react={react} />}

        <form
          className="ob-own ob-add-row"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            ref={input}
            className="ob-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, 40))}
            placeholder={hints.length ? `e.g. ${hints[hint % hints.length]}` : "e.g. Gym"}
            aria-label="Something you want or need to do each week"
            maxLength={40}
            enterKeyHint="done"
            autoCapitalize="sentences"
          />
          <Tap type="submit" className="ob-add-btn" feel={false} squish={0.9} disabled={!draft.trim()}>
            <Plus size={18} weight="bold" aria-hidden="true" /> Add
          </Tap>
        </form>

        {items.length > 0 && (
          <section className="ob-section ob-items">
            <span className="ob-caption">How much of your week?</span>
            <ul className="ob-acts">
              {items.map((item, index) => {
                const tone = toneFor(item.name, items);
                return (
                  <li key={item.name} className="ob-act ob-rise" data-tone={tone} style={{ "--i": index } as React.CSSProperties}>
                    <div className="ob-act-head">
                      <span className="ob-act-dot" aria-hidden="true" />
                      <strong>{item.name}</strong>
                      <Tap className="ob-act-x" aria-label={`Remove ${item.name}`} feel="toggle-off" squish={0.85} onClick={() => remove(item.name)}>
                        <X size={14} weight="bold" />
                      </Tap>
                    </div>
                    <PointsMeter
                      value={clampPoints(item.points)}
                      label={item.name}
                      tone={tone}
                      onChange={(points) => setPoints(item.name, points)}
                      onCommit={(points) => {
                        const said = pointsLine(item.name, points);
                        react(said.mood, said.line);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="ob-section">
          <h3 className="ob-q">Free blocks in your week?</h3>
          <div className="ob-duo" role="radiogroup" aria-label="Free blocks in your week">
            <OptionCard
              on={week.freeTime === true}
              tone="mint"
              emoji={<Coffee size={30} weight="duotone" />}
              title="Yes, leave me free time"
              line="Breathing room between things"
              onClick={() => chooseFree(true)}
            />
            <OptionCard
              on={week.freeTime === false}
              tone="red"
              emoji={<Target size={30} weight="duotone" />}
              title="No, strict timetable"
              line="Every hour gets a job"
              index={1}
              onClick={() => chooseFree(false)}
            />
          </div>
        </section>
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
  const [day, setDay] = React.useState(() => (new Date().getDay() + 6) % 7);
  const [feedback, setFeedback] = React.useState<Record<string, "less" | "more">>({});
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<PlanError | null>(null);
  const [saving, setSaving] = React.useState<{ done: number; total: number } | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const grid = React.useRef<HTMLDivElement>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => {
    alive.current = false;
  }, []);
  const { cooking, cook } = useCook();

  if (!plan) {
    return (
      <StepFrame eyebrow="09 · Your week" title="No plan yet." sub="Go back and tell me what goes in your week." footer={<Cta onClick={onManual}>Set it up myself</Cta>}>
        <span />
      </StepFrame>
    );
  }

  const groups = planGroups(plan, busy, answers.stage, week.activities);
  const bars = weekBars(
    groups.map((group, index) => ({ ...group, id: group.template === "planned" ? `plan-${index}` : group.template === "free" ? `free-${index}` : "busy" })),
  );
  const today = (new Date().getDay() + 6) % 7;
  const totals = activityTotals(plan);
  const free = freeTotals(plan);
  const tweaksLeft = MAX_TWEAKS - week.tweaks;
  const changes = Object.keys(feedback).length > 0 || comment.trim().length > 0;
  const locked = week.saved;

  const slots: Array<PlannedBlock & { busy?: boolean }> = plan.blocks.filter((block) => block.day === day);
  if (busy && busy.days.includes(day)) slots.push({ activity: busy.label, day, start: busy.start, end: busy.end, phase: phaseOf(busy.start), busy: true });

  const nudge = (activity: string, change: "less" | "more") => {
    setFeedback((current) => {
      const nextFeedback = { ...current };
      if (nextFeedback[activity] === change) delete nextFeedback[activity];
      else nextFeedback[activity] = change;
      return nextFeedback;
    });
    react(change === "less" ? "calm" : "fierce", change === "less" ? `Less ${activity}. Noted.` : `More ${activity}. Love the ambition.`);
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
      haptic("success");
      emitFx("success", grid.current);
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
  const save = async () => {
    if (saving || cooking) return;
    setSaveError(null);
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
    // Only move on if they are still here (back mid-save keeps them where they went).
    if (alive.current) next();
  };

  return (
    <div className="ob-step">
      <StepFrame
        eyebrow="09 · Your week"
        title="Here's your week."
        sub={locked ? "It's in your Plan. Change anything there, anytime." : "Tap a day to peek. Too much of something? Tell me."}
        footer={
          locked ? (
            <Cta onClick={next}>Next</Cta>
          ) : (
            <Cta variant="lock" icon={<LockSimple size={19} weight="fill" />} busy={Boolean(saving)} disabled={cooking} onClick={() => void save()}>
              {saving ? `Saving… ${saving.done}/${saving.total}` : "Lock it in"}
            </Cta>
          )
        }
      >
        <div ref={grid} className="ob-week ob-week-pick" role="tablist" aria-label="Days">
          <div className="ob-week-hours" aria-hidden="true">
            <span style={{ top: "25%" }}>6a</span>
            <span style={{ top: "50%" }}>12p</span>
            <span style={{ top: "75%" }}>6p</span>
          </div>
          {DAY_LETTERS.map((letter, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={day === index}
              aria-label={`${DAY_NAMES[index]}, ${plan.blocks.filter((block) => block.day === index && !block.free).length} blocks`}
              className="ob-week-col"
              data-today={index === today || undefined}
              data-on={day === index || undefined}
              onClick={() => {
                haptic("select");
                setDay(index);
              }}
            >
              <span className="ob-week-day">{letter}</span>
              <span className="ob-week-track">
                {bars.filter((bar) => bar.day === index).map((bar) => (
                  <span
                    key={`${bar.key}-${week.tweaks}`}
                    className="ob-bar"
                    data-tone={bar.tone}
                    data-busy={bar.block === "busy" || undefined}
                    data-free={bar.block.startsWith("free-") || undefined}
                    style={{ top: `${bar.top}%`, height: `${bar.height}%`, "--i": bar.from } as React.CSSProperties}
                  />
                ))}
              </span>
            </button>
          ))}
        </div>

        <div className="ob-dayplan" role="tabpanel" aria-label={DAY_NAMES[day]}>
          <h3 className="ob-q">{DAY_NAMES[day]}</h3>
          {slots.length === 0 && <p className="ob-hint">Rest day. Nothing planned.</p>}
          {PHASES.map((phase) => {
            const items = slots.filter((slot) => slot.phase === phase).sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
            if (items.length === 0) return null;
            return (
              <section key={phase} className="ob-phase">
                <span className="ob-label">{PHASE_LABEL[phase]}</span>
                <ul>
                  {items.map((slot) => (
                    <li
                      key={`${slot.activity}-${slot.start}`}
                      className="ob-slot"
                      data-busy={slot.busy || undefined}
                      data-free={slot.free || undefined}
                      data-tone={slot.busy || slot.free ? undefined : toneFor(slot.activity, week.activities)}
                    >
                      <span className="ob-slot-time">{clock12(slot.start)}–{clock12(slot.end)}</span>
                      <span className="ob-slot-name">
                        <span className="ob-slot-icon" aria-hidden="true">
                          {slot.busy ? <LockSimple size={14} weight="fill" /> : slot.free ? <Coffee size={15} weight="duotone" /> : emojiFor(slot.activity)}
                        </span>{" "}
                        {slot.activity}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <section className="ob-section">
          <h3 className="ob-q">Per week</h3>
          <ul className="ob-tally">
            {totals.map((total) => {
              const said = feedback[total.activity];
              return (
                <li key={total.activity} data-tone={toneFor(total.activity, week.activities)} data-said={said}>
                  <span className="ob-tally-emoji" aria-hidden="true">{emojiFor(total.activity)}</span>
                  <span className="ob-tally-text">
                    <strong>{total.activity}</strong>
                    <small>
                      {total.timesPerWeek}×/week · {total.minutesPerSession} min
                      {said && <em> · {said === "less" ? "less, please" : "more, please"}</em>}
                    </small>
                  </span>
                  {!locked && (
                    <>
                      <Tap className="ob-tally-btn" aria-label={`Too much ${total.activity}`} aria-pressed={said === "less"} data-on={said === "less" || undefined} feel="select" squish={0.85} disabled={cooking} onClick={() => nudge(total.activity, "less")}>
                        <Minus size={16} weight="bold" />
                      </Tap>
                      <Tap className="ob-tally-btn" aria-label={`Too little ${total.activity}`} aria-pressed={said === "more"} data-on={said === "more" || undefined} feel="select" squish={0.85} disabled={cooking} onClick={() => nudge(total.activity, "more")}>
                        <Plus size={16} weight="bold" />
                      </Tap>
                    </>
                  )}
                </li>
              );
            })}
            {free.blocks > 0 && (
              <li data-free>
                <span className="ob-tally-emoji" aria-hidden="true"><Coffee size={18} weight="duotone" /></span>
                <span className="ob-tally-text">
                  <strong>{FREE_TIME}</strong>
                  <small>{free.blocks} block{free.blocks === 1 ? "" : "s"} · {free.hours} h/week, just yours</small>
                </span>
              </li>
            )}
          </ul>
        </section>

        {!locked && (
          <section className="ob-section ob-tweak-box">
            <textarea
              className="ob-input ob-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value.slice(0, 300))}
              placeholder="Anything off? e.g. no gym on Sundays, DSA earlier"
              aria-label="Comments for HOLO"
              maxLength={300}
              rows={2}
            />
            <Tap className="ob-tweak" feel="heavy" squish={0.95} disabled={!changes || tweaksLeft <= 0 || cooking} onClick={() => void tweak()}>
              <Lightning size={18} weight="fill" aria-hidden="true" />
              {tweaksLeft <= 0 ? "No tweaks left. Edit it later in Plan." : `Tweak it · ${tweaksLeft} left`}
            </Tap>
            {error && <PlanErrorCard error={error} onManual={onManual} />}
          </section>
        )}
        {saveError && <p className="ob-error" role="alert">{saveError}</p>}
      </StepFrame>
      {cooking && <Cooking title="Tweaking your week…" lines={TWEAK_LINES} />}
    </div>
  );
}
