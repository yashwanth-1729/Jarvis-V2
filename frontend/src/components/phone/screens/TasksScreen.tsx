"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MagnifyingGlass, Plus, X } from "@phosphor-icons/react";

import type { Task } from "@/types";
import { groupTasks, isOverdueTask, type TaskSort } from "../lib/derive";
import { useAppData, useFinish } from "../PhoneContext";
import { TaskSheet, type TaskTarget } from "../sheets/TaskSheet";
import { Empty, SectionHead, Skeleton } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Segmented } from "../ui/Segmented";
import { Tap } from "../ui/Tap";
import { Icon3D } from "../ui/Icon3D";
import { TaskRow } from "./TaskRow";
import { Num } from "../ui/Num";

type Filter = "all" | "doing" | "late";

export function TasksScreen() {
  const { app } = useAppData();
  const { checked, finishing } = useFinish();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<TaskSort>("due");
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<TaskTarget>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const open = (app.state?.tasks ?? []).filter((task) => task.status !== "COMPLETED" && !finishing.has(task.id));
  const doing = open.filter((task) => task.status === "IN_PROGRESS");
  const late = open.filter((task) => isOverdueTask(task));
  const needle = query.trim().toLocaleLowerCase();
  const visible = (filter === "doing" ? doing : filter === "late" ? late : open).filter(
    (task) => !needle || `${task.title} ${task.category}`.toLocaleLowerCase().includes(needle),
  );
  const groups = groupTasks(visible, sort);

  React.useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  let index = 0;
  return (
    <Screen
      title="Tasks"
      tone="orange"
      eyebrow={<><Num value={open.length} /> open{doing.length > 0 && <> · <Num value={doing.length} /> doing</>}</>}
      actions={
        <>
          <Tap className="ph-icon-btn" aria-label={searching ? "Close search" : "Search tasks"} data-on={searching} onClick={() => {
            if (searching) setQuery("");
            setSearching((value) => !value);
          }}>
            {searching ? <X size={20} weight="bold" /> : <MagnifyingGlass size={21} weight="bold" />}
          </Tap>
          <Tap className="ph-icon-btn ph-icon-btn-accent" aria-label="Add a task" onClick={() => setEditing("new")} feel="heavy">
            <Plus size={22} weight="bold" />
          </Tap>
        </>
      }
      hero={
        <div className="ph-controls">
          <AnimatePresence initial={false}>
            {searching && (
              <motion.label
                className="ph-search"
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 52, marginBottom: 12 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              >
                <MagnifyingGlass size={18} weight="bold" />
                <input ref={searchRef} aria-label="Search tasks" placeholder="Find a task" value={query} onChange={(event) => setQuery(event.target.value)} />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                    <X size={16} weight="bold" />
                  </button>
                )}
              </motion.label>
            )}
          </AnimatePresence>
          <Segmented<Filter>
            label="Task filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: open.length },
              { value: "doing", label: "Doing", count: doing.length },
              { value: "late", label: "Late", count: late.length },
            ]}
          />
          <div className="ph-sort" role="radiogroup" aria-label="Sort tasks">
            <span>Sort</span>
            {(["due", "priority", "newest"] as const).map((value) => (
              <Tap key={value} role="radio" aria-checked={sort === value} className="ph-sort-chip" data-on={sort === value} feel="select" onClick={() => setSort(value)}>
                {value === "due" ? "Due" : value === "priority" ? "Priority" : "New"}
              </Tap>
            ))}
          </div>
        </div>
      }
    >
      <div className="ph-stack">
        {!app.state ? (
          <Skeleton rows={5} />
        ) : groups.length ? (
          groups.map((group) => (
            <section key={group.key} className="ph-section ph-task-group" data-tone={group.tone ?? undefined}>
              <SectionHead title={group.label} count={group.tasks.length} />
              <ul className="ph-task-list">
                <AnimatePresence initial={false}>
                  {group.tasks.map((task: Task) => (
                    <TaskRow key={task.uid ?? task.id} task={task} done={checked.has(task.id)} index={index++} onEdit={setEditing} />
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ))
        ) : (
          <Empty
            icon={<Icon3D name="party" size={52} />}
            title={needle ? "Nothing matches" : filter === "late" ? "Nothing late. Clean." : filter === "doing" ? "Nothing in motion" : "All clear. Go touch grass."}
            hint={needle ? "Try another word or filter." : "Add a task, or tell JARVIS what's on your mind."}
            action={!needle && <Tap className="ph-btn ph-btn-primary" onClick={() => setEditing("new")}>Add a task</Tap>}
          />
        )}
        {groups.length > 0 && (
          <p className="ph-swipe-hint">Swipe right to finish · left to start</p>
        )}
      </div>
      <TaskSheet target={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
