"use client";

import * as React from "react";
import { withTransition } from "./transition";
import { ArrowUpRight, Check, CircleAlert, ListFilter, Loader2, Minus, Plus, Search, X } from "lucide-react";
import { RecordEditor, type FieldSpec } from "@/components/RecordEditor";
import { createTask, deleteTask, updateTask, type RecordsMode } from "@/lib/records";
import { formatDateTime, isOverdue } from "@/lib/utils";
import type { Task, TaskStatus } from "@/types";

const NEXT: Record<TaskStatus, TaskStatus> = { PENDING: "IN_PROGRESS", IN_PROGRESS: "COMPLETED", COMPLETED: "PENDING" };
const STATUS_LABEL: Record<TaskStatus, string> = { PENDING: "Start", IN_PROGRESS: "Complete", COMPLETED: "Reopen" };
const FIELDS: FieldSpec[] = [
  { kind: "text", name: "title", label: "Task", required: true, placeholder: "What needs to get done?" },
  { kind: "select", name: "priority", label: "Priority", options: [{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }] },
  { kind: "datetime", name: "due_date", label: "Due date" },
  { kind: "text", name: "category", label: "Category", placeholder: "Personal, college, project" },
];

export function DeskTaskEditor({ task, mode, onClose, onChanged }: {
  task: Task | "new" | null; mode: RecordsMode; onClose: () => void; onChanged: () => void;
}) {
  return <RecordEditor open={task !== null} title={task === "new" ? "Add a task" : "Edit task"}
    fields={FIELDS} initial={task && task !== "new" ? { ...task } : { priority: "MEDIUM" }} onClose={onClose}
    onSave={async values => {
      const draft = { title: String(values.title ?? "").trim(), priority: (values.priority as Task["priority"]) || "MEDIUM", due_date: String(values.due_date ?? "").trim() || null, category: String(values.category ?? "").trim() || null };
      if (task === "new") await createTask(mode, draft);
      else if (task) await updateTask(mode, task.uid ?? task.id, { ...draft, clear_due_date: !draft.due_date });
      onChanged();
    }} onDelete={task && task !== "new" ? async () => { await deleteTask(mode, task.uid ?? task.id); onChanged(); } : undefined} />;
}

export function DeskTaskRow({ task, onEdit, onToggle }: { task: Task; onEdit: (task: Task) => void; onToggle: (id: number, status: TaskStatus) => Promise<void> }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  const inFlight = React.useRef(false);
  const done = task.status === "COMPLETED";
  const active = task.status === "IN_PROGRESS";
  async function advance() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true); setError("");
    try { await onToggle(task.id, NEXT[task.status]); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update this task."); }
    finally { inFlight.current = false; setPending(false); }
  }
  // A stable name per row lets the browser carry the row to its new place
  // when the list is filtered, sorted or a status changes, instead of
  // cross-fading two different lists. Names must be valid CSS identifiers.
  const identity = `task-${String(task.uid ?? task.id).replace(/[^A-Za-z0-9_-]/g, "")}`;
  return <li className="desk-task" data-active={active} data-done={done}
    style={{ viewTransitionName: identity } as React.CSSProperties}>
    <button type="button" className="desk-check" disabled={pending} onClick={() => withTransition(() => void advance(), "filter")} aria-label={`${STATUS_LABEL[task.status]} task: ${task.title}`}>
      <span>{pending ? <Loader2 size={14} className="desk-spin" /> : done ? <Check size={14} /> : active ? <Minus size={14} /> : null}</span>
    </button>
    <button type="button" className="desk-task-copy" onClick={() => onEdit(task)} aria-label={`Edit task: ${task.title}`}>
      <strong>{task.title}</strong>
      <span>{active && <b>In progress</b>}{task.due_date ? <time className={isOverdue(task.due_date) && !done ? "desk-overdue" : undefined}>{formatDateTime(task.due_date)}</time> : task.category && task.category !== "GENERAL" ? task.category : "No deadline"}{task.priority === "HIGH" && <span className="desk-priority">High priority</span>}</span>
    </button>
    {error && <p role="alert" className="desk-inline-error"><CircleAlert size={16} />{error}</p>}
  </li>;
}

export function DeskTasks({ tasks, mode, onChanged, onToggle }: {
  tasks: Task[]; mode: RecordsMode; onChanged: () => void; onToggle: (id: number, status: TaskStatus) => Promise<void>;
}) {
  const [filter, setFilter] = React.useState("open");
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState("due");
  const [editing, setEditing] = React.useState<Task | "new" | null>(null);
  const visible = tasks.filter(task => (filter === "all" || (filter === "active" ? task.status === "IN_PROGRESS" : task.status !== "COMPLETED")) && `${task.title} ${task.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => {
    if (sort === "priority") { const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 }; return rank[a.priority] - rank[b.priority]; }
    if (sort === "newest") return b.created_at.localeCompare(a.created_at);
    return (a.due_date || "9999").localeCompare(b.due_date || "9999");
  });
  return <>
    <div className="desk-section-title"><p>{tasks.filter(task => task.status !== "COMPLETED").length} open tasks</p><button className="desk-button" onClick={() => withTransition(() => setEditing("new"), "open")}><Plus size={17} /> Add task</button></div>
    <label className="desk-search"><Search size={19} /><span className="sr-only">Search tasks</span><input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a task" />{query && <button aria-label="Clear search" onClick={() => withTransition(() => setQuery(""), "filter")}><X size={18} /></button>}</label>
    <div className="desk-task-filters"><div className="desk-tabs" aria-label="Task filters">{[["open", "Open"], ["active", "In progress"], ["all", "All"]].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => withTransition(() => setFilter(value), "filter")}>{label}</button>)}</div><label className="desk-sort"><ListFilter size={17} /><span className="sr-only">Sort tasks</span><select value={sort} onChange={event => { const next = event.target.value; withTransition(() => setSort(next), "filter"); }}><option value="due">Due date</option><option value="priority">Priority</option><option value="newest">Newest</option></select></label></div>
    {visible.length ? <ul className="desk-task-list">{visible.map(task => <DeskTaskRow key={task.uid ?? task.id} task={task} onEdit={setEditing} onToggle={onToggle} />)}</ul> : <div className="desk-empty"><Check size={28} /><h2>{query ? "No matching tasks" : "Room for what’s next."}</h2><p>{query ? "Try a different search or another filter." : "Add a task here, or ask JARVIS to remember it."}</p><button className="desk-text-button" onClick={() => withTransition(() => query ? setQuery("") : setEditing("new"), "open")}>{query ? "Clear search" : "Add your first task"}<ArrowUpRight size={17} /></button></div>}
    <DeskTaskEditor task={editing} mode={mode} onChanged={onChanged} onClose={() => setEditing(null)} />
  </>;
}
