"use client";

import * as React from "react";
import { LockSimple, Plus } from "@phosphor-icons/react";

import { haptic } from "@/components/phone/lib/haptics";
import { reducedMotion } from "@/components/phone/lib/motion";
import { Scramble } from "@/components/phone/ui/Scramble";
import { Tap } from "@/components/phone/ui/Tap";
import { PLANS, UNLOCKED_BY } from "@/lib/gateway";
import {
  CHRONOTYPES,
  ENEMIES,
  EXAMS,
  GOAL_LIMIT,
  GOAL_REACTIONS,
  goalOptions,
  INTEREST_LIMIT,
  INTERESTS,
  LANGUAGES,
  NICE,
  pick,
  STAGES,
  TONES,
  VIBES,
  daysUntil,
  type Mood,
} from "./content";
import { Holo } from "./Holo";
import type { Answers } from "./state";
import { Chip, Cta, OptionCard, StepFrame } from "./ui";
import { clock12, minutesOf } from "./weekPlan";

export interface StepProps {
  answers: Answers;
  patch: (next: Partial<Answers>) => void;
  react: (mood: Mood, line: string) => void;
  next: () => void;
}

/** Shake an element once (a refused tap). */
function shake(element: Element | null) {
  if (!element || reducedMotion()) return;
  element.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-7px)" },
      { transform: "translateX(6px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 380, easing: "ease-out" },
  );
}

/* ------------------------------------------------------------------ boot */

