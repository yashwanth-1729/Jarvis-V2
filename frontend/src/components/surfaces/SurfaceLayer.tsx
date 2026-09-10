"use client";

/**
 * Picks the instrument for the surface JARVIS asked for, and feeds it live data.
 *
 * One decision worth stating: the panels render from the dashboard state the
 * page already holds, not from the tool's payload — except weather, which has
 * no local store and so travels whole inside the tool result.
 *
 * That is not incidental. If the tasks panel rendered the tool's snapshot, it
 * would freeze at the moment the question was asked: tick a checkbox and the
 * count would not move, because the numbers came from a message rather than the
 * board. Reading live state means the panel and the dashboard behind it can
 * never disagree, and interactions inside it behave exactly like interactions
 * anywhere else — same mutation layer, same refresh, same sync queue.
 */

import * as React from "react";

import { RecordEditor, type RecordValues } from "@/components/RecordEditor";
import { ConfirmSurface } from "@/components/surfaces/ConfirmSurface";
import { MemorySurface } from "@/components/surfaces/MemorySurface";
import { ScheduleSurface } from "@/components/surfaces/ScheduleSurface";
import { SearchSurface } from "@/components/surfaces/SearchSurface";
import { SurfaceHost, type SurfacePlacement } from "@/components/surfaces/SurfaceHost";
import { TaskSurface } from "@/components/surfaces/TaskSurface";
import { WeatherSurface } from "@/components/surfaces/WeatherSurface";
import {
  deleteEvent,
  deleteMemory,
  deleteTask,
  updateEvent,
  updateMemory,
  updateTask,
  type RecordsMode,
} from "@/lib/records";
import {
  readConfirm,
  type SearchResult,
  type SurfaceDescriptor,
  type WeatherData,
} from "@/lib/surfaces";
import type {
  DashboardState,
  Idea,
  Memory,
  ScheduleEvent,
  Task,
  TaskStatus,
} from "@/types";

type Editing =
  | { kind: "task"; record: Task }
  | { kind: "event"; record: ScheduleEvent }
  | { kind: "memory"; record: Memory }
  | { kind: "idea"; record: Idea }
  | null;

interface SurfaceLayerProps {
  surface: SurfaceDescriptor | null;
  state: DashboardState | null;
  mode: RecordsMode;
  onClose: () => void;
  onToggleTask: (id: number, next: TaskStatus) => Promise<void>;
  onChanged: () => void;
  /** Sends a follow-up into the conversation, so a panel can start a new turn. */
  onAsk?: (message: string) => void;
  /** Shell pane by default; `"voice"` mounts it above the full-screen HUD. */
  placement?: SurfacePlacement;
}

