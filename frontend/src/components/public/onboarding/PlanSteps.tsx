"use client";

import * as React from "react";
import { Lightning, Minus, Plus, X } from "@phosphor-icons/react";

import { usePublicOptional } from "@/components/public/PublicContext";
import { emitFx } from "@/components/phone/fx/fxBus";
import { haptic } from "@/components/phone/lib/haptics";
import { useAppData } from "@/components/phone/PhoneContext";
import { TimeInput } from "@/components/phone/ui/Form";
import { Tap } from "@/components/phone/ui/Tap";
import { TONES, type Mood } from "./content";
import { Holo } from "./Holo";
import {
  activityTotals,
  busyOf,
  emojiFor,
  FREQUENCIES,
  goalActivities,
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
  suggestions,
  toneFor,
  type Frequency,
  type Importance,
  type Phase,
  type PlannedBlock,
  type PlanWeekRequest,
  type PlanWeekResponse,
  type WeekState,
} from "./planWeek";
import { examName, type Answers } from "./state";
import { Chip, Cta, DayToggles, Quiet, StepFrame } from "./ui";
import { clock12, createBlock, DAY_LETTERS, DAY_NAMES, friendlySaveError, minutesOf, newId, weekBars, type AddedBlock } from "./weekPlan";

type SetWeek = (update: (week: WeekState) => WeekState) => void;

const IMPORTANCE_LINES: Record<Importance, string> = {
  1: "nice-to-have. Noted.",
  2: "light touch.",
  3: "solid middle.",
  4: "a big one. Got it.",
  5: "top priority. 🔥",
};

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
    activities: week.activities.map((activity) => ({ name: activity.name, importance: activity.importance, frequency: activity.frequency })),
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

/* ------------------------------------------------------------ the ask */

