/**
 * Lock-in and check-in alarms (lib/nativeNotifications.ts) and the
 * notification-action plumbing (lib/notificationActions.ts), checked offline.
 * No device, network, credentials or user records: the Android bridge, fetch,
 * localStorage and IndexedDB (fake-indexeddb) are all stand-ins built here.
 *
 *     npx tsx tests/nativeNotifications.test.ts
 */
import "fake-indexeddb/auto";

import type { FocusItem } from "@/lib/focus";
import { clearAll, putRows, type SyncRow } from "@/lib/localdb";
import {
  type NativeAlarm,
  type NativeNotificationBridge,
  normalizePolicy,
  planScheduleAlarms,
  syncNativeNotifications,
} from "@/lib/nativeNotifications";
import {
  type NotificationAction,
  parseNotificationAction,
  subscribeNotificationActions,
} from "@/lib/notificationActions";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** ICU puts a narrow no-break space before AM/PM; compare with plain ones. */
const plain = (text: string) => text.replace(/\s/g, " ");
/** A local time in October 2026. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const ids = (alarms: NativeAlarm[]) => alarms.map((alarm) => alarm.id).sort();
const mondayIndex = (date: Date) => (date.getDay() + 6) % 7;
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function weekly(uid: string, kind: "COLLEGE" | "ROUTINE", day: number, start: string | null, end: string | null): SyncRow {
  return {
    uid, updated_at: "2026-10-01T00:00:00", kind, event_name: `Event ${uid}`, day_of_week: day,
    start_time: start, end_time: end, time_start: null, time_end: null, location: null, notes: null,
  };
}

function session(uid: string, start: string, end: string | null): SyncRow {
  return {
    uid, updated_at: "2026-10-01T00:00:00", kind: "SESSION", event_name: `Event ${uid}`, day_of_week: null,
    start_time: null, end_time: null, time_start: start, time_end: end, location: null, notes: null,
  };
}

const block = (uid: string, mode: "session" | "quick" = "session") => ({ uid, kind: "block" as const, mode });

function planner(): void {
  console.log("== planScheduleAlarms ==");
  const NOW = new Date(2026, 9, 5, 10, 0); // Monday 5 Oct 2026, 10:00
  const rows: SyncRow[] = [
    weekly("gym", "ROUTINE", 0, "19:00", "20:30"), // Mon
    weekly("dsa", "COLLEGE", 1, "09:00", "10:00"), // Tue, not serious
    session("deep", "2026-10-07T21:30:00", "2026-10-07T23:00:00"), // Wed
    session("gone", "2026-10-05T08:00:00", "2026-10-05T09:00:00"), // earlier today
    weekly("late", "ROUTINE", 4, "22:00", "01:00"), // Fri, over midnight
    weekly("nine", "ROUTINE", 3, "20:00", "21:00"), // Thu, ends exactly 21:00
    weekly("ten-past", "ROUTINE", 5, "20:00", "21:10"), // Sat
  ];
  const items = [
    block("gym"), block("deep", "quick"), block("gone"), block("late"), block("nine"), block("ten-past"),
    { uid: "essay", kind: "task" as const, mode: "session" as const }, // a serious task: not a block
    block("deleted-row"), // marked serious, but its row is gone
  ];
  const open = normalizePolicy({ college: true, routine: true, blocks: true });
  const plan = planScheduleAlarms(rows, items, open, NOW);

  check(
    "serious blocks ring as Lock-ins",
    same(ids(plan.lockins), ["lockin:deep", "lockin:gym", "lockin:late", "lockin:nine", "lockin:ten-past"]),
    JSON.stringify(ids(plan.lockins)),
  );
  check("...never also as schedule alarms", same(ids(plan.schedules), ["schedule:dsa"]), JSON.stringify(ids(plan.schedules)));
  check(
    "a dated block that already started has no alarm at all",
    !plan.lockins.some((a) => a.id === "lockin:gone") && !plan.schedules.some((a) => a.id === "schedule:gone"),
  );

  const gym = plan.lockins.find((a) => a.id === "lockin:gym");
  check(
    "weekly Lock-in at the block's start",
    gym?.weekly === true && gym.triggerAt === at(5, 19) && gym.kind === "LOCKIN" && gym.mode === "session" && gym.title === "Event gym",
    JSON.stringify(gym),
  );
  check("Lock-in body: range and minutes", plain(gym?.body ?? "") === "7:00 PM – 8:30 PM · 90 min", gym?.body);
  const deep = plan.lockins.find((a) => a.id === "lockin:deep");
  check("dated Lock-in is one-off and keeps its quick mode", deep?.weekly === false && deep.triggerAt === at(7, 21, 30) && deep.mode === "quick");
  const late = plan.lockins.find((a) => a.id === "lockin:late");
  check("over midnight counts the real length", plain(late?.body ?? "") === "10:00 PM – 1:00 AM · 180 min", late?.body);

  check(
    "one check-in per serious day of the next 7, timed by the latest end",
    same(plan.checkins.map((a) => [a.id, a.triggerAt]), [
      ["checkin:2026-10-05", at(5, 21, 30)], // gym ends 20:30
      ["checkin:2026-10-07", at(7, 23, 30)], // deep ends 23:00
      ["checkin:2026-10-08", at(8, 21, 30)], // nine ends at 21:00, not after
      ["checkin:2026-10-09", at(9, 23, 30)], // late ends 01:00: capped
      ["checkin:2026-10-10", at(10, 21, 40)], // ten-past ends 21:10
    ]),
    JSON.stringify(plan.checkins.map((a) => [a.id, new Date(a.triggerAt).toString()])),
  );
  const first = plan.checkins[0];
  check(
    "check-in copy and shape",
    first?.title === "Daily check-in" && first.body === "How did today go?" && first.kind === "CHECKIN" && !first.weekly && first.mode === undefined,
  );

  const evening = planScheduleAlarms(rows, items, open, new Date(2026, 9, 5, 21, 45));
  check(
    "a check-in whose time has passed is skipped",
    !evening.checkins.some((a) => a.id === "checkin:2026-10-05") && evening.checkins.some((a) => a.id === "checkin:2026-10-07"),
  );
  check("a passed weekly Lock-in moves to next week", evening.lockins.find((a) => a.id === "lockin:gym")?.triggerAt === at(12, 19));

  const defaults = planScheduleAlarms(rows, items, normalizePolicy({}), NOW);
  check(
    "Lock-ins and check-ins are on by default",
    defaults.lockins.length === 5 && defaults.checkins.length === 5 && defaults.schedules.length === 0,
  );

  const off = planScheduleAlarms(rows, items, normalizePolicy({ serious: false, college: true, routine: true, blocks: true }), NOW);
  check("serious off: no Lock-ins, no check-ins", off.lockins.length === 0 && off.checkins.length === 0);
  check(
    "serious off: each block falls back to its own category",
    same(ids(off.schedules), ["schedule:deep", "schedule:dsa", "schedule:gym", "schedule:late", "schedule:nine", "schedule:ten-past"]),
    JSON.stringify(ids(off.schedules)),
  );
  const offQuiet = planScheduleAlarms(rows, items, normalizePolicy({ serious: false }), NOW);
  check("serious off with those categories off: silence", offQuiet.schedules.length === 0 && offQuiet.lockins.length === 0);

  const muted = planScheduleAlarms(
    rows, items, normalizePolicy({ routine: true, exclude: ["lockin:gym", "checkin:2026-10-07"] }), NOW,
  );
  check(
    "a muted Lock-in rings as its plain routine instead",
    muted.schedules.some((a) => a.id === "schedule:gym") && !muted.lockins.some((a) => a.id === "lockin:gym"),
  );
  check(
    "a muted check-in day is skipped, the others stay",
    !muted.checkins.some((a) => a.id === "checkin:2026-10-07") && muted.checkins.length === 4,
  );
  const picked = planScheduleAlarms(rows, items, normalizePolicy({ serious: false, include: ["checkin:2026-10-08"] }), NOW);
  check("one check-in can be allowed while serious is off", same(ids(picked.checkins), ["checkin:2026-10-08"]));

  const legacy = planScheduleAlarms(rows, items, open, NOW, false);
  check(
    "an APK without syncLockins keeps the plain alarms",
    legacy.lockins.length === 0 && legacy.schedules.some((a) => a.id === "schedule:gym"),
  );
  const silent = planScheduleAlarms(rows, items, normalizePolicy({ enabled: false, college: true }), NOW);
  check(
    "the master switch silences everything",
    silent.schedules.length === 0 && silent.lockins.length === 0 && silent.checkins.length === 0,
  );

  const untimed = planScheduleAlarms([weekly("viva", "COLLEGE", 2, null, null)], [block("viva")], open, NOW);
  check(
    "an untimed serious class still gets its day's check-in",
    same(untimed.checkins.map((a) => [a.id, a.triggerAt]), [["checkin:2026-10-07", at(7, 21, 30)]]) &&
      untimed.lockins.length === 0 && untimed.schedules.length === 0,
  );
  const junk = [null, 7, "x", { uid: 5, kind: "block" }, { kind: "block" }] as unknown as Partial<FocusItem>[];
  const tolerant = planScheduleAlarms(rows, junk, open, NOW);
  // Six, not seven: "gone" already started, so it has no alarm either way.
  check("malformed focus items are ignored", tolerant.lockins.length === 0 && tolerant.schedules.length === 6);
}

type Recorded = { method: string; payload: NativeAlarm[] };

function fakeBridge(withSerious: boolean): { bridge: NativeNotificationBridge; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (method: string) => (json: string) => {
    const payload = JSON.parse(json) as NativeAlarm[];
    calls.push({ method, payload });
    return payload.length;
  };
  const bridge: NativeNotificationBridge = {
    syncSchedules: record("syncSchedules"),
    syncTasks: record("syncTasks"),
    syncReminders: record("syncReminders"),
    firedReminders: () => "[]",
    acknowledgeFiredReminders: () => 0,
    ...(withSerious ? { syncLockins: record("syncLockins"), syncCheckins: record("syncCheckins") } : {}),
  };
  return { bridge, calls };
}

const last = (calls: Recorded[], method: string) => [...calls].reverse().find((call) => call.method === method)?.payload;

type FakeWindow = EventTarget & { JarvisNotifications?: NativeNotificationBridge };

async function bridgeSync(win: FakeWindow): Promise<void> {
  console.log("== syncNativeNotifications ==");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  let focusUp = true;
  let focusItems: unknown[] = [];
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/api/notifications/policy") return respond({ college: true, routine: true });
    if (path === "/api/focus") {
      if (!focusUp) throw new TypeError("Failed to fetch");
      return respond({ items: focusItems, events: [] });
    }
    if (path === "/api/reminders") return respond([]);
    return respond({ detail: "not found" }, 404);
  }) as typeof fetch;

  win.JarvisNotifications = undefined;
  check("no bridge: nothing to sync", (await syncNativeNotifications()) === false);

  // Tomorrow, whatever today is, so every alarm below is in the future.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await clearAll();
  await putRows("schedules", [
    weekly("int-gym", "ROUTINE", mondayIndex(tomorrow), "19:00", "20:00"),
    weekly("int-class", "COLLEGE", mondayIndex(tomorrow), "09:00", "10:00"),
  ]);
  focusItems = [block("int-gym")];

  const full = fakeBridge(true);
  win.JarvisNotifications = full.bridge;
  check("sync runs with the bridge", (await syncNativeNotifications()) === true);
  check("schedule: list leaves the serious block out", same(ids(last(full.calls, "syncSchedules") ?? []), ["schedule:int-class"]));
  check("lockin: list has it", same(ids(last(full.calls, "syncLockins") ?? []), ["lockin:int-gym"]));
  check(
    "checkin: list has tomorrow's evening",
    (last(full.calls, "syncCheckins") ?? []).some((a) => a.id === `checkin:${dayKey(tomorrow)}`),
    JSON.stringify(ids(last(full.calls, "syncCheckins") ?? [])),
  );
  check("focus items are cached", (storage.get("jarvis_focus_items_cache_v1") ?? "").includes("int-gym"));

  focusUp = false;
  await syncNativeNotifications();
  check(
    "backend down: the cached items still make the Lock-in",
    same(ids(last(full.calls, "syncLockins") ?? []), ["lockin:int-gym"]) &&
      same(ids(last(full.calls, "syncSchedules") ?? []), ["schedule:int-class"]),
  );
  focusUp = true;

  const before = full.calls.filter((call) => call.method === "syncSchedules").length;
  const results = await Promise.all([syncNativeNotifications(), syncNativeNotifications(), syncNativeNotifications()]);
  const runs = full.calls.filter((call) => call.method === "syncSchedules").length - before;
  check("overlapping calls coalesce into one run plus one rerun", results.every(Boolean) && runs === 2, `runs=${runs}`);

  const old = fakeBridge(false);
  win.JarvisNotifications = old.bridge;
  let threw = false;
  try {
    await syncNativeNotifications();
  } catch {
    threw = true;
  }
  check(
    "an older APK: no error, the serious block rings as before",
    !threw && same(ids(last(old.calls, "syncSchedules") ?? []), ["schedule:int-class", "schedule:int-gym"]),
  );
  await clearAll();
}

function actions(win: FakeWindow): void {
  console.log("== notificationActions ==");
  check(
    "parse: start with uid and day",
    same(parseNotificationAction('{"verb":"start","uid":"gym","occurrence":"2026-10-05"}'), {
      verb: "start", uid: "gym", occurrence: "2026-10-05",
    }),
  );
  check(
    "parse: a check-in needs no uid",
    same(parseNotificationAction('{"verb":"checkin","uid":"","occurrence":"2026-10-05"}'), {
      verb: "checkin", occurrence: "2026-10-05",
    }),
  );
  check(
    "parse: empty, junk, unknown verbs and uid-less Start/Done are ignored",
    ["", "  ", "{", "null", "[]", '"start"', '{"verb":"delete","uid":"x"}', '{"verb":"start"}', '{"verb":"done","uid":" "}']
      .every((raw) => parseNotificationAction(raw) === null) &&
      parseNotificationAction(undefined) === null && parseNotificationAction(42) === null,
  );
  check(
    "parse: a malformed day is dropped, the action kept",
    same(parseNotificationAction('{"verb":"done","uid":"x","occurrence":"5 Oct"}'), { verb: "done", uid: "x" }),
  );

  const queue = ['{"verb":"start","uid":"gym","occurrence":"2026-10-05"}'];
  win.JarvisNotifications = { ...fakeBridge(true).bridge, takeAction: () => queue.shift() ?? "" };
  const seen: NotificationAction[] = [];
  const stop = subscribeNotificationActions((action) => seen.push(action));
  check("a tap already waiting is delivered at once", seen.length === 1 && seen[0].verb === "start" && seen[0].uid === "gym");
  win.dispatchEvent(new Event("jarvis-notification-action"));
  check("an event with nothing waiting does nothing", seen.length === 1);
  queue.push('{"verb":"checkin","uid":"","occurrence":"2026-10-05"}');
  win.dispatchEvent(new Event("jarvis-notification-action"));
  check("a warm tap arrives with the event", seen.length === 2 && seen[1].verb === "checkin" && seen[1].uid === undefined);
  queue.push('{"verb":"done","uid":"essay","occurrence":"2026-10-05"}');
  win.dispatchEvent(new Event("jarvis-native-notifications-ready"));
  check("the bridge-ready event collects too", seen.length === 3 && seen[2].verb === "done");
  stop();
  queue.push('{"verb":"start","uid":"gym","occurrence":"2026-10-06"}');
  win.dispatchEvent(new Event("jarvis-notification-action"));
  check("after unsubscribe: no call, and the tap stays waiting", seen.length === 3 && queue.length === 1);

  win.JarvisNotifications = {
    ...fakeBridge(true).bridge,
    takeAction: () => {
      throw new Error("bridge gone");
    },
  };
  let survived = true;
  try {
    subscribeNotificationActions(() => {
      survived = false;
    })();
  } catch {
    survived = false;
  }
  check("a throwing bridge is survived", survived);

  win.JarvisNotifications = fakeBridge(false).bridge;
  let called = false;
  const stopOld = subscribeNotificationActions(() => {
    called = true;
  });
  win.dispatchEvent(new Event("jarvis-notification-action"));
  stopOld();
  check("an APK without takeAction never calls the handler", !called);
}

async function main(): Promise<number> {
  planner();
  // Set only now: lib/api.ts resolves its base URL at import, without a window.
  const win: FakeWindow = new EventTarget();
  (globalThis as unknown as { window: FakeWindow }).window = win;
  await bridgeSync(win);
  actions(win);
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
