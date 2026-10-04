/** Disposable in-memory UI test server for the phone app. No database,
 * credentials or provider calls; every record disappears when it stops.
 *
 *   node tests/phone-fixture.mjs
 *   NEXT_PUBLIC_API_BASE=http://127.0.0.1:8101 npm run dev   (then open /mobile/)
 *
 * Add ?voice-demo to the page URL in development to drive the voice screen
 * with a simulated session (no microphone, no socket). Never deploy this. */
import { createServer } from "node:http";

const pad = (n) => String(n).padStart(2, "0");
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
const at = (days, hour, minute = 0) => {
  const now = new Date();
  return iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute));
};
const clock = (hhmm) => {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};
const stamp = new Date().toISOString();
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const todayIndex = (new Date().getDay() + 6) % 7;
const nowHour = new Date().getHours();
let nextId = 500;

let tasks = [
  { id: 1, title: "Submit the DBMS assignment", priority: "HIGH", status: "PENDING", category: "College", due_date: at(-1, 23, 59) },
  { id: 2, title: "Finish the JARVIS phone redesign", priority: "HIGH", status: "IN_PROGRESS", category: "Project", due_date: at(0, 21) },
  { id: 3, title: "Review data structures notes", priority: "MEDIUM", status: "PENDING", category: "College", due_date: at(1, 18) },
  { id: 4, title: "Book the badminton court", priority: "LOW", status: "PENDING", category: "Personal", due_date: at(3, 17) },
  { id: 5, title: "Read the next chapter of Atomic Habits", priority: "MEDIUM", status: "PENDING", category: "Personal", due_date: null },
  { id: 6, title: "Call home", priority: "LOW", status: "PENDING", category: "GENERAL", due_date: null },
  { id: 7, title: "Ship the portfolio update", priority: "MEDIUM", status: "PENDING", category: "Project", due_date: at(9, 12) },
].map((task) => ({ ...task, uid: `task-${task.id}`, created_at: stamp, updated_at: stamp }));

const weekly = (id, kind, name, day, start, end, location = null, notes = null) => ({
  id, uid: `event-${id}`, kind, event_name: name, day_of_week: day, start_time: start, end_time: end,
  time_start: null, time_end: null, location, notes, created_at: stamp,
});
let events = [
  weekly(10, "COLLEGE", "Computer Networks", todayIndex, "09:30", "11:00", "Room C410"),
  weekly(11, "COLLEGE", "Data Structures lab", todayIndex, "13:40", "15:00", "Lab 2"),
  weekly(12, "COLLEGE", "Operating Systems", (todayIndex + 1) % 7, "11:10", "12:50", "Room B204"),
  weekly(13, "ROUTINE", "Gym", todayIndex, "06:30", "07:30"),
  weekly(14, "ROUTINE", "Django side project", todayIndex, "18:00", "19:45", null, "Ship one feature"),
  weekly(15, "ROUTINE", "Evening reading", todayIndex, "21:00", "22:00"),
  weekly(16, "ROUTINE", "Guitar practice", todayIndex, "21:30", "22:15"),
  weekly(17, "ROUTINE", "Long run", (todayIndex + 2) % 7, "06:00", "07:00"),
  { id: 20, uid: "event-20", kind: "SESSION", event_name: "Deep work: DBMS revision", day_of_week: null, start_time: null, end_time: null,
    time_start: at(0, Math.min(nowHour + 1, 22)), time_end: at(0, Math.min(nowHour + 2, 23)), location: "Library", notes: null, created_at: stamp },
  { id: 21, uid: "event-21", kind: "SESSION", event_name: "Hackathon prep", day_of_week: null, start_time: null, end_time: null,
    time_start: at(1, 16), time_end: at(1, 18), location: null, notes: null, created_at: stamp },
];

// Lock-in (serious mode): Gym done this morning, the side project ahead
// tonight, and Wednesday-style "Long run" that slipped two days ago.
const dayOf = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const focusItem = (event, mode) => ({
  uid: event.uid, kind: "block", mode, title: event.event_name, block_kind: event.kind, day_of_week: event.day_of_week,
  start_time: event.start_time, end_time: event.end_time, time_start: event.time_start, time_end: event.time_end,
  due_date: null, created_at: at(-14, 9),
});
let focusEvents = [];
let focusItems = [];
let missedList = [];
let focusId = 1;

let reminders = [
  { id: 1, text: "Drink water and stretch", due_at: at(0, Math.min(nowHour + 1, 23), 15), target_at: null, created_at: stamp, fired_at: null },
  { id: 2, text: "Pay the hostel fee", due_at: at(1, 10), target_at: null, created_at: stamp, fired_at: null },
  { id: 3, text: "Call the bank about the loan", due_at: at(-1, 17), target_at: null, created_at: stamp, fired_at: at(-1, 17) },
];