export function SurfaceLayer({
  surface,
  state,
  mode,
  onClose,
  onToggleTask,
  onChanged,
  onAsk,
  placement = "pane",
}: SurfaceLayerProps) {
  const [editing, setEditing] = React.useState<Editing>(null);

  if (!surface) return null;

  return (
    <>
      <SurfaceHost surface={surface} onClose={onClose} placement={placement}>
        {surface.kind === "weather" && (
          <WeatherSurface
            data={surface.data as unknown as WeatherData}
            // The tool says so when the user asked for detail; the panel also
            // escalates on its own when the same question comes round again,
            // which is what "ask again and I'll show you more" means.
            detailed={Boolean(surface.data.detailed)}
          />
        )}

        {surface.kind === "search" && (
          <SearchSurface
            query={String(surface.data.query ?? "")}
            results={(surface.data.results as SearchResult[]) ?? []}
            knowledge={
              (surface.data.knowledge as
                | React.ComponentProps<typeof SearchSurface>["knowledge"]
                | undefined) ?? null
            }
            fetched={
              (surface.data.fetched as { title: string; url: string } | undefined) ?? null
            }
            onAsk={(message) => onAsk?.(message)}
          />
        )}

        {surface.kind === "schedule" && (
          <ScheduleSurface
            today={state?.today ?? []}
            weekly={{
              college: state?.schedule.college ?? [],
              routine: state?.schedule.routine ?? [],
              session: state?.schedule.session ?? [],
            }}
            onEdit={(record) => setEditing({ kind: "event", record })}
            initialDay={
              typeof surface.data.day === "number" ? (surface.data.day as number) : 0
            }
          />
        )}

        {surface.kind === "tasks" && (
          <TaskSurface
            tasks={state?.tasks ?? []}
            onToggle={onToggleTask}
            onEdit={(record) => setEditing({ kind: "task", record })}
          />
        )}

        {surface.kind === "memory" && (
          <MemorySurface
            memories={state?.memories ?? []}
            ideas={state?.ideas ?? []}
            onEditMemory={(record) => setEditing({ kind: "memory", record })}
            onEditIdea={(record) => setEditing({ kind: "idea", record })}
          />
        )}

        {/* The one panel that reads its payload rather than live state, and
            must. The others deliberately render from the board so a panel and
            the dashboard can never disagree — but these records are being
            deleted, so by the time the "done" stage arrives they are gone from
            the board. The payload is the only place they still exist. */}
        {surface.kind === "confirm" && <ConfirmSurface payload={readConfirm(surface.data)} />}
      </SurfaceHost>

      {/* The same editor the boards use. A panel that opened its own would be a
          second place for "what does editing mean" to drift. */}
      <RecordEditor
        open={editing !== null}
        title={
          editing?.kind === "task"
            ? "Edit task"
            : editing?.kind === "event"
              ? "Edit schedule entry"
              : editing?.kind === "memory"
                ? "Edit memory"
                : "Edit idea"
        }
        fields={fieldsFor(editing)}
        initial={initialFor(editing)}
        onClose={() => setEditing(null)}
        onSave={async (values: RecordValues) => {
          if (!editing) return;
          await saveEdit(mode, editing, values);
          onChanged();
        }}
        onDelete={
          editing
            ? async () => {
                await deleteEdit(mode, editing);
                onChanged();
              }
            : undefined
        }
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor plumbing                                                             */
/* -------------------------------------------------------------------------- */

type Fields = React.ComponentProps<typeof RecordEditor>["fields"];

function fieldsFor(editing: Editing): Fields {
  switch (editing?.kind) {
    case "task":
      return [
        { kind: "text", name: "title", label: "Task", required: true },
        {
          kind: "select",
          name: "priority",
          label: "Priority",
          options: [
            { value: "HIGH", label: "High" },
            { value: "MEDIUM", label: "Medium" },
            { value: "LOW", label: "Low" },
          ],
        },
        { kind: "datetime", name: "due_date", label: "Due" },
      ];
    case "event":
      return [
        { kind: "text", name: "event_name", label: "Name", required: true },
        { kind: "time", name: "start_time", label: "Starts" },
        { kind: "time", name: "end_time", label: "Ends" },
        { kind: "text", name: "location", label: "Location" },
      ];
    case "memory":
      return [
        { kind: "text", name: "key_concept", label: "Concept", required: true },
        { kind: "textarea", name: "content", label: "What to remember", required: true, rows: 5 },
      ];
    case "idea":
      return [
        { kind: "text", name: "title", label: "Title", required: true },
        { kind: "textarea", name: "description", label: "Detail", rows: 5 },
      ];
    default:
      return [];
  }
}

function initialFor(editing: Editing): RecordValues {
  switch (editing?.kind) {
    case "task":
      return {
        title: editing.record.title,
        priority: editing.record.priority,
        due_date: editing.record.due_date ?? "",
      };
    case "event":
      return {
        event_name: editing.record.event_name,
        start_time: editing.record.start_time ?? "",
        end_time: editing.record.end_time ?? "",
        location: editing.record.location ?? "",
      };
    case "memory":
      return {
        key_concept: editing.record.key_concept,
        content: editing.record.content,
      };
    case "idea":
      return { title: editing.record.title, description: editing.record.description };
    default:
      return {};
  }
}

async function saveEdit(
  mode: RecordsMode,
  editing: NonNullable<Editing>,
  values: RecordValues,
): Promise<void> {
  const text = (key: string) => String(values[key] ?? "").trim();
  switch (editing.kind) {
    case "task":
      await updateTask(mode, editing.record.id, {
        title: text("title"),
        priority: (values.priority as Task["priority"]) ?? "MEDIUM",
        due_date: text("due_date") || null,
        clear_due_date: !text("due_date"),
      });
      return;
    case "event":
      await updateEvent(mode, editing.record.id, {
        event_name: text("event_name"),
        start_time: text("start_time") || null,
        end_time: text("end_time") || null,
        location: text("location") || null,
      });
      return;
    case "memory":
      await updateMemory(mode, editing.record.id, {
        key_concept: text("key_concept"),
        content: text("content"),
      });
      return;
    case "idea":
      // Ideas reuse the memory endpoint shape via the records layer.
      await import("@/lib/records").then((records) =>
        records.updateIdea(mode, editing.record.id, {
          title: text("title"),
          description: String(values.description ?? ""),
        }),
      );
  }
}

async function deleteEdit(mode: RecordsMode, editing: NonNullable<Editing>): Promise<void> {
  switch (editing.kind) {
    case "task":
      return deleteTask(mode, editing.record.id);
    case "event":
      return deleteEvent(mode, editing.record.id);
    case "memory":
      return deleteMemory(mode, editing.record.id);
    case "idea":
      return import("@/lib/records").then((records) =>
        records.deleteIdea(mode, editing.record.id),
      );
  }
}
