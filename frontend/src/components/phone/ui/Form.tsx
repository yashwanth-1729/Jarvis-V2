"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleNotch, X } from "@phosphor-icons/react";

import type { FormValues } from "@/lib/recordDrafts";
import type { Tone } from "../lib/derive";
import { haptic } from "../lib/haptics";
import { quickTimes, WEEKDAYS, when } from "../lib/time";
import { Tap } from "./Tap";
import { Icon3D } from "./Icon3D";

/** Keep showing the last record while a sheet animates closed. */
export function useRetained<T>(value: T | null): T | null {
  const last = React.useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/** Form state for a sheet, reset each time it opens. */
export function useSheetForm(open: boolean, initial: () => FormValues) {
  const [values, setValues] = React.useState<FormValues>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const initialRef = React.useRef(initial);
  initialRef.current = initial;

  React.useEffect(() => {
    if (!open) return;
    setValues(initialRef.current());
    setError(null);
    setBusy(false);
  }, [open]);

  const set = React.useCallback((name: string, value: FormValues[string]) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  /** Run a save/delete; close on success, stay open with the message on failure. */
  const run = React.useCallback(async (action: () => Promise<void>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      haptic("success");
      done();
    } catch (err) {
      haptic("warning");
      setError(err instanceof Error ? err.message : "That did not save. Try again.");
      setBusy(false);
    }
  }, []);

  return { values, set, error, setError, busy, run };
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="ph-field">
      <span className="ph-field-label">{label}</span>
      {children}
      {hint && <span className="ph-field-hint">{hint}</span>}
    </div>
  );
}

/** The record's name, as the sheet's headline. */
export function BigInput({ value, onChange, placeholder, label, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);
  React.useEffect(() => {
    if (!autoFocus) return;
    // After the sheet has risen, so the keyboard does not fight the spring.
    const timer = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 420);
    return () => window.clearTimeout(timer);
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="ph-big-input"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      maxLength={500}
      onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
    />
  );
}

export function TextInput({ value, onChange, placeholder, label, type = "text", mono = false }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <input
      className="ph-input"
      data-mono={mono || undefined}
      aria-label={label}
      type={type}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={type === "text"}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TextArea({ value, onChange, placeholder, label, rows = 4 }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  rows?: number;
}) {
  return (
    <textarea
      className="ph-input ph-textarea"
      aria-label={label}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  tone?: Tone;
  icon?: React.ReactNode;
}

/** Chunky single-choice chips; the chosen one fills with its colour. */
export function Choices<T extends string>({ value, onChange, options, label, wrap = true }: {
  value: T;
  onChange: (value: T) => void;
  options: Choice<T>[];
  label: string;
  wrap?: boolean;
}) {
  return (
    <div className="ph-choices" data-wrap={wrap} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Tap
            key={option.value}
            role="radio"
            aria-checked={on}
            className="ph-choice"
            data-tone={option.tone ?? "lime"}
            data-on={on}
            feel="select"
            squish={0.92}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </Tap>
        );
      })}
    </div>
  );
}

/** Seven round day toggles, Monday first. */
export function DayPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="ph-days" role="radiogroup" aria-label="Day of the week">
      {WEEKDAYS.map((day, index) => {
        const on = value === String(index);
        return (
          <Tap
            key={day}
            role="radio"
            aria-checked={on}
            aria-label={day}
            className="ph-day"
            data-on={on}
            feel="select"
            squish={0.85}
            onClick={() => onChange(String(index))}
          >
            {on && <span className="ph-day-fill" aria-hidden="true" />}
            <span className="ph-day-letter">{day.slice(0, 1)}</span>
          </Tap>
        );
      })}
    </div>
  );
}

/** A native time input dressed as a big pill. */
export function TimeInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <label className="ph-time">
      <Icon3D name="clock" size={22} />
      <input type="time" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/**
 * A moment in time: quick picks for the usual answers, the native picker
 * for anything else, and the chosen value read back in words.
 */
export function WhenPicker({ value, onChange, allowClear = false, label, quick = true }: {
  value: string;
  onChange: (value: string) => void;
  allowClear?: boolean;
  label: string;
  quick?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const picks = React.useMemo(() => quickTimes(), []);
  const openPicker = () => {
    haptic("tap");
    try {
      input.current?.showPicker?.();
    } catch {
      input.current?.focus();
    }
  };
  return (
    <div className="ph-when">
      <div className="ph-when-picks">
        {quick && picks.map((pick) => (
          <Tap key={pick.label} className="ph-pick" data-on={value === pick.value} feel="select" squish={0.92} onClick={() => onChange(pick.value)}>
            {pick.label}
          </Tap>
        ))}
        <span className="ph-pick ph-pick-custom" data-on={Boolean(value) && !picks.some((pick) => pick.value === value)}>
          <Icon3D name="plan" size={20} />
          {quick ? "Pick" : value ? "Change" : "Choose"}
          <input
            ref={input}
            type="datetime-local"
            aria-label={label}
            value={value ? value.slice(0, 16) : ""}
            onClick={openPicker}
            onChange={(event) => onChange(event.target.value ? `${event.target.value}:00` : "")}
          />
        </span>
      </div>
      <AnimatePresence initial={false}>
        {value && (
          <motion.div
            className="ph-when-value"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Icon3D name="clock" size={20} />
            <span>{when(value)}</span>
            {allowClear && (
              <button type="button" aria-label="Clear the date" onClick={() => onChange("")}>
                <X size={14} weight="bold" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (on: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="ph-switch-row"
      onClick={() => {
        haptic(on ? "toggle-off" : "toggle-on");
        onChange(!on);
      }}
    >
      <span className="ph-switch-copy">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <span className="ph-switch" data-on={on}>
        <span className="ph-switch-knob" />
      </span>
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.p
          role="alert"
          className="ph-form-error ph-shake"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <Icon3D name="warning" size={22} />
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/** Save, plus a delete that always asks first. */
export function SheetActions({ onSave, onDelete, busy, saveLabel = "Save", extra }: {
  onSave: () => void;
  onDelete?: () => void;
  busy: boolean;
  saveLabel?: string;
  extra?: React.ReactNode;
}) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <AnimatePresence mode="wait" initial={false}>
      {confirming && onDelete ? (
        <motion.div
          key="confirm"
          className="ph-actions ph-actions-confirm"
          initial={{ opacity: 0, transform: "translateY(10px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          exit={{ opacity: 0, transform: "translateY(-6px)" }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          <span>Delete this for good?</span>
          <Tap className="ph-btn" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Tap>
          <Tap className="ph-btn ph-btn-danger" feel="warning" onClick={onDelete} disabled={busy}>
            {busy ? <CircleNotch size={18} className="ph-spin" /> : "Yes, delete"}
          </Tap>
        </motion.div>
      ) : (
        <motion.div
          key="actions"
          className="ph-actions"
          initial={{ opacity: 0, transform: "translateY(6px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          exit={{ opacity: 0, transform: "translateY(6px)" }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          {onDelete && (
            <Tap className="ph-btn ph-btn-quiet-danger" aria-label="Delete" onClick={() => setConfirming(true)} disabled={busy}>
              <Icon3D name="trash" size={26} />
            </Tap>
          )}
          {extra}
          <Tap className="ph-btn ph-btn-primary" onClick={onSave} disabled={busy} squish={0.96}>
            {busy ? <CircleNotch size={20} className="ph-spin" /> : saveLabel}
          </Tap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
