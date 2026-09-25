"use client";

import * as React from "react";

import { createIdea, createMemory, deleteIdea, deleteMemory, deleteNotePage, saveNotePage, updateIdea, updateMemory } from "@/lib/records";
import { ideaDraft, memoryDraft, pageTitle } from "@/lib/recordDrafts";
import type { Idea, Memory, NotePage } from "@/types";
import { MEMORY_LABEL, MEMORY_TONE, type Tone } from "../lib/derive";
import { useAppData, type MemoryView } from "../PhoneContext";
import { BigInput, Choices, Field, FormError, SheetActions, Switch, TextArea, useRetained, useSheetForm, WhenPicker } from "../ui/Form";
import { Sheet } from "../ui/Sheet";

export type MemoryTarget = Memory | { new: true; temporary: boolean; view: MemoryView } | null;

const ROLES: Memory["memory_type"][] = ["SEMANTIC", "PROCEDURAL", "EPISODIC", "PROSPECTIVE", "WORKING", "REFLECTIVE"];

/** Add or edit something JARVIS remembers. */
export function MemorySheet({ target, onClose }: { target: MemoryTarget; onClose: () => void }) {
  const { app, mode } = useAppData();
  const shown = useRetained(target);
  const memory = shown && !("new" in shown) ? shown : null;
  const fresh = shown && "new" in shown ? shown : null;
  const form = useSheetForm(target !== null, () =>
    memory
      ? {
          key_concept: memory.key_concept,
          content: memory.content,
          memory_type: memory.memory_type,
          memory_status: memory.memory_status,
          importance: String(memory.importance),
          pinned: String(memory.pinned),
          duration: memory.expires_at ? "temporary" : "permanent",
          expires_at: memory.expires_at ?? "",
        }
      : {
          key_concept: "",
          content: "",
          memory_type: fresh?.temporary ? "PROCEDURAL" : fresh && fresh.view !== "ALL" && fresh.view !== "REVIEW" ? fresh.view : "SEMANTIC",
          memory_status: "ACTIVE",
          importance: "0.65",
          pinned: "false",
          duration: fresh?.temporary ? "temporary" : "permanent",
          expires_at: "",
        },
  );
  const { values, set } = form;

  const save = () =>
    form.run(async () => {
      const draft = memoryDraft(values);
      if (memory) await updateMemory(mode, memory.uid ?? memory.id, draft);
      else await createMemory(mode, draft);
      app.handleRecordChanged();
    }, onClose);

  const remove = memory
    ? () =>
        form.run(async () => {
          await deleteMemory(mode, memory.uid ?? memory.id);
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  const role = String(values.memory_type) as Memory["memory_type"];

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={memory ? "Edit memory" : "New memory"}
      eyebrow={memory?.memory_status === "CANDIDATE" ? "Needs your review" : "JARVIS will remember"}
      tone={MEMORY_TONE[role] ?? "lilac"}
      footer={<SheetActions onSave={() => void save()} onDelete={remove ? () => void remove() : undefined} busy={form.busy} saveLabel={memory ? "Save" : "Remember"} />}
    >
      <BigInput label="Title" placeholder="Name this memory" value={String(values.key_concept ?? "")} onChange={(value) => set("key_concept", value)} autoFocus={!memory} />
      <Field label="What to remember">
        <TextArea label="What should JARVIS remember?" rows={5} placeholder="The details, in your words" value={String(values.content ?? "")} onChange={(value) => set("content", value)} />
      </Field>
      <Field label="Kind of memory">
        <Choices
          label="Memory role"
          value={role}
          onChange={(value) => set("memory_type", value)}
          options={ROLES.map((value) => ({ value, label: MEMORY_LABEL[value], tone: MEMORY_TONE[value] as Tone }))}
        />
      </Field>
      <Field label="State">
        <Choices
          label="State"
          value={String(values.memory_status) as Memory["memory_status"]}
          onChange={(value) => set("memory_status", value)}
          options={[
            { value: "ACTIVE", label: "Active", tone: "lime" },
            { value: "CANDIDATE", label: "Review first", tone: "amber" },
            { value: "ARCHIVED", label: "Archived", tone: "lilac" },
          ]}
        />
      </Field>
      <Field label="Importance">
        <Choices
          label="Importance"
          value={String(values.importance)}
          onChange={(value) => set("importance", value)}
          options={[
            { value: "0.4", label: "Useful", tone: "mint" },
            { value: "0.65", label: "Important", tone: "amber" },
            { value: "0.85", label: "Critical", tone: "pink" },
          ]}
        />
      </Field>
      <Switch
        label="Always consider"
        hint="Pinned memories are weighed in every answer"
        on={String(values.pinned) === "true"}
        onChange={(on) => set("pinned", String(on))}
      />
      <Field label="Keep it">
        <Choices
          label="Keep this memory"
          value={String(values.duration)}
          onChange={(value) => set("duration", value)}
          options={[
            { value: "permanent", label: "Until I delete it", tone: "lilac" },
            { value: "temporary", label: "Until a date", tone: "mint" },
          ]}
        />
        {values.duration === "temporary" && (
          <WhenPicker label="Forget after" value={String(values.expires_at ?? "")} onChange={(value) => set("expires_at", value)} />
        )}
      </Field>
      <FormError message={form.error} />
    </Sheet>
  );
}

export type NoteTarget = Idea | { new: true; page: string } | null;

/** Add or edit a note on a notes page. */
export function NoteSheet({ target, onClose, pages }: { target: NoteTarget; onClose: () => void; pages: NotePage[] }) {
  const { app, mode } = useAppData();
  const shown = useRetained(target);
  const idea = shown && !("new" in shown) ? shown : null;
  const form = useSheetForm(target !== null, () =>
    idea
      ? { title: idea.title, description: idea.description, page_uid: idea.page_uid || "notes-other" }
      : { title: "", description: "", page_uid: shown && "new" in shown ? shown.page : "notes-other" },
  );
  const { values, set } = form;
  const notePages = pages.filter((page) => page.kind === "OTHER" || page.kind === "CUSTOM");

  const save = () =>
    form.run(async () => {
      const draft = ideaDraft(values);
      if (idea) await updateIdea(mode, idea.uid ?? idea.id, draft);
      else await createIdea(mode, draft);
      app.handleRecordChanged();
    }, onClose);

  const remove = idea
    ? () =>
        form.run(async () => {
          await deleteIdea(mode, idea.uid ?? idea.id);
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={idea ? "Edit note" : "New note"}
      eyebrow="Keep this thought"
      tone="orange"
      footer={<SheetActions onSave={() => void save()} onDelete={remove ? () => void remove() : undefined} busy={form.busy} saveLabel={idea ? "Save" : "Add note"} />}
    >
      <BigInput label="Title" placeholder="Give it a title" value={String(values.title ?? "")} onChange={(value) => set("title", value)} autoFocus={!idea} />
      <Field label="Note">
        <TextArea label="Note" rows={7} placeholder="Dump it all here…" value={String(values.description ?? "")} onChange={(value) => set("description", value)} />
      </Field>
      {notePages.length > 1 && (
        <Field label="Page">
          <Choices
            label="Page"
            value={String(values.page_uid)}
            onChange={(value) => set("page_uid", value)}
            options={notePages.map((page) => ({ value: page.uid, label: page.title, tone: "orange" as Tone }))}
          />
        </Field>
      )}
      <FormError message={form.error} />
    </Sheet>
  );
}

export type PageTarget = NotePage | "new" | null;

/** Create a notes page, rename any page, or delete a custom one. */
export function PageSheet({ target, onClose, pages, onSaved, onDeleted }: {
  target: PageTarget;
  onClose: () => void;
  pages: NotePage[];
  onSaved: (page: NotePage) => void;
  onDeleted?: () => void;
}) {
  const { app, mode } = useAppData();
  const shown = useRetained(target);
  const page = shown && shown !== "new" ? shown : null;
  const form = useSheetForm(target !== null, () => ({ title: page?.title ?? "" }));

  const save = () =>
    form.run(async () => {
      const title = pageTitle(form.values, pages, page);
      const saved = await saveNotePage(mode, page ? { ...page, title } : { title, kind: "CUSTOM" });
      onSaved(saved);
      app.handleRecordChanged();
    }, onClose);

  const remove = page && page.kind === "CUSTOM"
    ? () =>
        form.run(async () => {
          await deleteNotePage(mode, page);
          onDeleted?.();
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={page ? "Rename page" : "New page"}
      eyebrow={page?.kind === "CUSTOM" ? "Deleting moves its notes to Other" : "A fresh notebook"}
      tone="lilac"
      footer={<SheetActions onSave={() => void save()} onDelete={remove ? () => void remove() : undefined} busy={form.busy} saveLabel={page ? "Rename" : "Create page"} />}
    >
      <BigInput label="Page name" placeholder="Startup ideas" value={String(form.values.title ?? "")} onChange={(value) => form.set("title", value)} autoFocus />
      <FormError message={form.error} />
    </Sheet>
  );
}