focusItems = [focusItem(events[3], "quick"), focusItem(events[4], "session"), focusItem(events[7], "session")];
focusEvents = [{ id: focusId++, item_uid: "event-13", title: "Gym", occurrence: dayOf(0), status: "done", started_at: null, finished_at: at(0, 7, 20), minutes: null }];
missedList = [{ uid: "event-17", title: "Long run", mode: "session", occurrence: dayOf(-2), weekday: (todayIndex + 5) % 7, start: "06:00", end: "07:00", minutes: 60 }];

let ideas = [
  { id: 1, uid: "idea-1", title: "Voice-first habit tracker", description: "Say what you did, JARVIS logs it. Weekly streak recap on Sunday nights.", tags: "", status: "ACTIVE", page_uid: null, created_at: stamp, updated_at: stamp },
  { id: 2, uid: "idea-2", title: "Campus lost & found bot", description: "Photo + location, matched by embeddings.", tags: "", status: "DRAFT", page_uid: "page-startups", created_at: stamp, updated_at: stamp },
  { id: 3, uid: "idea-3", title: "Study playlist generator", description: "", tags: "", status: "DRAFT", page_uid: null, created_at: stamp, updated_at: stamp },
];

const memory = (id, key, content, type, extra = {}) => ({
  id, uid: `memory-${id}`, key_concept: key, content, category: "LONG_TERM", memory_type: type, memory_status: "ACTIVE",
  confidence: 0.9, importance: 0.65, source_kind: "manual_ui", pinned: false, evidence_count: 1, tags: [], revision_count: 0,
  expires_at: null, created_at: stamp, updated_at: stamp, ...extra,
});
let memories = [
  memory(1, "Prefers morning classes", "Likes scheduling hard subjects before noon and keeping evenings for projects.", "SEMANTIC", { updated_at: at(0, 8) }),
  memory(2, "Always confirm before deleting", "Ask for confirmation before deleting any task, schedule entry or memory.", "PROCEDURAL", { pinned: true, importance: 0.85 }),
  memory(3, "Won the college hackathon", "Won first place at the college hackathon with a voice assistant demo.", "EPISODIC", { confidence: 0.8 }),
  memory(4, "Wants to learn Rust", "Mentioned wanting to learn Rust this semester.", "PROSPECTIVE", { memory_status: "CANDIDATE", confidence: 0.55 }),
  memory(5, "Exam week focus mode", "During exam week, keep replies short and skip small talk.", "PROCEDURAL", { expires_at: at(5, 23, 59) }),
];

let pages = [{ uid: "page-startups", title: "Startup ideas", kind: "CUSTOM", created_at: stamp, updated_at: stamp }];
let history = [];

function decorate(event) {
  if (event.kind === "SESSION") {
    const start = event.time_start?.slice(11, 16) ?? null;
    const end = event.time_end?.slice(11, 16) ?? null;
    const day = event.time_start ? WEEKDAYS[(new Date(event.time_start).getDay() + 6) % 7] : "";
    return { ...event, day_name: day, display_start: clock(start), display_end: clock(end), window: [clock(start), clock(end)].filter(Boolean).join(" - ") };
  }
  return { ...event, day_name: WEEKDAYS[event.day_of_week ?? 0], display_start: clock(event.start_time), display_end: clock(event.end_time), window: [clock(event.start_time), clock(event.end_time)].filter(Boolean).join(" - ") };
}

function conflicts() {
  const routine = events.filter((event) => event.kind !== "SESSION" && event.start_time);
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const found = [];
  for (let i = 0; i < routine.length; i++) {
    for (let j = i + 1; j < routine.length; j++) {
      const a = routine[i], b = routine[j];
      if (a.day_of_week !== b.day_of_week || a.kind !== "ROUTINE" || b.kind !== "ROUTINE") continue;
      const aEnd = a.end_time ? minutes(a.end_time) : minutes(a.start_time) + 60;
      const bEnd = b.end_time ? minutes(b.end_time) : minutes(b.start_time) + 60;
      if (minutes(a.start_time) < bEnd && minutes(b.start_time) < aEnd) found.push({ a_id: a.id, b_id: b.id, a_label: a.event_name, b_label: b.event_name, detail: "overlap" });
    }
  }
  return found;
}

