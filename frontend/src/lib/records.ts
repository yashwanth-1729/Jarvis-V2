/**
 * Creating, editing and deleting records by hand.
 *
 * Everything on the boards used to be read-only unless you asked JARVIS to
 * change it, which is fine for "add a task to call the dentist" and absurd for
 * fixing a typo. This is the layer that makes them editable.
 *
 * It exists because there are two authoritative stores and the components must
 * not know which one they are talking to. On the desktop the backend's SQLite
 * is the truth and these go over HTTP; on mobile IndexedDB is the truth and
 * they go straight to the local store and queue for sync. Every function here
 * takes the same arguments either way, so a component never branches on it —
 * exactly the split `handleToggleTask` already makes, generalised so it does
 * not have to be re-made for every field.
 *
 * The semantics on both sides are the ones in `backend/app/db/crud.py`, because
 * the same record is editable from either device and from the agent. Completing
 * a task removes it; a delete leaves a tombstone. Two implementations that
 * disagreed would show up days later as a row returning from the dead.
 */

import { apiDelete, apiPatch, apiPost } from "@/lib/api";
import {
  deleteRowLocally,
  updateRowLocally,
  type RecordRef,
} from "@/lib/localMutations";
import { type SyncedTable, listRows, putRows } from "@/lib/localdb";
import { numericId } from "@/lib/localDashboard";
import { decodeMemoryContent, encodeMemoryContent, reviseMemoryContent } from "@/lib/memory";
import { nowIso } from "@/lib/syncClient";
import type { Idea, Memory, NotePage, Reminder, ScheduleEvent, Task } from "@/types";

/** A fresh uid for a locally-created row, matching the backend's format. */
function newUid(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  // Older WebViews: good enough for a local identifier, and the uid only has
  // to be unique, never unguessable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function createLocally(
  table: SyncedTable,
  fields: Record<string, unknown>,
): Promise<void> {
  const stamp = nowIso();
  await putRows(table, [
    { uid: newUid(), created_at: stamp, updated_at: stamp, ...fields } as never,
  ]);
}

