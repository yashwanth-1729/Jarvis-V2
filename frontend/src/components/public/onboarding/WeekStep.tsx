"use client";

import * as React from "react";
import { Camera, Check, Plus, X } from "@phosphor-icons/react";

import { emitFx } from "@/components/phone/fx/fxBus";
import { useBackLayer } from "@/components/phone/lib/backStack";
import { haptic } from "@/components/phone/lib/haptics";
import { useAppData } from "@/components/phone/PhoneContext";
import { TimeInput } from "@/components/phone/ui/Form";
import { Tap } from "@/components/phone/ui/Tap";
import type { Mood } from "./content";
import type { Answers } from "./state";
import { Cta, DayToggles, Quiet, StepFrame } from "./ui";
import {
  clock12,
  createBlock,
  DAY_LETTERS,
  DAY_NAMES,
  daysLabel,
  minutesOf,
  templatesFor,
  weekBars,
  type AddedBlock,
  type BlockSpec,
  type TemplateId,
} from "./weekPlan";

const ADDED_LINES: Record<TemplateId, (block: BlockSpec) => string> = {
  college: (block) => `${block.name}, ${daysLabel(block.days)}. I'll keep you on time.`,
  gym: (block) => `Gym, ${daysLabel(block.days)}. Look at you. 💪`,
  study: () => "Study blocks in. Future you is cheering.",
  coaching: () => "Coaching's in the week. Notes ready?",
  work: (block) => `${block.name} hours set. I'll guard the evenings.`,
  sleep: () => "Sleep, scheduled. Revolutionary.",
  custom: (block) => `${block.name}, added. Your week, your rules.`,
};

const PRESETS: Array<{ label: string; days: number[] }> = [
  { label: "Weekdays", days: [0, 1, 2, 3, 4] },
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Weekends", days: [5, 6] },
];

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function friendly(error: string): string {
  return /fetch|network|load failed|backend|timeout/i.test(error)
    ? "Couldn't reach your JARVIS yet. It may still be starting up."
    : error;
}

