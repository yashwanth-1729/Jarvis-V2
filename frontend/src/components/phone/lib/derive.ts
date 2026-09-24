import { parseLocal } from "@/lib/utils";
import type { Idea, Memory, NotePage, Reminder, ScheduleEvent, Task } from "@/types";
import { dayDelta } from "./time";

/* ---------------------------------------------------------------- schedule */

export interface Occurrence {
  event: ScheduleEvent;
  start: number;
  end: number;
}

/** Today's agenda with concrete start/end instants (missing ends mean 1h). */
export function occurrences(today: ScheduleEvent[]): Occurrence[] {
  return today
    .map((event) => {
      const start = parseLocal(event.time_start)?.getTime();
      if (start === undefined || !Number.isFinite(start)) return null;
      const end = parseLocal(event.time_end)?.getTime() ?? start + 3_600_000;
      return { event, start, end: end > start ? end : start + 3_600_000 };
    })
    .filter((item): item is Occurrence => item !== null)
    .sort((a, b) => a.start - b.start);
}

/** What is running now, and what comes next today. */
export function nowAndNext(today: ScheduleEvent[], now: number) {
  const all = occurrences(today);
  const current = all.find((item) => item.start <= now && now < item.end) ?? null;
  const next = all.find((item) => item.start > now) ?? null;
  const remaining = all.filter((item) => item.end > now).length;
  return { current, next, remaining, all };
}

export const KIND_LABEL: Record<ScheduleEvent["kind"], string> = {
  COLLEGE: "Class",
  ROUTINE: "Routine",
  SESSION: "Block",
};

/** Colour identity per schedule kind, used for tiles, dots and bars. */
export const KIND_TONE: Record<ScheduleEvent["kind"], Tone> = {
  COLLEGE: "sky",
  ROUTINE: "lilac",
  SESSION: "orange",
};

export type Tone = "lime" | "sky" | "lilac" | "pink" | "orange" | "mint" | "amber" | "red";

/* ------------------------------------------------------------------- tasks */

export const PRIORITY_TONE: Record<Task["priority"], Tone> = { HIGH: "pink", MEDIUM: "amber", LOW: "mint" };
export const PRIORITY_RANK: Record<Task["priority"], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function isOverdueTask(task: Task, now = Date.now()): boolean {
  const due = parseLocal(task.due_date);
  return task.status !== "COMPLETED" && due !== null && due.getTime() < now;
}

