/** Offline checks for the phone app's pure logic. No browser, network,
 * credentials or user records: every input is built here.
 *
 *   node --import tsx tests/phone-logic.test.ts
 */
import assert from "node:assert/strict";

import { eventDraft, memoryDraft, pageTitle, reminderDraft, taskDraft } from "../src/lib/recordDrafts";
import {
  allPages,
  focusTasks,
  groupTasks,
  isOverdueTask,
  nowAndNext,
  pageIdeas,
  pageMemories,
  upcomingReminders,
} from "../src/components/phone/lib/derive";
import { duration, isoLocal, quickTimes, relative, when } from "../src/components/phone/lib/time";
import type { Idea, Memory, NotePage, Reminder, ScheduleEvent, Task } from "../src/types";

let passed = 0;
function check(name: string, run: () => void | Promise<void>) {
  return Promise.resolve(run()).then(() => {
    passed += 1;
    console.log(`PASS ${name}`);
  });
}

const now = new Date(2026, 8, 24, 14, 30); // Thu 24 Sep 2026, 2:30 PM
const at = (days: number, hour: number, minute = 0) => isoLocal(new Date(2026, 8, 24 + days, hour, minute));
const task = (id: number, extra: Partial<Task>): Task => ({
  id, uid: `t${id}`, title: `Task ${id}`, category: "GENERAL", priority: "MEDIUM", status: "PENDING",
  due_date: null, created_at: `2026-09-2${id % 10}T00:00:00`, updated_at: "", ...extra,
});
const event = (id: number, start: string, end: string | null, extra: Partial<ScheduleEvent> = {}): ScheduleEvent => ({
  id, uid: `e${id}`, event_name: `Event ${id}`, kind: "ROUTINE", time_start: start, time_end: end, day_of_week: 3,
  start_time: start.slice(11, 16), end_time: end?.slice(11, 16) ?? null, location: null, notes: null, created_at: "",
  day_name: "Thursday", display_start: "", display_end: "", window: "", ...extra,
});

