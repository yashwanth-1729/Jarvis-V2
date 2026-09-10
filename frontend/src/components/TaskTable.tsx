"use client";

import { ArrowRight, Check, CheckCheck, Circle, CircleAlert, Clock3, ListChecks, Loader2, Minus, Pencil, Plus, Search, X } from "lucide-react";
import * as React from "react";
import { RecordEditor, type FieldSpec, type RecordValues } from "@/components/RecordEditor";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { createTask, deleteTask, updateTask, type RecordsMode } from "@/lib/records";
import { cn, formatDateTime, isOverdue } from "@/lib/utils";
import type { Task, TaskStatus } from "@/types";
import { useListMotion } from "@/lib/useListMotion";

type StatusFilter = "ALL" | TaskStatus;
type SortKey = "due" | "priority" | "created";
const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  PENDING: "IN_PROGRESS", IN_PROGRESS: "COMPLETED", COMPLETED: "PENDING",
};
const TASK_FIELDS: FieldSpec[] = [
  { kind: "text", name: "title", label: "Task", required: true, placeholder: "What would you like to get done?" },
  { kind: "select", name: "priority", label: "Priority", options: [
    { value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" },
  ] },
  { kind: "datetime", name: "due_date", label: "Due date" },
  { kind: "text", name: "category", label: "Category", placeholder: "Personal, college, project…" },
];

/** Retain removed rows briefly for their exit; never delay the actual mutation. */
function useDepartingRows(tasks: Task[]) {
  const previous = React.useRef(tasks);
  const [leaving, setLeaving] = React.useState<Task[]>([]);
  React.useEffect(() => {
    const ids = new Set(tasks.map(task => task.uid ?? task.id));
    const departed = previous.current.filter(task => !ids.has(task.uid ?? task.id));
    previous.current = tasks;
    setLeaving(departed);
    if (!departed.length) return;
    const timer = window.setTimeout(() => setLeaving([]), 220);
    return () => window.clearTimeout(timer);
  }, [tasks]);
  return leaving.filter(row => !tasks.some(task => (task.uid ?? task.id) === (row.uid ?? row.id)));
}

interface TaskTableProps {
  tasks: Task[];
  onToggle: (taskId: number, next: TaskStatus) => Promise<void>;
  mode: RecordsMode;
  onChanged: () => void;
}

export function TaskTable({ tasks, onToggle, mode, onChanged }: TaskTableProps) {
  const [editing, setEditing] = React.useState<Task | "new" | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("ALL");
  const [sortKey, setSortKey] = React.useState<SortKey>("due");
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState<Set<number>>(new Set());
  const inFlight = React.useRef(new Set<number>());
  const [error, setError] = React.useState<string | null>(null);
  const counts = React.useMemo(() => {
    const result = { ALL: tasks.length, PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0, OVERDUE: 0 };
    for (const task of tasks) {
      result[task.status]++;
      if (task.status !== "COMPLETED" && isOverdue(task.due_date)) result.OVERDUE++;
    }
    return result;
  }, [tasks]);
  const sorted = React.useMemo(() => [...tasks].sort((a, b) => {
    const done = Number(a.status === "COMPLETED") - Number(b.status === "COMPLETED");
    if (done) return done;
    if (sortKey === "created") return b.created_at.localeCompare(a.created_at);
    if (sortKey === "priority") {
      const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (priority) return priority;
    }
    if (!a.due_date && !b.due_date) return b.created_at.localeCompare(a.created_at);
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  }), [tasks, sortKey]);
  const visible = React.useMemo(() => sorted.filter(task =>
    (statusFilter === "ALL" || task.status === statusFilter) &&
    `${task.title} ${task.category ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  ), [sorted, statusFilter, query]);
  const focus = !query.trim() && statusFilter === "ALL"
    ? sorted.find(task => task.status === "IN_PROGRESS") ?? sorted.find(task => task.status === "PENDING")
    : undefined;
  const list = React.useMemo(() => visible.filter(task => task !== focus), [visible, focus]);
  const leaving = useDepartingRows(list);
  const rows = [...list, ...leaving.filter(task => task.id !== focus?.id)];
  const motionRoot = useListMotion(`${focus?.id ?? ""}:${rows.map(task => task.uid ?? task.id).join(",")}`);
  const refOf = (task: Task) => task.uid ?? task.id;

  async function handleToggle(task: Task) {
    if (inFlight.current.has(task.id)) return;
    inFlight.current.add(task.id);
    setPending(new Set(inFlight.current));
    setError(null);
    try { await onToggle(task.id, NEXT_STATUS[task.status]); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update the task. Try again."); }
    finally { inFlight.current.delete(task.id); setPending(new Set(inFlight.current)); }
  }

  return <div ref={motionRoot} className="task-board" data-focused={Boolean(focus)}>
    <div className="workspace-metrics" aria-label="Task overview">
      <div><span>{counts.PENDING + counts.IN_PROGRESS}</span><p>Remaining</p></div>
      <div><span className="text-accent">{counts.IN_PROGRESS}</span><p>In progress</p></div>
      <div><span className={counts.OVERDUE ? "text-critical" : ""}>{counts.OVERDUE}</span><p>Overdue</p></div>
    </div>

    {focus && <section className="focus-card" aria-label="Current focus">
      <div className="focus-card-top"><span><i aria-hidden />{focus.status === "IN_PROGRESS" ? "IN PROGRESS" : "NEXT ON YOUR LIST"}</span><span className="focus-orbit" aria-hidden><span /></span></div>
      <button className="focus-title" onClick={() => setEditing(focus)} aria-label={`Edit "${focus.title}"`}><h2>{focus.title}</h2></button>
      <div className="focus-details">
        {focus.due_date ? <span className={isOverdue(focus.due_date) ? "text-critical" : ""}><Clock3 size={14} />{formatDateTime(focus.due_date)}</span> : <span>No deadline · Go at your pace</span>}
        {focus.priority === "HIGH" && <span className="priority-pill">High priority</span>}
      </div>
      <div className="focus-actions">
        <Button variant="primary" onClick={() => void handleToggle(focus)} disabled={pending.has(focus.id)}>
          {pending.has(focus.id) ? <Loader2 size={16} className="animate-spin" /> : focus.status === "IN_PROGRESS" ? <CheckCheck size={16} /> : <ArrowRight size={16} />}
          {focus.status === "IN_PROGRESS" ? "Complete task" : "Start task"}
        </Button>
        <button className="quiet-action" onClick={() => setEditing(focus)}><Pencil size={14} /> Edit details</button>
      </div>
    </section>}

    <div className="board-section-heading"><h2>{focus ? "The rest of your list" : "Your tasks"}</h2><Button variant="primary" onClick={() => setEditing("new")} aria-label="Add a task"><Plus size={16} /> New task</Button></div>
    <div className="board-controls">
      <label className="search-field"><Search size={17} aria-hidden /><input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a task…" />{query && <button onClick={() => setQuery("")} aria-label="Clear task search"><X size={16} /></button>}</label>
      <div className="filter-row"><Segmented aria-label="Filter tasks by status" value={statusFilter} onValueChange={setStatusFilter} options={[
        { value: "ALL", label: "All", count: counts.ALL },
        { value: "PENDING", label: "Open", count: counts.PENDING },
        { value: "IN_PROGRESS", label: "Active", count: counts.IN_PROGRESS },
        ...(counts.COMPLETED ? [{ value: "COMPLETED" as const, label: "Done", count: counts.COMPLETED }] : []),
      ]} />
      <select className="sort-control" aria-label="Sort tasks" value={sortKey} onChange={event => setSortKey(event.target.value as SortKey)}><option value="due">Due date</option><option value="priority">Priority</option><option value="created">Newest</option></select></div>
    </div>
    {error && <p role="alert" className="board-error"><CircleAlert size={16} />{error}</p>}
    {!rows.length ? <div className="board-empty"><EmptyState icon={focus ? <Check size={22} /> : <ListChecks size={22} />} title={query ? "No matching tasks" : focus ? "One thing at a time." : tasks.length ? "Nothing in this view" : "A fresh start."} hint={query ? "Try a different word or clear your search." : focus ? "Your focus is set. Add anything else you want to keep track of." : "Capture something you want to get done, and take it from there."} /></div> : <ul className="task-list">
      {rows.map(task => {
        const done = task.status === "COMPLETED";
        const overdue = !done && isOverdue(task.due_date);
        const departing = !list.some(row => row.id === task.id);
        return <li key={refOf(task)} data-motion-key={String(refOf(task))} className={cn("task-card", task.status === "IN_PROGRESS" && "is-active", done && "is-complete", departing && "is-leaving")}>
          <button className="task-status" onClick={() => void handleToggle(task)} disabled={pending.has(task.id) || departing} aria-label={`Advance "${task.title}" to ${NEXT_STATUS[task.status].toLowerCase().replace("_", " ")}`}>
            {pending.has(task.id) ? <Loader2 size={16} className="animate-spin" /> : done ? <Check size={16} /> : task.status === "IN_PROGRESS" ? <Minus size={16} /> : <Circle size={18} />}
          </button>
          <div className="task-copy"><button className="task-title" onClick={() => setEditing(task)}>{task.title}</button><div className="task-meta">
            {task.due_date && <span className={overdue ? "text-critical" : ""}><Clock3 size={12} />{formatDateTime(task.due_date)}{overdue && " · Overdue"}</span>}
            {task.priority === "HIGH" && <span className="priority-pill">High priority</span>}
            {task.category && task.category.toUpperCase() !== "GENERAL" && <span>{task.category}</span>}
          </div></div>
          <button className="task-edit" onClick={() => setEditing(task)} aria-label={`Edit "${task.title}"`}><Pencil size={15} /></button>
        </li>;
      })}
    </ul>}
    <RecordEditor open={editing !== null} title={editing === "new" ? "New task" : "Edit task"} fields={TASK_FIELDS}
      initial={editing && editing !== "new" ? { title: editing.title, priority: editing.priority, due_date: editing.due_date ?? "", category: editing.category } : { priority: "MEDIUM" }}
      onClose={() => setEditing(null)} onSave={async (values: RecordValues) => {
        const draft = { title: String(values.title ?? "").trim(), priority: (values.priority as Task["priority"]) ?? "MEDIUM", due_date: String(values.due_date ?? "").trim() || null, category: String(values.category ?? "").trim() || null };
        if (editing === "new") await createTask(mode, draft);
        else if (editing) await updateTask(mode, refOf(editing), { ...draft, clear_due_date: !draft.due_date });
        onChanged();
      }} onDelete={editing && editing !== "new" ? async () => { await deleteTask(mode, refOf(editing)); onChanged(); } : undefined} />
  </div>;
}