/** The handful worth doing next: overdue, due today, in progress, then priority. */
export function focusTasks(tasks: Task[], limit: number, now = new Date()): Task[] {
  const score = (task: Task) => {
    const due = parseLocal(task.due_date);
    const overdue = due !== null && due.getTime() < now.getTime();
    const today = due !== null && dayDelta(due, now) === 0;
    return [
      overdue ? 0 : today ? 1 : task.status === "IN_PROGRESS" ? 2 : 3,
      PRIORITY_RANK[task.priority],
      due?.getTime() ?? Number.MAX_SAFE_INTEGER,
    ];
  };
  return [...tasks]
    .filter((task) => task.status !== "COMPLETED")
    .sort((a, b) => {
      const x = score(a);
      const y = score(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .slice(0, limit);
}

export type TaskSort = "due" | "priority" | "newest";

export interface TaskGroup {
  key: string;
  label: string;
  tone: Tone | null;
  tasks: Task[];
}

/** Buckets for the task list, in reading order. */
export function groupTasks(tasks: Task[], sort: TaskSort, now = new Date()): TaskGroup[] {
  if (sort === "newest") {
    return [{ key: "all", label: "Newest first", tone: null, tasks: [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at)) }];
  }
  if (sort === "priority") {
    const groups: TaskGroup[] = [
      { key: "HIGH", label: "High priority", tone: "pink", tasks: [] },
      { key: "MEDIUM", label: "Medium", tone: "amber", tasks: [] },
      { key: "LOW", label: "Low", tone: "mint", tasks: [] },
    ];
    for (const task of tasks) groups[PRIORITY_RANK[task.priority]].tasks.push(task);
    for (const group of groups) group.tasks.sort(byDue);
    return groups.filter((group) => group.tasks.length);
  }
  const groups: TaskGroup[] = [
    { key: "overdue", label: "Overdue", tone: "red", tasks: [] },
    { key: "today", label: "Today", tone: "lime", tasks: [] },
    { key: "tomorrow", label: "Tomorrow", tone: "sky", tasks: [] },
    { key: "week", label: "This week", tone: "lilac", tasks: [] },
    { key: "later", label: "Later", tone: null, tasks: [] },
    { key: "none", label: "Whenever", tone: null, tasks: [] },
  ];
  for (const task of tasks) {
    const due = parseLocal(task.due_date);
    if (!due) groups[5].tasks.push(task);
    else if (due.getTime() < now.getTime()) groups[0].tasks.push(task);
    else {
      const delta = dayDelta(due, now);
      groups[delta <= 0 ? 1 : delta === 1 ? 2 : delta < 7 ? 3 : 4].tasks.push(task);
    }
  }
  for (const group of groups) group.tasks.sort(byDue);
  groups[5].tasks.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.created_at.localeCompare(a.created_at));
  return groups.filter((group) => group.tasks.length);
}

function byDue(a: Task, b: Task): number {
  return (a.due_date || "9999").localeCompare(b.due_date || "9999");
}

/* --------------------------------------------------------------- reminders */

export function upcomingReminders(reminders: Reminder[], now = Date.now()): Reminder[] {
  return [...reminders]
    .filter((reminder) => !reminder.fired_at && (parseLocal(reminder.due_at)?.getTime() ?? 0) >= now - 60_000)
    .sort((a, b) => (parseLocal(a.due_at)?.getTime() ?? 0) - (parseLocal(b.due_at)?.getTime() ?? 0));
}

/* ------------------------------------------------------------------- notes */

export const DEFAULT_PAGES: NotePage[] = [
  { uid: "notes-long-term", title: "Long-term memory", kind: "LONG_TERM", created_at: "", updated_at: "" },
  { uid: "notes-temporary", title: "Temporary memory", kind: "TEMPORARY", created_at: "", updated_at: "" },
  { uid: "notes-other", title: "Other", kind: "OTHER", created_at: "", updated_at: "" },
];

/** Defaults first, overridden by any saved (renamed) copy, then custom pages. */
export function allPages(saved: NotePage[] = []): NotePage[] {
  const pages = new Map(DEFAULT_PAGES.map((page) => [page.uid, page]));
  for (const page of saved) pages.set(page.uid, page);
  return [...pages.values()];
}

export function isMemoryPage(page: NotePage): boolean {
  return page.kind === "LONG_TERM" || page.kind === "TEMPORARY";
}

/** The ideas a notes page shows. "Other" also collects orphans of deleted pages. */
export function pageIdeas(page: NotePage, ideas: Idea[], pages: NotePage[]): Idea[] {
  if (page.kind === "OTHER") {
    return ideas.filter((idea) => !idea.page_uid || idea.page_uid === page.uid || !pages.some((p) => p.uid === idea.page_uid));
  }
  return ideas.filter((idea) => idea.page_uid === page.uid);
}

/** Active memories on a memory page (temporary ones carry an expiry). */
export function pageMemories(page: NotePage, memories: Memory[]): Memory[] {
  const temporary = page.kind === "TEMPORARY";
  return memories.filter((memory) => memory.memory_status === "ACTIVE" && Boolean(memory.expires_at) === temporary);
}

export function pageCount(page: NotePage, ideas: Idea[], memories: Memory[], pages: NotePage[]): number {
  return isMemoryPage(page) ? pageMemories(page, memories).length : pageIdeas(page, ideas, pages).length;
}

export const MEMORY_TONE: Record<Memory["memory_type"], Tone> = {
  SEMANTIC: "sky",
  PROCEDURAL: "lime",
  EPISODIC: "orange",
  PROSPECTIVE: "pink",
  REFLECTIVE: "lilac",
  WORKING: "mint",
};

export const MEMORY_LABEL: Record<Memory["memory_type"], string> = {
  SEMANTIC: "Knowledge",
  PROCEDURAL: "Rule",
  EPISODIC: "Episode",
  PROSPECTIVE: "Goal",
  REFLECTIVE: "Pattern",
  WORKING: "Working",
};

const PAGE_TONES: Tone[] = ["orange", "sky", "pink", "mint", "amber", "lilac"];

export function pageTone(page: NotePage): Tone {
  if (page.kind === "LONG_TERM") return "lilac";
  if (page.kind === "TEMPORARY") return "mint";
  if (page.kind === "OTHER") return "orange";
  let hash = 0;
  for (const char of page.uid) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PAGE_TONES[Math.abs(hash) % PAGE_TONES.length];
}
