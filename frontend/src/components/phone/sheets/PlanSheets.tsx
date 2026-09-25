"use client";

import * as React from "react";
import { GraduationCap, Hourglass, Repeat } from "@phosphor-icons/react";

import { createEvent, createReminder, deleteEvent, deleteReminder, updateEvent, updateReminder } from "@/lib/records";
import { eventDraft, reminderDraft } from "@/lib/recordDrafts";
import { parseLocal } from "@/lib/utils";
import type { Reminder, ScheduleEvent } from "@/types";
import { isoLocal } from "../lib/time";
import { useAppData } from "../PhoneContext";
import { BigInput, Choices, DayPicker, Field, FormError, SheetActions, TextArea, TextInput, TimeInput, useRetained, useSheetForm, WhenPicker } from "../ui/Form";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";

export type EventTarget = ScheduleEvent | { kind: ScheduleEvent["kind"]; day?: number } | null;

function isEvent(value: EventTarget): value is ScheduleEvent {
  return value !== null && "event_name" in value;
}

const DURATIONS = [30, 60, 90, 120, 180];

/** Add or edit a routine, class or one-off block. */
export function EventSheet({ target, onClose }: { target: EventTarget; onClose: () => void }) {
  const { app, mode } = useAppData();
  const shown = useRetained(target);
  const event = shown && isEvent(shown) ? shown : null;
  const form = useSheetForm(target !== null, () =>
    event
      ? {
          event_name: event.event_name,
          kind: event.kind,
          day_of_week: event.day_of_week ?? "",
          start_time: event.start_time ?? "",
          end_time: event.end_time ?? "",
          time_start: event.time_start ?? "",
          time_end: event.time_end ?? "",
          location: event.location ?? "",
          notes: event.notes ?? "",
        }
      : {
          event_name: "",
          kind: shown?.kind ?? "ROUTINE",
          day_of_week: shown && !isEvent(shown) && shown.day !== undefined ? String(shown.day) : "",
          start_time: "",
          end_time: "",
          time_start: "",
          time_end: "",
          location: "",
          notes: "",
        },
  );
  const { values, set } = form;
  const kind = String(values.kind) as ScheduleEvent["kind"];
  const weekly = kind !== "SESSION";

  const startAt = parseLocal(String(values.time_start || ""));
  const endAfter = (minutes: number) => {
    if (!startAt) return;
    set("time_end", isoLocal(new Date(startAt.getTime() + minutes * 60_000)));
  };
  const chosenDuration = (() => {
    const end = parseLocal(String(values.time_end || ""));
    return startAt && end ? Math.round((end.getTime() - startAt.getTime()) / 60_000) : null;
  })();

  const save = () =>
    form.run(async () => {
      const draft = eventDraft(values);
      if (event) await updateEvent(mode, event.uid ?? event.id, draft);
      else await createEvent(mode, draft);
      app.handleRecordChanged();
    }, onClose);

  const remove = event
    ? () =>
        form.run(async () => {
          await deleteEvent(mode, event.uid ?? event.id);
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  const tone = kind === "COLLEGE" ? "sky" : kind === "ROUTINE" ? "lilac" : "orange";

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={event ? "Edit plan" : "New plan"}
      eyebrow={kind === "COLLEGE" ? "Class · weekly" : kind === "ROUTINE" ? "Routine · weekly" : "Block · one-off"}
      tone={tone}
      footer={<SheetActions onSave={() => void save()} onDelete={remove ? () => void remove() : undefined} busy={form.busy} saveLabel={event ? "Save" : "Add plan"} />}
    >
      <BigInput label="Name" placeholder={kind === "COLLEGE" ? "Data structures lecture" : kind === "ROUTINE" ? "Gym, reading, side project…" : "Deep work block"} value={String(values.event_name ?? "")} onChange={(value) => set("event_name", value)} autoFocus={!event} />
      <Field label="Kind">
        <Choices
          label="Kind"
          value={kind}
          onChange={(value) => set("kind", value)}
          options={[
            { value: "COLLEGE", label: "Class", tone: "sky", icon: <GraduationCap size={17} weight="fill" /> },
            { value: "ROUTINE", label: "Routine", tone: "lilac", icon: <Repeat size={17} weight="bold" /> },
            { value: "SESSION", label: "Block", tone: "orange", icon: <Hourglass size={17} weight="fill" /> },
          ]}
        />
      </Field>
      {weekly ? (
        <>
          <Field label="Every">
            <DayPicker value={String(values.day_of_week ?? "")} onChange={(value) => set("day_of_week", value)} />
          </Field>
          <div className="ph-field-row">
            <Field label="Starts">
              <TimeInput label="Starts" value={String(values.start_time ?? "")} onChange={(value) => set("start_time", value)} />
            </Field>
            <Field label="Ends">
              <TimeInput label="Ends" value={String(values.end_time ?? "")} onChange={(value) => set("end_time", value)} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Starts">
            <WhenPicker label="Block starts" value={String(values.time_start ?? "")} onChange={(value) => set("time_start", value)} />
          </Field>
          <Field label="Lasts" hint="The block clears itself when it ends.">
            <div className="ph-choices" data-wrap="true">
              {DURATIONS.map((minutes) => (
                <Tap key={minutes} className="ph-choice" data-tone="orange" data-on={chosenDuration === minutes} feel="select" squish={0.92} disabled={!startAt} onClick={() => endAfter(minutes)}>
                  {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
                </Tap>
              ))}
            </div>
            <WhenPicker label="Block ends" quick={false} value={String(values.time_end ?? "")} onChange={(value) => set("time_end", value)} />
          </Field>
        </>
      )}
      <Field label="Where">
        <TextInput label="Location" placeholder="Room C410" value={String(values.location ?? "")} onChange={(value) => set("location", value)} />
      </Field>
      <Field label="Notes">
        <TextArea label="Notes" rows={2} placeholder="Anything to remember" value={String(values.notes ?? "")} onChange={(value) => set("notes", value)} />
      </Field>
      <FormError message={form.error} />
    </Sheet>
  );
}

export type ReminderTarget = Reminder | "new" | null;

/** Add or edit a one-off reminder. */
export function ReminderSheet({ target, onClose }: { target: ReminderTarget; onClose: () => void }) {
  const { app, reloadReminders } = useAppData();
  const shown = useRetained(target);
  const reminder = shown && shown !== "new" ? shown : null;
  const form = useSheetForm(target !== null, () => ({ text: reminder?.text ?? "", due_at: reminder?.due_at ?? "" }));
  const { values, set } = form;

  const save = () =>
    form.run(async () => {
      const draft = reminderDraft(values);
      if (reminder) await updateReminder(reminder.id, draft);
      else await createReminder(draft);
      await reloadReminders();
      app.handleRecordChanged();
    }, onClose);

  const remove = reminder
    ? () =>
        form.run(async () => {
          await deleteReminder(reminder.id);
          await reloadReminders();
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={reminder ? "Edit reminder" : "New reminder"}
      eyebrow="Ping me"
      tone="pink"
      footer={<SheetActions onSave={() => void save()} onDelete={remove ? () => void remove() : undefined} busy={form.busy} saveLabel={reminder ? "Save" : "Remind me"} />}
    >
      <BigInput label="Remind me to" placeholder="Remind me to…" value={String(values.text ?? "")} onChange={(value) => set("text", value)} autoFocus={!reminder} />
      <Field label="When">
        <WhenPicker label="Reminder time" value={String(values.due_at ?? "")} onChange={(value) => set("due_at", value)} />
      </Field>
      <FormError message={form.error} />
    </Sheet>
  );
}