export function WeekStep({ answers, blocks, onAdded, react, next }: {
  answers: Answers;
  blocks: AddedBlock[];
  onAdded: (block: AddedBlock) => void;
  react: (mood: Mood, line: string) => void;
  next: () => void;
}) {
  const { app, mode } = useAppData();
  const templates = React.useMemo(
    () => templatesFor(answers.stage, { wake: answers.wake, sleep: answers.sleep, night: answers.chronotype === "night" }),
    [answers.stage, answers.wake, answers.sleep, answers.chronotype],
  );
  const [editing, setEditing] = React.useState<BlockSpec | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [landed, setLanded] = React.useState<number[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const preview = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<HTMLDivElement>(null);
  useBackLayer(editing !== null, () => setEditing(null));

  const open = (template: (typeof templates)[number]) => {
    setError(null);
    setEditing({ ...template, days: [...template.days] });
    react("think", template.template === "custom" ? "Ooh, custom. What is it?" : `${template.label}. Which days?`);
    window.setTimeout(() => editor.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
  };

  const add = async () => {
    if (!editing || busy) return;
    const spec: BlockSpec = { ...editing, name: editing.name.trim() };
    const problem = !spec.name ? "Give it a name." : spec.days.length === 0 ? "Pick at least one day." : !spec.start || !spec.end ? "Set when it starts and ends." : null;
    if (problem) {
      setError(problem);
      haptic("warning");
      react("think", problem);
      return;
    }
    setBusy(true);
    setError(null);
    setLanded([]);
    const result = await createBlock(mode, spec, (day) => {
      setLanded((current) => [...current, day]);
      haptic("select", false);
    });
    setBusy(false);
    setLanded([]);
    if (result.records.length) {
      const created = new Set(result.records.map((record) => record.day));
      const block: AddedBlock = { ...spec, days: spec.days.filter((day) => created.has(day)), id: newId(), records: result.records };
      onAdded(block);
      app.handleRecordChanged();
      haptic("success");
      emitFx("success", preview.current);
      react(blocks.length >= 2 ? "excited" : "happy", blocks.length >= 2 ? "Okay, this week is looking stacked. 🔥" : ADDED_LINES[spec.template](block));
    }
    if (result.error) {
      const done = result.records.length;
      setError(done ? `Added ${done} of ${spec.days.length} days. ${friendly(result.error)}` : friendly(result.error));
      haptic("warning");
      react("oops", "Hmm, that didn't save. Give me a sec and try again?");
      if (done) setEditing({ ...spec, days: spec.days.filter((day) => !result.records.some((record) => record.day === day)) });
      return;
    }
    setEditing(null);
  };

  const ghost = editing ? [{ ...editing, id: "ghost" }] : [];
  const bars = weekBars([...blocks, ...ghost]);
  const today = (new Date().getDay() + 6) % 7;
  const summary = blocks.length
    ? `Your week so far: ${blocks.map((block) => `${block.name}, ${daysLabel(block.days)}, ${clock12(block.start)} to ${clock12(block.end)}`).join("; ")}.`
    : "Your week is empty so far.";
  const overnight = editing ? minutesOf(editing.end) <= minutesOf(editing.start) : false;

  return (
    <StepFrame
      eyebrow="09 · Your week"
      title="Build your week."
      sub="Tap a template, set days and times. Each one goes straight into your Plan."
      footer={
        <>
          {blocks.length > 0 ? (
            <Cta onClick={next} disabled={busy}>{`Next · ${blocks.length} added`}</Cta>
          ) : (
            !editing && <Cta onClick={() => open(templates[0])} feel="tap">Add your first block</Cta>
          )}
          {blocks.length === 0 && !busy && <Quiet onClick={next}>Skip for now</Quiet>}
        </>
      }
    >
      <div className="ob-templates">
        {templates.map((template, index) => {
          const count = blocks.filter((block) => block.template === template.template).length;
          return (
            <Tap
              key={template.template}
              className="ob-template"
              data-tone={template.tone}
              data-on={editing?.template === template.template || undefined}
              aria-label={`${template.label} template${count ? `, ${count} added` : ""}`}
              feel="select"
              squish={0.9}
              disabled={busy}
              style={{ "--i": index } as React.CSSProperties}
              onClick={() => open(template)}
            >
              <span className="ob-template-emoji" aria-hidden="true">{template.emoji}</span>
              <span>{template.label}</span>
              {count > 0 ? <span className="ob-template-count" aria-hidden="true"><Check size={11} weight="bold" /></span> : <Plus size={14} weight="bold" aria-hidden="true" />}
            </Tap>
          );
        })}
        <button type="button" className="ob-template" data-soon disabled aria-label="Snap your timetable, coming soon">
          <Camera size={16} weight="fill" aria-hidden="true" />
          <span>Snap timetable</span>
          <em>soon</em>
        </button>
      </div>

      {editing && (
        <div ref={editor} className="ob-editor ob-rise" data-tone={editing.tone} data-busy={busy || undefined}>
          <div className="ob-editor-head">
            <span className="ob-editor-emoji" aria-hidden="true">{editing.emoji}</span>
            <input
              className="ob-editor-name"
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value.slice(0, 40) })}
              placeholder={editing.template === "custom" ? "Name it: guitar, reading…" : "Name"}
              aria-label="Block name"
              maxLength={40}
              autoCapitalize="sentences"
              spellCheck={false}
            />
            <Tap className="ob-editor-close" aria-label="Close" feel="tap" squish={0.85} disabled={busy} onClick={() => setEditing(null)}>
              <X size={18} weight="bold" />
            </Tap>
          </div>
          <span className="ob-label">Repeats on</span>
          <DayToggles value={editing.days} tone={editing.tone} onChange={(days) => setEditing({ ...editing, days })} />
          <div className="ob-presets">
            {PRESETS.map((preset) => (
              <Tap
                key={preset.label}
                className="ob-preset"
                data-on={preset.days.join() === [...editing.days].sort((a, b) => a - b).join() || undefined}
                feel="select"
                squish={0.9}
                onClick={() => setEditing({ ...editing, days: preset.days })}
              >
                {preset.label}
              </Tap>
            ))}
          </div>
          <div className="ob-times">
            <div>
              <span className="ob-label">From</span>
              <TimeInput label={`${editing.name || "Block"} starts`} value={editing.start} onChange={(start) => setEditing({ ...editing, start })} />
            </div>
            <div>
              <span className="ob-label">To</span>
              <TimeInput label={`${editing.name || "Block"} ends`} value={editing.end} onChange={(end) => setEditing({ ...editing, end })} />
            </div>
          </div>
          {overnight && <p className="ob-hint">Ends the next morning. That works.</p>}
          {error && <p className="ob-error" role="alert">{error}</p>}
          <Tap className="ob-add" data-tone={editing.tone} feel={false} squish={0.95} disabled={busy} aria-busy={busy || undefined} onClick={() => void add()}>
            {busy ? `Adding… ${landed.length}/${editing.days.length}` : `Add ${editing.name.trim() || "it"} · ${editing.days.length} day${editing.days.length === 1 ? "" : "s"}`}
          </Tap>
        </div>
      )}
      {!editing && error && <p className="ob-error" role="alert">{error}</p>}

      <div ref={preview} className="ob-week" role="img" aria-label={summary}>
        <div className="ob-week-hours" aria-hidden="true">
          <span style={{ top: "25%" }}>6a</span>
          <span style={{ top: "50%" }}>12p</span>
          <span style={{ top: "75%" }}>6p</span>
        </div>
        {DAY_LETTERS.map((letter, day) => (
          <div key={day} className="ob-week-col" data-today={day === today || undefined} aria-hidden="true">
            <span className="ob-week-day" title={DAY_NAMES[day]}>{letter}</span>
            <div className="ob-week-track">
              {bars.filter((bar) => bar.day === day).map((bar) => (
                <span
                  key={busy && bar.block === "ghost" && landed.includes(bar.from) ? `${bar.key}-landed` : bar.key}
                  className="ob-bar"
                  data-tone={bar.tone}
                  data-ghost={bar.block === "ghost" && !(busy && landed.includes(bar.from)) ? true : undefined}
                  style={{ top: `${bar.top}%`, height: `${bar.height}%`, "--i": bar.from } as React.CSSProperties}
                />
              ))}
            </div>
          </div>
        ))}
        {blocks.length === 0 && !editing && <span className="ob-week-empty" aria-hidden="true">Your week shows up here</span>}
      </div>

      {blocks.length > 0 && (
        <ul className="ob-added" aria-label="Added to your Plan">
          {blocks.map((block, index) => (
            <li key={block.id} className="ob-rise" data-tone={block.tone} style={{ "--i": index } as React.CSSProperties}>
              <span className="ob-added-emoji" aria-hidden="true">{block.emoji}</span>
              <span className="ob-added-text">
                <strong>{block.name}</strong>
                <small>{daysLabel(block.days)} · {clock12(block.start)}–{clock12(block.end)}</small>
              </span>
              <span className="ob-added-check" aria-label="Added"><Check size={14} weight="bold" /></span>
            </li>
          ))}
        </ul>
      )}
    </StepFrame>
  );
}
