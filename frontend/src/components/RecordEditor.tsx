"use client";

/**
 * One dialog for editing any record on the boards.
 *
 * Tasks, schedule entries, ideas and memories all need the same six things:
 * a few typed fields, validation on the one or two that are required, a save
 * that reports what went wrong rather than closing silently, a delete behind a
 * confirmation, Escape, and a focus trap. Written once because four
 * near-identical dialogs is how they end up drifting — one gets the confirm
 * step and the others quietly do not.
 *
 * Callers describe their fields; this owns everything else.
 */

import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type FieldSpec = (
  | { kind: "text"; name: string; label: string; required?: boolean; placeholder?: string }
  | { kind: "textarea"; name: string; label: string; required?: boolean; placeholder?: string; rows?: number }
  | { kind: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { kind: "datetime"; name: string; label: string }
  | { kind: "time"; name: string; label: string }
  | { kind: "weekday"; name: string; label: string }
) & { visibleWhen?: { field: string; values: readonly string[] } };

export type RecordValues = Record<string, string | number | null | undefined>;

const WEEKDAYS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

interface RecordEditorProps {
  open: boolean;
  title: string;
  fields: FieldSpec[];
  initial?: RecordValues;
  /** Absent for a new record; present enables the delete control. */
  onDelete?: () => Promise<void>;
  onSave: (values: RecordValues) => Promise<void>;
  onClose: () => void;
  deleteLabel?: string;
}

export function RecordEditor({
  open,
  title,
  fields,
  initial,
  onSave,
  onDelete,
  onClose,
  deleteLabel = "Delete",
}: RecordEditorProps) {
  const [values, setValues] = React.useState<RecordValues>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [retained, setRetained] = React.useState(open);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const firstFieldRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    if (open) { setRetained(true); return; }
    const timer = window.setTimeout(() => setRetained(false), 190);
    return () => window.clearTimeout(timer);
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const origin = document.activeElement as HTMLElement | null;
    return () => { if (origin?.isConnected) origin.focus(); };
  }, [open]);

  // Reset on open, not on mount: the same dialog instance is reused for every
  // row, so leaving state behind would show the previous record's values for a
  // frame — long enough to save them onto the wrong record.
  React.useEffect(() => {
    if (!open) return;
    setValues({ ...(initial ?? {}) });
    setError(null);
    setConfirmingDelete(false);
    setBusy(false);
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
    // `initial` is a fresh object each render; keying on `open` is what makes
    // this run once per opening rather than on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      // A dialog you can tab out of is not a dialog. Cycle within the panel.
      if (event.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open && !retained) return null;

  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  const visibleFields = fields.filter((field) => !field.visibleWhen ||
    field.visibleWhen.values.includes(String(values[field.visibleWhen.field] ?? "")));

  const missing = visibleFields.filter(
    (field) =>
      "required" in field &&
      field.required &&
      !String(values[field.name] ?? "").trim(),
  );

  const save = async () => {
    if (missing.length) {
      setError(`${missing[0].label} is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(values);
      onClose();
    } catch (err) {
      // Stay open. Closing on failure loses whatever was typed, and the user
      // has no idea whether it saved.
      setError(err instanceof Error ? err.message : "Could not save that.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that.");
      setBusy(false);
    }
  };

  return (
    <div
      className="record-backdrop mobile-ui fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4"
      data-open={open}
      aria-hidden={!open || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "record-dialog flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface-1",
          // Keep the header and actions fixed inside a viewport-sized dialog.
          "border border-line",
          "shadow-2xl animate-fade-in",
          // Room for the phone's gesture bar; a save button under the home
          // indicator is unreachable.
          "pb-[env(safe-area-inset-bottom)]",
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="font-display text-[20px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5">
          {visibleFields.map((field, index) => {
            const value = String(values[field.name] ?? "");
            const id = `field-${field.name}`;
            const common = {
              id,
              value,
              onChange: (
                e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
              ) => set(field.name, e.target.value),
            };
            return (
              <label key={field.name} htmlFor={id} className="record-field block space-y-1.5">
                <span className="text-[13px] font-medium text-ink-muted">
                  {field.label}
                  {"required" in field && field.required ? " *" : ""}
                </span>

                {field.kind === "text" && (
                  <Input
                    {...common}
                    ref={index === 0 ? (firstFieldRef as React.Ref<HTMLInputElement>) : undefined}
                    placeholder={field.placeholder}
                    className="h-11 sm:h-9"
                  />
                )}
                {field.kind === "textarea" && (
                  <Textarea
                    {...common}
                    ref={index === 0 ? (firstFieldRef as React.Ref<HTMLTextAreaElement>) : undefined}
                    placeholder={field.placeholder}
                    rows={field.rows ?? 3}
                  />
                )}
                {field.kind === "datetime" && (
                  // The API stores local-naive ISO, which is exactly what a
                  // datetime-local input produces — bar the seconds.
                  <Input
                    {...common}
                    type="datetime-local"
                    value={value ? value.slice(0, 16) : ""}
                    onChange={(e) =>
                      set(field.name, e.target.value ? `${e.target.value}:00` : "")
                    }
                    className="h-11 sm:h-9"
                  />
                )}
                {field.kind === "time" && (
                  <Input {...common} type="time" className="h-11 sm:h-9" />
                )}
                {(field.kind === "select" || field.kind === "weekday") && (
                  <select
                    {...common}
                    className={cn(
                      "h-11 w-full rounded border border-line bg-surface-2 px-2.5 text-base text-ink sm:h-9",
                      "transition-colors duration-150 focus:border-accent/40 focus:outline-none",
                    )}
                    style={{ colorScheme: "dark" }}
                  >
                    {field.kind === "weekday" ? (
                      <>
                        <option value="">— none —</option>
                        {WEEKDAYS.map((day, i) => (
                          <option key={day} value={String(i)}>
                            {day}
                          </option>
                        ))}
                      </>
                    ) : (
                      field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))
                    )}
                  </select>
                )}
              </label>
            );
          })}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          {onDelete &&
            (confirmingDelete ? (
              <div className="flex w-full flex-wrap items-center gap-2">
                <span className="mr-auto text-sm text-ink-dim">Delete this record?</span>
                <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                  Yes, delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  No
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
                className="text-critical hover:bg-critical/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleteLabel}
              </Button>
            ))}

          {!confirmingDelete && <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </div>}
        </footer>
      </div>
    </div>
  );
}
