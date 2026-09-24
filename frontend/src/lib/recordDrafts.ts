/**
 * Form values → record drafts, with the same validation the desktop editors
 * apply (`DeskTasks`, `ScheduleBoard`, `NotesWorkspace`).
 *
 * Pure functions, so the phone's sheets and any future editor share one set of
 * rules. A thrown `Error` is a message for the person editing, shown in the
 * sheet; nothing is saved.
 */

import { localIso } from "@/lib/schedulePolicy";
import type { EventDraft, IdeaDraft, MemoryDraft, ReminderDraft, TaskDraft } from "@/lib/records";
import type { Memory, NotePage, ScheduleEvent, Task } from "@/types";

export type FormValues = Record<string, string | number | boolean | null | undefined>;

const text = (values: FormValues, key: string) => String(values[key] ?? "").trim();
const optional = (values: FormValues, key: string) => text(values, key) || null;

/* ---------------------------------------------------------------- tasks */

export function taskDraft(values: FormValues): TaskDraft {
  const title = text(values, "title");
  if (!title) throw new Error("Give the task a name.");
  return {
    title,
    priority: (text(values, "priority") as Task["priority"]) || "MEDIUM",
    due_date: optional(values, "due_date"),
    category: optional(values, "category"),
  };
}

/* ------------------------------------------------------------- schedule */

export function eventDraft(values: FormValues): EventDraft {
  const name = text(values, "event_name");
  if (!name) throw new Error("Give this entry a name.");
  const day = text(values, "day_of_week");
  const draft: EventDraft = {
    event_name: name,
    kind: (text(values, "kind") as ScheduleEvent["kind"]) || "SESSION",
    day_of_week: day === "" ? null : Number(day),
    start_time: optional(values, "start_time"),
    end_time: optional(values, "end_time"),
    time_start: optional(values, "time_start"),
    time_end: optional(values, "time_end"),
    location: optional(values, "location"),
    notes: optional(values, "notes"),
  };
  if (draft.kind === "SESSION") {
    if (!draft.time_start || !draft.time_end || new Date(draft.time_end) <= new Date(draft.time_start)) {
      throw new Error("Choose an end time after the block starts.");
    }
    draft.day_of_week = null;
    draft.start_time = draft.end_time = null;
  } else {
    draft.time_start = draft.time_end = null;
  }
  return draft;
}

export function reminderDraft(values: FormValues): ReminderDraft {
  const draft = { text: text(values, "text"), due_at: text(values, "due_at") };
  if (!draft.text) throw new Error("Say what to remind you about.");
  if (!draft.due_at) throw new Error("Choose when.");
  return draft;
}

/* ---------------------------------------------------------------- notes */

export function ideaDraft(values: FormValues): IdeaDraft {
  const title = text(values, "title");
  if (!title) throw new Error("Give the note a title.");
  return { title, description: text(values, "description"), page_uid: optional(values, "page_uid") };
}

export function memoryDraft(values: FormValues): MemoryDraft {
  const key = text(values, "key_concept");
  const content = text(values, "content");
  if (!key) throw new Error("Give the memory a title.");
  if (!content) throw new Error("Write what JARVIS should remember.");
  const memory_type = text(values, "memory_type") as Memory["memory_type"];
  const temporary = values.duration === "temporary";
  let expires_at: string | null = temporary ? text(values, "expires_at") || null : null;
  // Working context without an end is still temporary: eight hours, as the
  // backend does for the same role.
  if (memory_type === "WORKING" && !expires_at) expires_at = localIso(new Date(Date.now() + 8 * 60 * 60 * 1000));
  if (temporary && (!expires_at || !(new Date(expires_at).getTime() > Date.now()))) {
    throw new Error("Choose a future date and time to forget this memory.");
  }
  return {
    key_concept: key,
    content,
    expires_at,
    memory_type,
    memory_status: text(values, "memory_status") as Memory["memory_status"],
    importance: Number(values.importance ?? 0.65),
    pinned: String(values.pinned) === "true",
  };
}

/** A page name: 1-80 characters and unique (ignoring case) among the pages. */
export function pageTitle(values: FormValues, pages: NotePage[], editing: NotePage | null): string {
  const title = text(values, "title");
  if (!title || title.length > 80) throw new Error("Use a page name between 1 and 80 characters.");
  const clash = pages.some(
    (page) => page.title.toLocaleLowerCase() === title.toLocaleLowerCase() && page.uid !== editing?.uid,
  );
  if (clash) throw new Error("A page already has that name.");
  return title;
}