async function main() {
  await check("now and next pick the running block and the following one", () => {
    const today = [event(1, at(0, 9), at(0, 10)), event(2, at(0, 14), at(0, 15)), event(3, at(0, 18), null)];
    const result = nowAndNext(today, now.getTime());
    assert.equal(result.current?.event.id, 2);
    assert.equal(result.next?.event.id, 3);
    assert.equal(result.remaining, 2);
    // A missing end is treated as one hour.
    assert.equal(result.all[2].end - result.all[2].start, 3_600_000);
  });

  await check("task buckets follow the due date, overdue first", () => {
    const tasks = [
      task(1, { due_date: at(-1, 23, 59) }),
      task(2, { due_date: at(0, 21) }),
      task(3, { due_date: at(1, 9) }),
      task(4, { due_date: at(4, 9) }),
      task(5, { due_date: at(20, 9) }),
      task(6, { priority: "HIGH" }),
      task(7, { priority: "LOW" }),
    ];
    const groups = groupTasks(tasks, "due", now);
    assert.deepEqual(groups.map((group) => group.key), ["overdue", "today", "tomorrow", "week", "later", "none"]);
    assert.deepEqual(groups[5].tasks.map((item) => item.id), [6, 7]);
    const byPriority = groupTasks(tasks, "priority", now);
    assert.deepEqual(byPriority.map((group) => group.key), ["HIGH", "MEDIUM", "LOW"]);
  });

  await check("focus puts overdue, then today, then work in progress first", () => {
    const tasks = [
      task(1, { due_date: at(3, 9), priority: "HIGH" }),
      task(2, { status: "IN_PROGRESS" }),
      task(3, { due_date: at(0, 20) }),
      task(4, { due_date: at(-2, 9), priority: "LOW" }),
      task(5, { status: "COMPLETED", due_date: at(-5, 9) }),
    ];
    assert.deepEqual(focusTasks(tasks, 3, now).map((item) => item.id), [4, 3, 2]);
    assert.equal(isOverdueTask(tasks[3], now.getTime()), true);
    assert.equal(isOverdueTask(tasks[4], now.getTime()), false);
  });

  await check("reminders: fired and long-past ones are not upcoming", () => {
    const reminders: Reminder[] = [
      { id: 1, text: "soon", due_at: at(0, 15), target_at: null, created_at: "", fired_at: null },
      { id: 2, text: "spoken", due_at: at(0, 16), target_at: null, created_at: "", fired_at: at(0, 16) },
      { id: 3, text: "old", due_at: at(-1, 9), target_at: null, created_at: "", fired_at: null },
    ];
    assert.deepEqual(upcomingReminders(reminders, now.getTime()).map((item) => item.id), [1]);
  });

  await check("notes pages: orphans land in Other, temporary memories stay apart", () => {
    const custom: NotePage = { uid: "p1", title: "Ideas", kind: "CUSTOM", created_at: "", updated_at: "" };
    const pages = allPages([custom]);
    assert.equal(pages.length, 4);
    const idea = (id: number, page_uid: string | null): Idea => ({ id, uid: `i${id}`, title: "", description: "", tags: "", status: "DRAFT", page_uid, created_at: "", updated_at: "" });
    const ideas = [idea(1, null), idea(2, "p1"), idea(3, "deleted-page")];
    const other = pages.find((page) => page.kind === "OTHER")!;
    assert.deepEqual(pageIdeas(other, ideas, pages).map((item) => item.id), [1, 3]);
    assert.deepEqual(pageIdeas(custom, ideas, pages).map((item) => item.id), [2]);
    const memory = (id: number, extra: Partial<Memory>): Memory => ({
      id, key_concept: "", category: "LONG_TERM", content: "", memory_type: "SEMANTIC", memory_status: "ACTIVE", confidence: 1,
      importance: 0.5, source_kind: "", pinned: false, evidence_count: 1, tags: [], revision_count: 0, created_at: "", updated_at: "", ...extra,
    });
    const memories = [memory(1, {}), memory(2, { expires_at: at(3, 9) }), memory(3, { memory_status: "CANDIDATE" })];
    const longTerm = pages.find((page) => page.kind === "LONG_TERM")!;
    const temporary = pages.find((page) => page.kind === "TEMPORARY")!;
    assert.deepEqual(pageMemories(longTerm, memories).map((item) => item.id), [1]);
    assert.deepEqual(pageMemories(temporary, memories).map((item) => item.id), [2]);
  });

  await check("form rules match the desktop editors", () => {
    assert.throws(() => taskDraft({ title: "  " }), /name/);
    assert.deepEqual(taskDraft({ title: " Ship it ", priority: "", due_date: "", category: "" }), { title: "Ship it", priority: "MEDIUM", due_date: null, category: null });

    const weekly = eventDraft({ event_name: "Gym", kind: "ROUTINE", day_of_week: "2", start_time: "06:30", end_time: "07:30", time_start: "2026-09-24T06:30:00", time_end: "" });
    assert.equal(weekly.day_of_week, 2);
    assert.equal(weekly.time_start, null);
    assert.throws(() => eventDraft({ event_name: "Block", kind: "SESSION", time_start: at(0, 16), time_end: at(0, 15) }), /end time/);
    const block = eventDraft({ event_name: "Block", kind: "SESSION", day_of_week: "4", start_time: "10:00", time_start: at(0, 16), time_end: at(0, 17) });
    assert.equal(block.day_of_week, null);
    assert.equal(block.start_time, null);

    assert.throws(() => reminderDraft({ text: "Call", due_at: "" }), /when/i);

    const working = memoryDraft({ key_concept: "Focus", content: "Exam week", memory_type: "WORKING", memory_status: "ACTIVE", duration: "permanent", importance: "0.65", pinned: "true" });
    assert.ok(working.expires_at && new Date(working.expires_at).getTime() > Date.now());
    assert.equal(working.pinned, true);
    assert.throws(() => memoryDraft({ key_concept: "Old", content: "x", memory_type: "SEMANTIC", duration: "temporary", expires_at: "2020-01-01T00:00:00" }), /future/);

    const pages = allPages();
    assert.throws(() => pageTitle({ title: "other" }, pages, null), /already/);
    assert.equal(pageTitle({ title: "Other" }, pages, pages[2]), "Other");
    assert.throws(() => pageTitle({ title: "x".repeat(81) }, pages, null), /between/);
  });

  await check("time copy reads naturally", () => {
    assert.equal(when(at(0, 18, 5), now), "Today, 6:05 PM");
    assert.equal(when(at(1, 9), now), "Tomorrow, 9:00 AM");
    assert.equal(relative(at(0, 15, 0), now.getTime()), "in 30m");
    assert.equal(relative(at(-1, 14, 30), now.getTime()), "1d late");
    assert.equal(duration(80), "1h 20m");
    for (const pick of quickTimes(now)) assert.ok(new Date(pick.value).getTime() > now.getTime(), pick.label);
  });

  await check("back button stack: push, back, UI close and a swap mid-rewind", async () => {
    type Listener = (event: { state: unknown }) => void;
    const listeners: Listener[] = [];
    const stack: unknown[] = [{}];
    let index = 0;
    const deliver = () => new Promise<void>((resolve) => setTimeout(() => {
      for (const listener of listeners) listener({ state: stack[index] });
      resolve();
    }, 5));
    let pending = Promise.resolve();
    const fakeWindow = {
      history: {
        get state() { return stack[index]; },
        pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index += 1; },
        go(delta: number) { index = Math.max(0, index + delta); pending = deliver(); },
      },
      addEventListener(type: string, listener: Listener) { if (type === "popstate") listeners.push(listener); },
    };
    Object.assign(globalThis, { window: fakeWindow });
    const { pushLayer, releaseLayer, openLayers } = await import("../src/components/phone/lib/backStack");
    const settle = () => pending;

    let closedA = 0;
    let closedB = 0;
    const a = pushLayer(() => { closedA += 1; });
    pushLayer(() => { closedB += 1; });
    assert.equal(openLayers(), 2);
    assert.equal((fakeWindow.history.state as { jarvisLayer: number }).jarvisLayer, 2);

    // The hardware back button: only the top layer closes.
    fakeWindow.history.go(-1);
    await settle();
    assert.equal(closedB, 1);
    assert.equal(closedA, 0);
    assert.equal(openLayers(), 1);

    // Closing from the UI rewinds history without calling the layer back.
    releaseLayer(a);
    await settle();
    assert.equal(closedA, 0);
    assert.equal(openLayers(), 0);
    assert.equal(index, 0);

    // Swap: close one layer and open another before the rewind lands.
    const c = pushLayer(() => undefined);
    await settle();
    releaseLayer(c);
    let closedD = 0;
    pushLayer(() => { closedD += 1; });
    await settle();
    assert.equal(openLayers(), 1);
    assert.equal((fakeWindow.history.state as { jarvisLayer: number }).jarvisLayer, 1);
    fakeWindow.history.go(-1);
    await settle();
    assert.equal(closedD, 1);
    assert.equal(openLayers(), 0);
  });

  console.log(`\n${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