function dashboard() {
  const key = at(0, 0).slice(0, 10);
  const today = events
    .filter((event) => event.kind === "SESSION" ? event.time_start?.startsWith(key) : event.day_of_week === todayIndex)
    .map((event) => event.kind === "SESSION" ? event : { ...event, time_start: `${key}T${event.start_time}:00`, time_end: `${key}T${event.end_time}:00` })
    .map(decorate)
    .sort((a, b) => a.time_start.localeCompare(b.time_start));
  const open = tasks.filter((task) => task.status !== "COMPLETED");
  const overdue = open.filter((task) => task.due_date && task.due_date < iso(new Date())).length;
  return {
    generated_at: stamp,
    tasks,
    counts: { PENDING: tasks.filter((t) => t.status === "PENDING").length, IN_PROGRESS: tasks.filter((t) => t.status === "IN_PROGRESS").length, COMPLETED: 0, OVERDUE: overdue },
    brief: {
      id: null,
      summary_text: `Heavy day: ${today.length} plans and ${open.length} open tasks. Knock out the DBMS assignment first.`,
      urgent_count: overdue,
      generated_at: stamp,
      bullets: [`${overdue} overdue task`, "Computer Networks at 9:30 AM in C410", "Gym and guitar overlap tonight", "Hostel fee due tomorrow"],
    },
    today,
    upcoming: [],
    schedule: {
      college: events.filter((e) => e.kind === "COLLEGE").map(decorate),
      routine: events.filter((e) => e.kind === "ROUTINE").map(decorate),
      session: events.filter((e) => e.kind === "SESSION").map(decorate),
      conflicts: conflicts(),
    },
    ideas,
    memories,
    note_pages: pages,
  };
}