export function BootStep({ next }: { next: () => void }) {
  const [awake, setAwake] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setAwake(true);
      haptic("success");
    }, reducedMotion() ? 0 : 1250);
    return () => window.clearTimeout(timer);
  }, []);
  const title = "I'm your new brain.";
  return (
    <div className="ob-step ob-boot">
      <div className="ob-boot-stage">
        <span className="ob-boot-holo">
          <span className="ob-boot-beam" aria-hidden="true" />
          <Holo mood={awake ? "happy" : "wow"} kick={awake ? 1 : 0} size={176} glitchIn />
        </span>
      </div>
      <div className="ob-boot-copy">
        <Scramble text="HOLO · ONLINE" className="ob-eyebrow ob-boot-tag" />
        <h1 className="ob-boot-title" data-ob-title tabIndex={-1}>
          <span className="ob-boot-yo">yo.</span>
          <span className="ob-boot-line">
            {title.split(" ").map((word, index) => (
              <React.Fragment key={index}>
                <span className="ob-word" style={{ "--i": index } as React.CSSProperties}>{word}</span>{" "}
              </React.Fragment>
            ))}
          </span>
        </h1>
        <p className="ob-sub ob-boot-sub">Got 60 seconds? A few taps and I&apos;ll build a JARVIS that actually gets you.</p>
      </div>
      <div className="ob-step-foot">
        <Cta onClick={next}>Let&apos;s build it</Cta>
        <p className="ob-fine">No sign-up yet. That comes last.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ name */

const NICKS: Array<{ label: string; reaction: string; mood: Mood }> = [
  { label: "Boss", reaction: "Yes, Boss. 🫡", mood: "smirk" },
  { label: "Legend", reaction: "Legend it is. No pressure.", mood: "excited" },
  { label: "Captain", reaction: "Aye aye, Captain.", mood: "happy" },
  { label: "Champ", reaction: "Champ. Let's earn it.", mood: "fierce" },
  { label: "Chief", reaction: "Chief. Respect.", mood: "cool" },
];

const NAME_LINES = [
  (name: string) => `${name}! Main character energy already.`,
  (name: string) => `${name}. Noted. Never forgetting it. (Literally, I'm a computer.)`,
  (name: string) => `Nice to meet you, ${name}.`,
];

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

export function NameStep({ answers, patch, react, next }: StepProps) {
  const name = answers.name;
  const first = firstName(name);
  const isNick = NICKS.some((nick) => nick.label === answers.callMe);
  const [custom, setCustom] = React.useState(() => answers.callMe !== "" && answers.callMe !== first && !isNick);
  const reacted = React.useRef(first);

  // React to the name once typing pauses, once per name.
  React.useEffect(() => {
    if (first.length < 2 || first === reacted.current) return;
    const timer = window.setTimeout(() => {
      reacted.current = first;
      react("happy", pick(NAME_LINES)(first));
    }, 850);
    return () => window.clearTimeout(timer);
  }, [first, react]);

  const valid = name.trim().length > 0;
  const go = () => {
    if (!valid) return;
    if (!answers.callMe.trim()) patch({ callMe: first });
    next();
  };
  const callOn = (value: string) => !custom && (answers.callMe === value || (value === first && answers.callMe === ""));

  return (
    <StepFrame
      eyebrow="01 · You"
      title="First up: what's your name?"
      footer={<Cta disabled={!valid} onClick={go}>{valid ? "That's me" : "Type your name"}</Cta>}
    >
      <label className="ob-name">
        <input
          value={name}
          onChange={(event) => {
            const value = event.target.value.slice(0, 40);
            // Keep "call me" following the name until they pick something else.
            const following = !custom && (answers.callMe === "" || answers.callMe === first);
            patch(following ? { name: value, callMe: firstName(value) } : { name: value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              go();
            }
          }}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="given-name"
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={40}
          spellCheck={false}
        />
        <span className="ob-name-line" aria-hidden="true" />
      </label>

      {valid && (
        <section className="ob-section ob-rise">
          <h3 className="ob-q">And what should I call you?</h3>
          <div className="ob-chips">
            {first && (
              <Chip
                on={callOn(first)}
                tone="lime"
                emoji="👋"
                label={first}
                index={0}
                onClick={() => {
                  setCustom(false);
                  patch({ callMe: first });
                  react("happy", `${first} it is.`);
                }}
              />
            )}
            {NICKS.map((nick, index) => (
              <Chip
                key={nick.label}
                on={callOn(nick.label)}
                tone={TONES[(index + 1) % TONES.length]}
                label={nick.label}
                index={index + 1}
                onClick={() => {
                  setCustom(false);
                  patch({ callMe: nick.label });
                  react(nick.mood, nick.reaction);
                }}
              />
            ))}
            <Chip
              on={custom}
              tone="lilac"
              emoji="✏️"
              label="Something else"
              index={NICKS.length + 1}
              onClick={() => {
                setCustom(true);
                patch({ callMe: "" });
              }}
            />
          </div>
          {custom && (
            <input
              className="ob-input ob-rise"
              value={answers.callMe}
              onChange={(event) => patch({ callMe: event.target.value.slice(0, 24) })}
              onBlur={() => answers.callMe.trim() && react("love", `${answers.callMe.trim()}? Love it.`)}
              placeholder="Call me…"
              aria-label="What JARVIS should call you"
              maxLength={24}
              autoCapitalize="words"
              spellCheck={false}
            />
          )}
        </section>
      )}
    </StepFrame>
  );
}

/* ------------------------------------------------------------------ vibe */

export function VibeStep({ answers, patch, react, next }: StepProps) {
  const track = React.useRef<HTMLDivElement>(null);
  return (
    <StepFrame
      eyebrow="02 · My vibe"
      title="How should I talk to you?"
      sub="Swipe through. Tap the one that sounds like your kind of friend."
      footer={<Cta disabled={!answers.vibe} onClick={next}>{answers.vibe ? "That's the vibe" : "Pick a vibe"}</Cta>}
    >
      <div ref={track} className="ob-vibes" role="radiogroup" aria-label="Vibe">
        {VIBES.map((vibe, index) => {
          const on = answers.vibe === vibe.value;
          return (
            <Tap
              key={vibe.value}
              role="radio"
              aria-checked={on}
              aria-label={`${vibe.title}. Sounds like: ${vibe.sample}`}
              className="ob-vibe"
              data-tone={vibe.tone}
              data-on={on}
              feel="heavy"
              squish={0.96}
              style={{ "--i": index } as React.CSSProperties}
              onClick={(event) => {
                patch({ vibe: vibe.value });
                react(vibe.mood, vibe.reaction);
                event.currentTarget.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", inline: "center", block: "nearest" });
              }}
            >
              <span className="ob-vibe-top">
                <span className="ob-vibe-emoji" aria-hidden="true">{vibe.emoji}</span>
                <span className="ob-tag">{vibe.tag}</span>
              </span>
              <strong className="ob-vibe-title">{vibe.title}</strong>
              <span className="ob-vibe-quote">{vibe.sample}</span>
              <span className="ob-vibe-pick">{on ? "Picked ✓" : "Tap to pick"}</span>
            </Tap>
          );
        })}
      </div>
      <p className="ob-hint">You can switch it anytime. I won&apos;t take it personally.</p>
    </StepFrame>
  );
}

/* ----------------------------------------------------------------- stage */

export function StageStep({ answers, patch, react, next }: StepProps) {
  const today = new Date();
  const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const exam = answers.stage === "exam";
  const valid = Boolean(answers.stage) && (!exam || (Boolean(answers.exam) && (answers.exam !== "Other" || answers.examOther.trim().length > 0)));
  return (
    <StepFrame
      eyebrow="03 · Your quest"
      title="What's your current quest?"
      footer={<Cta disabled={!valid} onClick={next}>{!answers.stage ? "Pick one" : exam && !valid ? "Which exam?" : "Next"}</Cta>}
    >
      <div className="ob-cards" role="radiogroup" aria-label="Where you are">
        {STAGES.map((stage, index) => (
          <OptionCard
            key={stage.value}
            on={answers.stage === stage.value}
            dim={Boolean(answers.stage) && answers.stage !== stage.value}
            tone={stage.tone}
            emoji={stage.emoji}
            title={stage.title}
            line={stage.line}
            index={index}
            onClick={() => {
              patch({ stage: stage.value });
              react(stage.mood, stage.reaction);
            }}
          />
        ))}
      </div>
      {exam && (
        <section className="ob-section ob-rise">
          <h3 className="ob-q">Which one?</h3>
          <div className="ob-chips" role="radiogroup" aria-label="Exam">
            {EXAMS.map((item, index) => (
              <Chip
                key={item.value}
                on={answers.exam === item.value}
                tone={TONES[index % TONES.length]}
                label={item.value}
                index={index}
                onClick={() => {
                  patch({ exam: item.value });
                  react(item.value === "Other" ? "think" : "fierce", item.reaction);
                }}
              />
            ))}
          </div>
          {answers.exam === "Other" && (
            <input
              className="ob-input ob-rise"
              value={answers.examOther}
              onChange={(event) => patch({ examOther: event.target.value.slice(0, 30) })}
              placeholder="Which exam?"
              aria-label="Exam name"
              maxLength={30}
              autoCapitalize="characters"
              spellCheck={false}
            />
          )}
          <label className="ob-date">
            <span>When is it? <em>Optional</em></span>
            <input
              type="date"
              min={min}
              value={answers.examDate}
              aria-label="Exam date"
              onChange={(event) => {
                const value = event.target.value;
                patch({ examDate: value });
                const days = daysUntil(value);
                if (days !== null && days >= 0) {
                  react(days < 45 ? "wow" : "fierce", days < 45 ? `${days} days?! Okay. Every day counts now.` : `${days} days. Plenty, if we start today.`);
                }
              }}
            />
          </label>
        </section>
      )}
    </StepFrame>
  );
}

/* ------------------------------------------------------------- interests */

export function InterestsStep({ answers, patch, react, next }: StepProps) {
  const grid = React.useRef<HTMLDivElement>(null);
  const count = answers.interests.length;
  return (
    <StepFrame
      eyebrow="04 · Your stuff"
      title="What are you into?"
      sub="Pick as many as you like. I'll keep things relevant."
      footer={<Cta disabled={count === 0} onClick={next}>{count === 0 ? "Pick at least one" : `Next · ${count} picked`}</Cta>}
    >
      <div ref={grid} className="ob-chips ob-chips-big">
        {INTERESTS.map((item, index) => {
          const on = answers.interests.includes(item.label);
          return (
            <Chip
              key={item.label}
              on={on}
              tone={TONES[index % TONES.length]}
              emoji={item.emoji}
              label={item.label}
              index={index}
              onClick={() => {
                if (on) {
                  patch({ interests: answers.interests.filter((label) => label !== item.label) });
                  return;
                }
                if (count >= INTEREST_LIMIT) {
                  haptic("warning");
                  shake(grid.current);
                  react("oops", "Twelve is plenty. Save some fun for later.");
                  return;
                }
                patch({ interests: [...answers.interests, item.label] });
                react(item.reaction ? "excited" : pick<Mood>(["happy", "love", "smirk"]), item.reaction ?? pick(NICE));
              }}
            />
          );
        })}
      </div>
    </StepFrame>
  );
}

/* ----------------------------------------------------------------- goals */

export function GoalsStep({ answers, patch, react, next }: StepProps) {
  const options = goalOptions(answers.stage, answers.exam === "Other" ? answers.examOther.trim() || null : answers.exam);
  const custom = answers.goals.filter((goal) => !options.some((option) => option.label === goal));
  const [draft, setDraft] = React.useState("");
  const counter = React.useRef<HTMLSpanElement>(null);
  const count = answers.goals.length;

  const toggle = (label: string) => {
    if (answers.goals.includes(label)) {
      patch({ goals: answers.goals.filter((goal) => goal !== label) });
      return;
    }
    if (count >= GOAL_LIMIT) {
      haptic("warning");
      shake(counter.current);
      react("fierce", "Three max! Focus is a superpower.");
      return;
    }
    patch({ goals: [...answers.goals, label] });
    react(count === GOAL_LIMIT - 1 ? "excited" : "happy", GOAL_REACTIONS[count]);
  };

  const addOwn = () => {
    const label = draft.trim().slice(0, 40);
    if (!label) return;
    if (answers.goals.some((goal) => goal.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      setDraft("");
      return;
    }
    if (count >= GOAL_LIMIT) {
      haptic("warning");
      shake(counter.current);
      react("fierce", "Three max! Drop one first.");
      return;
    }
    haptic("toggle-on");
    patch({ goals: [...answers.goals, label] });
    setDraft("");
    react("love", `"${label}". I like it. Writing it down.`);
  };

  return (
    <StepFrame
      eyebrow="05 · Main quests"
      title="Your top 3 goals this year?"
      sub={<>Big or small, both count. <span ref={counter} className="ob-count" data-full={count === GOAL_LIMIT || undefined}>{count}/{GOAL_LIMIT}</span></>}
      footer={<Cta disabled={count === 0} onClick={next}>{count === 0 ? "Pick up to 3" : "Lock these in"}</Cta>}
    >
      <div className="ob-chips ob-chips-big">
        {[...options.map((option) => ({ ...option, own: false })), ...custom.map((label) => ({ label, emoji: "⭐", own: true }))].map((option, index) => (
          <Chip
            key={option.label}
            on={answers.goals.includes(option.label)}
            tone={TONES[(index + 2) % TONES.length]}
            emoji={option.emoji}
            label={option.label}
            index={index}
            onClick={() => toggle(option.label)}
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
          placeholder="Or write your own…"
          aria-label="Your own goal"
          maxLength={40}
          enterKeyHint="done"
        />
        <Tap type="submit" className="ob-own-add" aria-label="Add goal" feel={false} squish={0.88} disabled={!draft.trim()}>
          <Plus size={20} weight="bold" />
        </Tap>
      </form>
    </StepFrame>
  );
}

/* ----------------------------------------------------------------- enemy */

export function EnemyStep({ answers, patch, react, next }: StepProps) {
  return (
    <StepFrame
      eyebrow="06 · The villain"
      title="What wrecks your day?"
      sub="Pick your final boss. I'll nudge you the right way."
      footer={<Cta disabled={!answers.enemy} onClick={next}>{answers.enemy ? "Let's beat it" : "Pick one"}</Cta>}
    >
      <div className="ob-cards" role="radiogroup" aria-label="What wrecks your day">
        {ENEMIES.map((enemy, index) => (
          <OptionCard
            key={enemy.value}
            on={answers.enemy === enemy.value}
            dim={Boolean(answers.enemy) && answers.enemy !== enemy.value}
            tone={enemy.tone}
            emoji={enemy.emoji}
            title={enemy.title}
            line={enemy.line}
            index={index}
            onClick={() => {
              patch({ enemy: enemy.value });
              react(enemy.mood, enemy.reaction);
            }}
          />
        ))}
      </div>
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- rhythm */

const WAKE_FROM = 4 * 60; // 4:00
const SLEEP_FROM = 20 * 60; // 20:00
const SLOTS = 32; // 8 hours in 15-minute steps

function hhmm(minutes: number): string {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function slotOf(value: string, from: number): number {
  const minutes = minutesOf(value);
  const offset = (minutes - from + 1440) % 1440;
  return Math.max(0, Math.min(SLOTS, Math.round(offset / 15)));
}

/** Late if they sleep after 00:30 or wake after 9:30. */
export function suggestedChronotype(wake: string, sleep: string): "early" | "night" {
  const sleepLate = slotOf(sleep, SLEEP_FROM) > 18;
  const wakeLate = minutesOf(wake) > 9 * 60 + 30;
  return sleepLate || wakeLate ? "night" : "early";
}

function Slider({ label, emoji, value, from, onChange, onSettle, tone }: {
  label: string;
  emoji: string;
  value: string;
  from: number;
  onChange: (value: string) => void;
  onSettle: (value: string) => void;
  tone: string;
}) {
  const slot = slotOf(value, from);
  const lastHour = React.useRef(Math.floor(minutesOf(value) / 60));
  const settle = React.useRef<number>();
  return (
    <label className="ob-slider" data-tone={tone}>
      <span className="ob-slider-head">
        <span>{label}</span>
        <strong className="ob-slider-time"><span aria-hidden="true">{emoji}</span> {clock12(value)}</strong>
      </span>
      <input
        type="range"
        min={0}
        max={SLOTS}
        step={1}
        value={slot}
        aria-label={label}
        aria-valuetext={clock12(value)}
        style={{ "--p": `${(slot / SLOTS) * 100}%` } as React.CSSProperties}
        onChange={(event) => {
          const next = hhmm(from + Number(event.target.value) * 15);
          const hour = Math.floor(minutesOf(next) / 60);
          if (hour !== lastHour.current) {
            lastHour.current = hour;
            haptic("select", false);
          }
          onChange(next);
          window.clearTimeout(settle.current);
          settle.current = window.setTimeout(() => onSettle(next), 450);
        }}
      />
      <span className="ob-slider-scale" aria-hidden="true">
        <span>{clock12(hhmm(from))}</span>
        <span>{clock12(hhmm(from + SLOTS * 15))}</span>
      </span>
    </label>
  );
}

export function RhythmStep({ answers, patch, react, next }: StepProps) {
  const suggested = suggestedChronotype(answers.wake, answers.sleep);
  return (
    <StepFrame
      eyebrow="07 · Your rhythm"
      title="When does your day run?"
      footer={<Cta disabled={!answers.chronotype} onClick={next}>{answers.chronotype ? "Next" : "Owl or bird?"}</Cta>}
    >
      <div className="ob-sliders">
        <Slider
          label="I wake up around"
          emoji="☀️"
          tone="amber"
          value={answers.wake}
          from={WAKE_FROM}
          onChange={(wake) => patch({ wake })}
          onSettle={(wake) => {
            const minutes = minutesOf(wake);
            if (minutes < 6 * 60) react("wow", `Before 6?! Okay, monk.`);
            else if (minutes > 10 * 60) react("sleepy", "Late riser. No judgement… mostly.");
            else react("happy", `${clock12(wake)}. Solid.`);
          }}
        />
        <Slider
          label="I crash around"
          emoji="🌙"
          tone="lilac"
          value={answers.sleep}
          from={SLEEP_FROM}
          onChange={(sleep) => patch({ sleep })}
          onSettle={(sleep) => {
            const slot = slotOf(sleep, SLEEP_FROM);
            if (slot > 20) react("wow", `${clock12(sleep)}?? Owl behaviour. 🦉`);
            else if (slot < 8) react("calm", "Early to bed. Your future self says thanks.");
            else react("smirk", `${clock12(sleep)}. I'll remind you. Gently.`);
          }}
        />
      </div>
      <section className="ob-section">
        <h3 className="ob-q">So you&apos;re a…</h3>
        <div className="ob-duo" role="radiogroup" aria-label="Early bird or night owl">
          {CHRONOTYPES.map((type, index) => (
            <OptionCard
              key={type.value}
              on={answers.chronotype === type.value}
              tone={type.tone}
              emoji={type.emoji}
              title={type.title}
              line={type.line}
              index={index}
              badge={!answers.chronotype && suggested === type.value ? <span className="ob-guess">HOLO&apos;s guess</span> : undefined}
              onClick={() => {
                patch({ chronotype: type.value });
                react(type.mood, type.reaction);
              }}
            />
          ))}
        </div>
      </section>
    </StepFrame>
  );
}

/* -------------------------------------------------------------- language */

export function LanguageStep({ answers, patch, react, next }: StepProps) {
  const plan = PLANS.find((item) => item.id === UNLOCKED_BY.voice_te);
  const lock = plan ? `${plan.name} · ₹${plan.price}` : "Main Character";
  return (
    <StepFrame
      eyebrow="08 · Language"
      title="Which language feels like home?"
      footer={<Cta disabled={!answers.language} onClick={next}>{answers.language ? "Next" : "Pick one"}</Cta>}
    >
      <div className="ob-cards" role="radiogroup" aria-label="Language">
        {LANGUAGES.map((language, index) => (
          <OptionCard
            key={language.value}
            on={answers.language === language.value}
            dim={Boolean(answers.language) && answers.language !== language.value}
            tone={language.tone}
            emoji={language.value === "te" ? "అ" : language.value === "hinglish" ? "हA" : "Aa"}
            title={<span lang={language.value === "te" ? "te" : undefined}>{language.native}</span>}
            line={<span lang={language.value === "te" ? "te" : undefined}>&ldquo;{language.sample}&rdquo;</span>}
            index={index}
            badge={language.value === "te" ? (
              <span className="ob-lock" aria-label={`Telugu voice needs ${lock}`}>
                <LockSimple size={12} weight="fill" aria-hidden="true" /> Voice
              </span>
            ) : undefined}
            onClick={() => {
              patch({ language: language.value });
              react(language.mood, language.reaction);
            }}
          />
        ))}
      </div>
      {answers.language === "te" && (
        <p className="ob-note ob-rise">
          <LockSimple size={14} weight="fill" aria-hidden="true" />
          <span>Typing works on every plan. Telugu <b>voice</b> comes with {lock}/month.</span>
        </p>
      )}
    </StepFrame>
  );
}
