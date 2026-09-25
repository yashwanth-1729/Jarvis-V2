"use client";

import * as React from "react";
import { Play } from "@phosphor-icons/react";

import { createTask, deleteTask, updateTask } from "@/lib/records";
import { taskDraft } from "@/lib/recordDrafts";
import type { Task } from "@/types";
import { useAppData, useFinishAction } from "../PhoneContext";
import { BigInput, Choices, Field, FormError, SheetActions, Switch, TextInput, useRetained, useSheetForm, WhenPicker } from "../ui/Form";
import { Sheet } from "../ui/Sheet";
import { Tap } from "../ui/Tap";
import { Icon3D } from "../ui/Icon3D";

export type TaskTarget = Task | "new" | null;

/** Add or edit a task. Completing and starting use the board's own toggle. */
export function TaskSheet({ target, onClose }: { target: TaskTarget; onClose: () => void }) {
  const { app, mode } = useAppData();
  const finish = useFinishAction();
  const shown = useRetained(target);
  const task = shown && shown !== "new" ? shown : null;
  const form = useSheetForm(target !== null, () => ({
    title: task?.title ?? "",
    priority: task?.priority ?? "MEDIUM",
    due_date: task?.due_date ?? "",
    category: task?.category && task.category !== "GENERAL" ? task.category : "",
    doing: task?.status === "IN_PROGRESS",
  }));
  const { values, set } = form;

  const categories = React.useMemo(() => {
    const seen = new Set<string>();
    for (const item of app.state?.tasks ?? []) {
      if (item.category && item.category !== "GENERAL") seen.add(item.category.toLowerCase());
    }
    return [...seen].slice(0, 6);
  }, [app.state?.tasks]);

  const save = () =>
    form.run(async () => {
      const draft = taskDraft(values);
      if (!task) {
        await createTask(mode, draft);
      } else {
        await updateTask(mode, task.uid ?? task.id, { ...draft, clear_due_date: !draft.due_date });
        const wantDoing = values.doing === true;
        if (wantDoing !== (task.status === "IN_PROGRESS")) {
          await app.handleToggleTask(task.id, wantDoing ? "IN_PROGRESS" : "PENDING");
        }
      }
      app.handleRecordChanged();
    }, onClose);

  const remove = task
    ? () =>
        form.run(async () => {
          await deleteTask(mode, task.uid ?? task.id);
          app.handleRecordChanged();
        }, onClose)
    : undefined;

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={task ? "Edit task" : "New task"}
      eyebrow={task ? "Tweak it" : "Add to the list"}
      tone="orange"
      footer={
        <SheetActions
          onSave={() => void save()}
          onDelete={remove ? () => void remove() : undefined}
          busy={form.busy}
          saveLabel={task ? "Save" : "Add task"}
          extra={task && (
            <Tap
              className="ph-btn ph-btn-lime-ghost"
              feel={false}
              onClick={(event) => {
                finish(task, event.currentTarget);
                onClose();
              }}
            >
              <Icon3D name="tasks" size={22} /> Finish
            </Tap>
          )}
        />
      }
    >
      <BigInput label="Task" placeholder="What needs doing?" value={String(values.title ?? "")} onChange={(value) => set("title", value)} autoFocus={!task} />
      <Field label="Priority">
        <Choices
          label="Priority"
          value={String(values.priority) as Task["priority"]}
          onChange={(value) => set("priority", value)}
          options={[
            { value: "HIGH", label: "High", tone: "pink", icon: <Icon3D name="fire" size={22} /> },
            { value: "MEDIUM", label: "Medium", tone: "amber", icon: <Icon3D name="bolt" size={22} /> },
            { value: "LOW", label: "Low", tone: "mint", icon: <Icon3D name="leaf" size={22} /> },
          ]}
        />
      </Field>
      <Field label="Due">
        <WhenPicker label="Due date" value={String(values.due_date ?? "")} onChange={(value) => set("due_date", value)} allowClear />
      </Field>
      <Field label="Category">
        <TextInput label="Category" placeholder="college, project, personal…" value={String(values.category ?? "")} onChange={(value) => set("category", value)} />
        {categories.length > 0 && (
          <div className="ph-suggest">
            {categories.map((category) => (
              <Tap key={category} className="ph-suggest-chip" feel="select" onClick={() => set("category", category)}>
                #{category}
              </Tap>
            ))}
          </div>
        )}
      </Field>
      {task && (
        <Switch
          label="Working on it"
          hint="Marks the task as in progress"
          on={values.doing === true}
          onChange={(on) => set("doing", on)}
        />
      )}
      {task && task.status === "IN_PROGRESS" && values.doing !== true && (
        <p className="ph-field-hint"><Play size={12} weight="fill" /> Saving moves it back to to-do.</p>
      )}
      <FormError message={form.error} />
    </Sheet>
  );
}