export interface RecordsMode {
  /** True when IndexedDB is authoritative (the mobile build). */
  local: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export interface TaskDraft {
  title: string;
  due_date?: string | null;
  priority?: Task["priority"];
  category?: string | null;
}

export async function createTask({ local }: RecordsMode, draft: TaskDraft): Promise<void> {
  if (local) {
    await createLocally("tasks", {
      title: draft.title.trim(),
      category: (draft.category || "GENERAL").toUpperCase(),
      priority: draft.priority ?? "MEDIUM",
      status: "PENDING",
      due_date: draft.due_date ?? null,
    });
    return;
  }
  await apiPost("/api/tasks", draft);
}

export interface TaskEdit extends Partial<TaskDraft> {
  status?: Task["status"];
  clear_due_date?: boolean;
}

export async function updateTask(
  { local }: RecordsMode,
  id: RecordRef,
  changes: TaskEdit,
): Promise<void> {
  if (local) {
    const { clear_due_date, ...rest } = changes;
    await updateRowLocally("tasks", id, {
      ...rest,
      ...(clear_due_date ? { due_date: null } : {}),
    });
    return;
  }
  await apiPatch(`/api/tasks/${id}`, changes);
}

export async function deleteTask({ local }: RecordsMode, id: RecordRef): Promise<void> {
  if (local) {
    await deleteRowLocally("tasks", id);
    return;
  }
  await apiDelete(`/api/tasks/${id}`);
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

export interface EventDraft {
  event_name: string;
  kind?: ScheduleEvent["kind"];
  day_of_week?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  time_start?: string | null;
  time_end?: string | null;
  location?: string | null;
  notes?: string | null;
}

export async function createEvent({ local }: RecordsMode, draft: EventDraft): Promise<void> {
  if (local) {
    await createLocally("schedules", {
      event_name: draft.event_name.trim(),
      kind: draft.kind ?? "SESSION",
      day_of_week: draft.day_of_week ?? null,
      start_time: draft.start_time ?? null,
      end_time: draft.end_time ?? null,
      time_start: draft.time_start ?? null,
      time_end: draft.time_end ?? null,
      location: draft.location ?? null,
      notes: draft.notes ?? null,
    });
    return;
  }
  await apiPost("/api/schedule", draft);
}

export async function updateEvent(
  { local }: RecordsMode,
  id: RecordRef,
  changes: Partial<EventDraft>,
): Promise<void> {
  if (local) {
    await updateRowLocally("schedules", id, changes);
    return;
  }
  await apiPatch(`/api/schedule/${id}`, changes);
}

export async function deleteEvent({ local }: RecordsMode, id: RecordRef): Promise<void> {
  if (local) {
    await deleteRowLocally("schedules", id);
    return;
  }
  await apiDelete(`/api/schedule/${id}`);
}

/* -------------------------------------------------------------------------- */
/* Ideas                                                                       */
/* -------------------------------------------------------------------------- */

export interface IdeaDraft {
  page_uid?: string | null;
  title: string;
  description?: string;
  tags?: string;
  status?: Idea["status"];
}

export async function createIdea({ local }: RecordsMode, draft: IdeaDraft): Promise<void> {
  if (local) {
    await createLocally("ideas", {
      title: draft.title.trim(),
      description: draft.description ?? "",
      tags: draft.tags ?? "",
      status: draft.status ?? "DRAFT",
      page_uid: draft.page_uid ?? null,
    });
    return;
  }
  await apiPost("/api/ideas", draft);
}

export async function updateIdea(
  { local }: RecordsMode,
  id: RecordRef,
  changes: Partial<IdeaDraft>,
): Promise<void> {
  if (local) {
    await updateRowLocally("ideas", id, changes);
    return;
  }
  await apiPatch(`/api/ideas/${id}`, changes);
}

export async function deleteIdea({ local }: RecordsMode, id: RecordRef): Promise<void> {
  if (local) {
    await deleteRowLocally("ideas", id);
    return;
  }
  await apiDelete(`/api/ideas/${id}`);
}

/* -------------------------------------------------------------------------- */
/* Memories                                                                    */
/* -------------------------------------------------------------------------- */

export interface MemoryDraft {
  expires_at?: string | null;
  key_concept: string;
  content: string;
  category?: Memory["category"];
  memory_type?: Memory["memory_type"];
  memory_status?: Memory["memory_status"];
  confidence?: number;
  importance?: number;
  pinned?: boolean;
  tags?: string[];
}

export async function createMemory({ local }: RecordsMode, draft: MemoryDraft): Promise<void> {
  if (local) {
    const stamp = nowIso();
    await createLocally("memories", {
      key_concept: draft.key_concept.trim(),
      content: encodeMemoryContent(draft.content, {
        type: draft.memory_type,
        status: draft.memory_status,
        confidence: draft.confidence,
        importance: draft.importance,
        pinned: draft.pinned,
        tags: draft.tags,
        source_kind: "manual_ui",
        valid_from: stamp,
      }),
      category: draft.category ?? "LONG_TERM",
      expires_at: draft.expires_at ?? null,
    });
    return;
  }
  await apiPost("/api/memories", draft);
}

export async function updateMemory(
  { local }: RecordsMode,
  id: RecordRef,
  changes: Partial<MemoryDraft>,
): Promise<void> {
  if (local) {
    const rows = await listRows("memories");
    const existing = rows.find(row => typeof id === "string" ? row.uid === id : numericId(row.uid) === id);
    if (!existing) return;
    const decoded = decodeMemoryContent(existing.content, {
      category: existing.category,
      expiresAt: existing.expires_at,
      createdAt: existing.created_at,
    });
    const body = changes.content ?? decoded.body;
    const content = reviseMemoryContent(
      existing.content,
      body,
      {
        type: changes.memory_type,
        status: changes.memory_status,
        confidence: changes.confidence,
        importance: changes.importance,
        pinned: changes.pinned,
        tags: changes.tags,
        source_kind: "manual_ui",
      },
      {
        category: changes.category ?? existing.category,
        expiresAt: changes.expires_at ?? existing.expires_at,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      },
    );
    const storedChanges: Record<string, unknown> = {};
    if (changes.key_concept !== undefined) storedChanges.key_concept = changes.key_concept;
    if (changes.category !== undefined) storedChanges.category = changes.category;
    if (changes.expires_at !== undefined) storedChanges.expires_at = changes.expires_at;
    storedChanges.content = content;
    await updateRowLocally("memories", id, storedChanges);
    return;
  }
  await apiPatch(`/api/memories/${id}`, changes);
}

export async function deleteMemory({ local }: RecordsMode, id: RecordRef): Promise<void> {
  if (local) {
    await deleteRowLocally("memories", id);
    return;
  }
  await apiDelete(`/api/memories/${id}`);
}

export async function saveNotePage({local}: RecordsMode, page: Pick<NotePage, "title" | "kind"> & Partial<NotePage>): Promise<NotePage> {
  const stamp = nowIso();
  const row = {...page, title: page.title.trim(), uid: page.uid || newUid(), created_at: page.created_at || stamp, updated_at: stamp} as NotePage;
  if (!row.title) throw new Error("Give this page a name.");
  if (local) { await putRows("note_pages", [row as unknown as import("@/lib/localdb").SyncRow]); return row; }
  return apiPost<NotePage>("/api/note-pages", row);
}

export async function deleteNotePage({local}: RecordsMode, page: NotePage): Promise<void> {
  if (page.kind !== "CUSTOM") throw new Error("Default pages cannot be deleted.");
  if (local) {
    const ideas = await import("@/lib/localdb").then(module => module.listRows("ideas"));
    const moved = ideas.filter(row => row.page_uid === page.uid).map(row => ({...row, page_uid: null, updated_at: nowIso()}));
    if (moved.length) await putRows("ideas", moved);
    await deleteRowLocally("note_pages", page.uid);
    return;
  }
  await apiDelete(`/api/note-pages/${page.uid}`);
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/*                                                                              */
/* No `RecordsMode` here, on purpose. Unlike the five stores above, reminders  */
/* are never mirrored into IndexedDB or Supabase — each device fires its own  */
/* alarms off its own local backend (see `fetchReminders` in `lib/api.ts`),   */
/* so there is only ever one way to reach them, on desktop or mobile alike.   */
/* -------------------------------------------------------------------------- */

export interface ReminderDraft {
  text: string;
  /** Absolute datetime, ISO 8601 local. */
  due_at: string;
}

export async function createReminder(draft: ReminderDraft): Promise<Reminder> {
  return apiPost<Reminder>("/api/reminders", draft);
}

export async function updateReminder(
  id: number,
  changes: Partial<ReminderDraft>,
): Promise<Reminder> {
  return apiPatch<Reminder>(`/api/reminders/${id}`, changes);
}

export async function deleteReminder(id: number): Promise<void> {
  await apiDelete(`/api/reminders/${id}`);
}