export function PlanAskStep({ answers, week, setWeek, react, next, onManual }: {
  answers: Answers;
  week: WeekState;
  setWeek: SetWeek;
  react: (mood: Mood, line: string) => void;
  next: () => void;
  onManual: () => void;
}) {
  const stage = answers.stage;
  const showHours = needsHours(stage);
  const hours = hoursOf(week, stage);
  const label = hoursLabel(stage);
  const offered = React.useMemo(() => suggestions(answers.goals, answers.interests), [answers.goals, answers.interests]);
  const picked = week.activities;
  const custom = picked.filter((activity) => !offered.some((name) => name.toLocaleLowerCase() === activity.name.toLocaleLowerCase()));
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<PlanError | null>(null);
  const { cooking, cook } = useCook();

  // First visit: pre-pick what their goals point at.
  React.useEffect(() => {
    if (week.seeded) return;
    const fromGoals = goalActivities(answers.goals).slice(0, 3);
    setWeek((current) => ({
      ...current,
      seeded: true,
      activities: current.activities.length ? current.activities : fromGoals.map((name) => ({ name, emoji: emojiFor(name), importance: 4, frequency: null })),
    }));
    // Once, on arrival (HOLO's opener mentions the picks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setHours = (change: Partial<NonNullable<WeekState["hours"]>>) => setWeek((current) => ({ ...current, hours: { ...hoursOf(current, stage), ...change } }));

  const toggle = (name: string) => {
    const on = picked.some((activity) => activity.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (on) {
      setWeek((current) => ({ ...current, activities: current.activities.filter((activity) => activity.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) }));
      return;
    }
    if (picked.length >= MAX_ACTIVITIES) {
      haptic("warning");
      react("oops", `${MAX_ACTIVITIES} is plenty for one week. Drop one first.`);
      return;
    }
    setWeek((current) => ({ ...current, activities: [...current.activities, { name, emoji: emojiFor(name), importance: 3, frequency: null }] }));
    react("excited", `${name}, in. How much does it matter?`);
  };

  const addOwn = () => {
    const name = draft.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) return;
    setDraft("");
    if (picked.some((activity) => activity.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    haptic("toggle-on");
    toggle(name);
  };

  const update = (name: string, change: { importance?: Importance; frequency?: Frequency | null }) =>
    setWeek((current) => ({ ...current, activities: current.activities.map((activity) => (activity.name === name ? { ...activity, ...change } : activity)) }));

  const build = async () => {
    if (cooking || picked.length === 0) return;
    setError(null);
    react("think", "Cooking. Give me a few seconds.");
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
        title="Your week, your rules."
        sub="Tell me what you want in it and how much each thing matters. I'll do the maths."
        footer={
          <>
            <Cta disabled={picked.length === 0} busy={cooking} onClick={() => void build()}>
              {cooking ? "Cooking…" : picked.length === 0 ? "Pick at least one" : "Build my week ⚡"}
            </Cta>
            {!cooking && <Quiet onClick={onManual}>I&apos;ll set it up myself</Quiet>}
          </>
        }
      >
        {showHours && (
          <section className="ob-section">
            <div className="ob-row-between">
              <h3 className="ob-q">When&apos;s {label.toLocaleLowerCase()}?</h3>
              <Tap
                className="ob-toggle-chip"
                data-on={hours.off || undefined}
                aria-pressed={hours.off}
                feel={hours.off ? "toggle-off" : "toggle-on"}
                squish={0.92}
                onClick={() => {
                  setHours({ off: !hours.off });
                  if (!hours.off) react("cool", "No fixed hours. Freedom. I'll plan around you.");
                }}
              >
                No fixed hours
              </Tap>
            </div>
            {!hours.off && (
              <div className="ob-hours ob-rise">
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
              </div>
            )}
          </section>
        )}

        <section className="ob-section">
          <h3 className="ob-q">What do you want in your week?</h3>
          <div className="ob-chips ob-chips-tight">
            {[...offered, ...custom.map((activity) => activity.name)].map((name, index) => (
              <Chip
                key={name}
                on={picked.some((activity) => activity.name.toLocaleLowerCase() === name.toLocaleLowerCase())}
                tone={TONES[index % TONES.length]}
                emoji={emojiFor(name)}
                label={name}
                index={index}
                onClick={() => toggle(name)}
              />
            ))}
          </div>
          <form
            className="ob-own"
            onSubmit={(event) => {
              event.preventDefault();
              addOwn();
            }}
          >
            <input
              className="ob-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 40))}
              placeholder="+ Add your own"
              aria-label="Add your own activity"
              maxLength={40}
              enterKeyHint="done"
            />
            <Tap type="submit" className="ob-own-add" aria-label="Add activity" feel={false} squish={0.88} disabled={!draft.trim()}>
              <Plus size={20} weight="bold" />
            </Tap>
          </form>
        </section>

        {picked.length > 0 && (
          <section className="ob-section">
            <h3 className="ob-q">How much does each one matter?</h3>
            <ul className="ob-acts">
              {picked.map((activity, index) => (
                <li key={activity.name} className="ob-act ob-rise" data-tone={toneFor(activity.name, picked)} style={{ "--i": index } as React.CSSProperties}>
                  <div className="ob-act-head">
                    <span className="ob-act-emoji" aria-hidden="true">{activity.emoji}</span>
                    <strong>{activity.name}</strong>
                    <Tap className="ob-act-x" aria-label={`Remove ${activity.name}`} feel="toggle-off" squish={0.85} onClick={() => toggle(activity.name)}>
                      <X size={14} weight="bold" />
                    </Tap>
                  </div>
                  <div className="ob-flames" role="radiogroup" aria-label={`How much ${activity.name} matters`}>
                    {([1, 2, 3, 4, 5] as Importance[]).map((level) => (
                      <Tap
                        key={level}
                        role="radio"
                        aria-checked={activity.importance === level}
                        aria-label={`${level} of 5`}
                        className="ob-flame"
                        data-on={level <= activity.importance || undefined}
                        feel="select"
                        squish={0.8}
                        onClick={() => {
                          update(activity.name, { importance: level });
                          react(level >= 4 ? "fierce" : level <= 2 ? "calm" : "happy", `${activity.name}: ${IMPORTANCE_LINES[level]}`);
                        }}
                      >
                        🔥
                      </Tap>
                    ))}
                  </div>
                  <div className="ob-freq" role="radiogroup" aria-label={`How often for ${activity.name}`}>
                    {FREQUENCIES.map((option) => (
                      <Tap
                        key={option.label}
                        role="radio"
                        aria-checked={activity.frequency === option.value}
                        className="ob-freq-opt"
                        data-on={activity.frequency === option.value || undefined}
                        feel="select"
                        squish={0.9}
                        onClick={() => {
                          update(activity.name, { frequency: option.value });
                          react("smirk", option.value === null ? `I'll pick how often ${activity.name} happens.` : option.value === "daily" ? `Daily ${activity.name}? Respect.` : `${activity.name}, ${option.label} a week.`);
                        }}
                      >
                        {option.label}
                      </Tap>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {error && <PlanErrorCard error={error} onManual={onManual} />}
      </StepFrame>
      {cooking && <Cooking title="Cooking your week…" lines={COOK_LINES} />}
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
      <StepFrame eyebrow="09 · Your week" title="No plan yet." sub="Go back and tell me what you want in your week." footer={<Cta onClick={onManual}>Set it up myself</Cta>}>
        <span />
      </StepFrame>
    );
  }

  const groups = planGroups(plan, busy, answers.stage, week.activities);
  const bars = weekBars(groups.map((group, index) => ({ ...group, id: group.template === "planned" ? `p${index}` : "busy" })));
  const today = (new Date().getDay() + 6) % 7;
  const totals = activityTotals(plan);
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
        previous: plan.blocks,
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
    haptic("success");
    emitFx("success", grid.current);
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
            <Cta busy={Boolean(saving)} disabled={cooking} onClick={() => void save()}>
              {saving ? `Saving… ${saving.done}/${saving.total}` : "Lock it in 🔒"}
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
              aria-label={`${DAY_NAMES[index]}, ${plan.blocks.filter((block) => block.day === index).length} blocks`}
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
                    style={{ top: `${bar.top}%`, height: `${bar.height}%`, "--i": bar.from } as React.CSSProperties}
                  />
                ))}
              </span>
            </button>
          ))}
        </div>

        <div className="ob-dayplan" role="tabpanel" aria-label={DAY_NAMES[day]}>
          <h3 className="ob-q">{DAY_NAMES[day]}</h3>
          {slots.length === 0 && <p className="ob-hint">Rest day. Nothing planned. 😌</p>}
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
                      data-tone={slot.busy ? undefined : toneFor(slot.activity, week.activities)}
                    >
                      <span className="ob-slot-time">{clock12(slot.start)}–{clock12(slot.end)}</span>
                      <span className="ob-slot-name">
                        <span aria-hidden="true">{slot.busy ? "🔒" : emojiFor(slot.activity)}</span> {slot.activity}
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