const idFrom = (path) => path.split("/").pop();
const byId = (list, ref) => list.find((row) => String(row.id) === ref || row.uid === ref);

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const path = new URL(req.url, "http://localhost").pathname;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  let result = {};
  const method = req.method;

  if (path === "/api/health") result = { status: "ok", details: { client_owned_data: false }, api_key_configured: true, gemini_key_configured: false, openrouter_key_configured: true };
  else if (path === "/api/dashboard") result = dashboard();
  else if (path === "/api/voice/config") result = {
    enabled: true, stt_provider: "fixture", tts_provider: "fixture", language: "en-IN", max_audio_mb: 5, telugu_tts_engine: "sarvam", voice: "priya",
    languages: [{ code: "en-IN", label: "English", native: "English" }, { code: "hi-IN", label: "Hindi", native: "हिन्दी" }, { code: "te-IN", label: "Telugu", native: "తెలుగు" }, { code: "ta-IN", label: "Tamil", native: "தமிழ்" }],
    voices: [{ id: "priya", label: "Priya", gender: "female", note: "Warm" }, { id: "ritu", label: "Ritu", gender: "female", note: "Bright" }, { id: "arjun", label: "Arjun", gender: "male", note: "Calm" }],
  };
  else if (path.startsWith("/api/voice/")) result = { ok: true };
  else if (path === "/api/chat/history" && method === "GET") result = history;
  else if (path === "/api/chat/history" && method === "DELETE") { history = []; result = { ok: true }; }
  else if (path === "/api/chat" && method === "POST") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const reply = "Here's the play for the rest of today:\n\n1. **DBMS assignment first** — it's already late, so ship it before anything else.\n2. Then an hour on the phone redesign.\n3. Gym and guitar overlap tonight, so pick one.\n\n- Hostel fee is due tomorrow\n- Keep water nearby\n\n_This is a simulated reply from the isolated design fixture._";
    history.push({ id: nextId++, role: "user", text: body.message ?? "", created_at: stamp });
    const chunks = reply.match(/.{1,26}(?:\s|$)|.{1,26}/gs) || [reply];
    let index = 0;
    const timer = setInterval(() => {
      if (index < chunks.length) res.write(`event: text\ndata: ${JSON.stringify({ text: chunks[index++] })}\n\n`);
      else {
        clearInterval(timer);
        history.push({ id: nextId++, role: "assistant", text: reply, created_at: stamp });
        res.end('event: done\ndata: {"refresh":[],"stop_reason":"end","usage":{},"text":""}\n\n');
      }
    }, 90);
    res.on("close", () => clearInterval(timer));
    return;
  }
  else if (path === "/api/briefs/generate") result = dashboard().brief;
  else if (path === "/api/reminders" && method === "GET") result = reminders;
  else if (path === "/api/reminders" && method === "POST") { const row = { ...body, id: nextId++, target_at: null, fired_at: null, created_at: stamp }; reminders.push(row); result = row; }
  else if (/^\/api\/reminders\/\d+$/.test(path)) {
    const id = Number(idFrom(path));
    if (method === "DELETE") reminders = reminders.filter((row) => row.id !== id);
    else { reminders = reminders.map((row) => (row.id === id ? { ...row, ...body } : row)); result = reminders.find((row) => row.id === id); }
  }
  else if (path === "/api/tasks" && method === "POST") { const id = nextId++; const row = { category: "GENERAL", ...body, category: (body.category || "GENERAL").toUpperCase(), id, uid: `task-${id}`, status: "PENDING", created_at: new Date().toISOString(), updated_at: stamp }; tasks.push(row); result = row; }
  else if (path === "/api/tasks/toggle") {
    const task = tasks.find((row) => row.id === body.task_id);
    const cleared = body.status === "COMPLETED";
    if (task && cleared) tasks = tasks.filter((row) => row !== task);
    else if (task) task.status = body.status;
    result = { task: { ...task, status: body.status }, cleared, counts: dashboard().counts, brief: dashboard().brief };
  }
  else if (/^\/api\/tasks\/[\w-]+$/.test(path)) {
    const row = byId(tasks, idFrom(path));
    if (method === "DELETE") tasks = tasks.filter((task) => task !== row);
    else if (row) { const { clear_due_date, ...changes } = body; Object.assign(row, changes, clear_due_date ? { due_date: null } : {}, { category: (changes.category || row.category || "GENERAL").toUpperCase() }); }
  }
  else if (path === "/api/schedule" && method === "POST") { const id = nextId++; const row = { ...body, id, uid: `event-${id}`, created_at: stamp }; events.push(row); result = decorate(row); }
  else if (/^\/api\/schedule\/[\w-]+$/.test(path)) {
    const row = byId(events, idFrom(path));
    if (method === "DELETE") events = events.filter((event) => event !== row);
    else if (row) Object.assign(row, body);
  }
  else if (path === "/api/ideas" && method === "POST") { const id = nextId++; const row = { tags: "", status: "DRAFT", ...body, id, uid: `idea-${id}`, created_at: stamp, updated_at: new Date().toISOString() }; ideas.push(row); result = row; }
  else if (/^\/api\/ideas\/[\w-]+$/.test(path)) {
    const row = byId(ideas, idFrom(path));
    if (method === "DELETE") ideas = ideas.filter((idea) => idea !== row);
    else if (row) Object.assign(row, body, { updated_at: new Date().toISOString() });
  }
  else if (path === "/api/memories" && method === "POST") { const id = nextId++; const row = memory(id, body.key_concept, body.content, body.memory_type || "SEMANTIC", { ...body, updated_at: new Date().toISOString() }); memories.push(row); result = row; }
  else if (/^\/api\/memories\/[\w-]+$/.test(path)) {
    const row = byId(memories, idFrom(path));
    if (method === "DELETE") memories = memories.filter((item) => item !== row);
    else if (row) Object.assign(row, body, { updated_at: new Date().toISOString() });
  }
  else if (path === "/api/note-pages" && method === "POST") {
    const row = { ...body, updated_at: new Date().toISOString() };
    pages = [...pages.filter((page) => page.uid !== row.uid), row];
    result = row;
  }
  else if (/^\/api\/note-pages\/[\w-]+$/.test(path) && method === "DELETE") {
    const uid = idFrom(path);
    pages = pages.filter((page) => page.uid !== uid);
    ideas = ideas.map((idea) => (idea.page_uid === uid ? { ...idea, page_uid: null } : idea));
  }
  else if (path === "/api/focus" && method === "GET") result = { items: focusItems, events: focusEvents };
  else if (path === "/api/focus/missed") result = { missed: missedList };
  else if (path === "/api/focus/week") result = {
    week_of: dayOf(-todayIndex),
    this: { minutes: 260, done: focusEvents.filter((e) => e.status === "done").length + 9, skipped: 3, kept: 0.8 },
    last: { minutes: 340, done: 11, skipped: 5, kept: 0.69, to_date: 190 },
    today: { done: focusEvents.filter((e) => e.status === "done").length, skipped: 0, pending: 1 },
    streak: 3, items: focusItems.length,
  };
  else if (path === "/api/focus/stats") result = {
    days: 7, done: 9, skipped: 2, rate: 0.818, minutes: 640, streak: 3, best_streak: 5, perfect_days: 3,
    today: { done: focusEvents.filter((e) => e.status === "done").length, skipped: 0, pending: 1 },
    series: Array.from({ length: 7 }, (_, i) => ({ date: dayOf(i - 6), done: i % 3 ? 1 : 2, skipped: i === 2 ? 1 : 0, minutes: 60 + i * 10 })),
    items: [], running: focusEvents.find((e) => e.status === "running") ?? null,
  };
  else if (path === "/api/focus/catchup" && method === "POST") {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const miss = missedList[0];
    result = miss ? {
      missed: missedList,
      sessions: [{ title: miss.title, date: dayOf(1), start: "06:15", end: "07:00", minutes: 45, covers: { uid: miss.uid, occurrence: miss.occurrence, mode: miss.mode } }],
      left: missedList.slice(1),
      message: "Your long run slipped. Tomorrow 6:15 AM, 45 minutes. Short, sharp, no excuses.",
      source: "ai",
    } : { missed: [], sessions: [], left: [], message: "Nothing slipped. Clean week so far.", source: "none" };
  }
  else if (path === "/api/focus/catchup/settle" && method === "POST") {
    const settled = [...(body.moved ?? []), ...(body.dropped ?? [])];
    missedList = missedList.filter((miss) => !settled.some((ref) => ref.uid === miss.uid && ref.occurrence === miss.occurrence));
    result = { recorded: settled.length };
  }
  else if (/^\/api\/focus\/items\/[\w-]+$/.test(path) && method === "PUT") {
    const uid = idFrom(path);
    focusItems = [...focusItems.filter((item) => item.uid !== uid), { ...body, uid, created_at: stamp }];
    result = focusItems.at(-1);
  }
  else if (/^\/api\/focus\/items\/[\w-]+\/(start|done|reset)$/.test(path)) {
    const parts = path.split("/");
    const uid = parts[4];
    const verb = parts[5];
    const occurrence = body.occurrence ?? dayOf(0);
    const item = focusItems.find((row) => row.uid === uid);
    if (verb === "reset") { focusEvents = focusEvents.filter((e) => !(e.item_uid === uid && e.occurrence === occurrence)); result = { removed: 1 }; }
    else if (verb === "start") { const row = { id: focusId++, item_uid: uid, title: item?.title ?? "Lock-in", occurrence, status: "running", started_at: iso(new Date()), finished_at: null, minutes: null }; focusEvents.push(row); result = row; }
    else {
      const running = focusEvents.find((e) => e.item_uid === uid && e.occurrence === occurrence && e.status === "running");
      if (running) { running.status = "done"; running.finished_at = iso(new Date()); running.minutes = 25; result = running; }
      else { const row = { id: focusId++, item_uid: uid, title: item?.title ?? "Lock-in", occurrence, status: "done", started_at: null, finished_at: iso(new Date()), minutes: null }; focusEvents.push(row); result = row; }
    }
  }
  else if (path === "/v1/plan/week" && method === "POST") {
    // A stand-in for the gateway planner (JARVIS Public onboarding previews).
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const timesFor = (p) => (p >= 11 ? 7 : p >= 9 ? 6 : p >= 7 ? 4 : p >= 5 ? 3 : p >= 3 ? 2 : 1);
    const starts = ["06:30", "17:30", "19:15", "21:00", "07:45", "16:45"];
    const plus = (clockText, minutes) => { const [h, m] = clockText.split(":").map(Number); const total = h * 60 + m + minutes; return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`; };
    const phase = (clockText) => { const h = Number(clockText.slice(0, 2)); return h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night"; };
    const blocks = [];
    (body.activities ?? []).forEach((activity, index) => {
      const times = timesFor(activity.points ?? 5);
      const length = (activity.points ?? 5) >= 9 ? 90 : 60;
      const start = starts[index % starts.length];
      for (let k = 0; k < times; k += 1) {
        const day = Math.floor((k * 7) / times + index) % 7;
        blocks.push({ activity: activity.name, day, start, end: plus(start, length), phase: phase(start) });
      }
    });
    if (body.freeTime) for (let day = 0; day < 7; day += 1) blocks.push({ activity: "Free time", day, start: day >= 5 ? "15:00" : "22:00", end: day >= 5 ? "16:30" : "22:45", phase: day >= 5 ? "afternoon" : "night", free: true });
    const perActivity = (body.activities ?? []).map((activity) => { const mine = blocks.filter((b) => b.activity === activity.name); return { activity: activity.name, timesPerWeek: mine.length, minutesPerSession: (activity.points ?? 5) >= 9 ? 90 : 60 }; });
    result = { blocks, summary: "Big rocks in the mornings, the rest after college, Sunday light.", perActivity };
  }
  else if (path === "/api/connectors") result = [];
  else if (path === "/api/location") result = { ok: true };
  else { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ detail: "Not available in the isolated UI fixture" })); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result ?? {}));
}).listen(8101, "127.0.0.1", () => console.log("Disposable phone UI fixture: http://127.0.0.1:8101 (sample data only)"));
