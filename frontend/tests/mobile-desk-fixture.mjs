/** Disposable in-memory UI test server. No database, credentials or provider calls.
 * Run on loopback :8101 and set NEXT_PUBLIC_API_BASE for the preview only.
 * All records disappear when the process ends. Never deploy this server. */
import { createServer } from "node:http";

const stamp = new Date().toISOString();
let tasks = [
  { id: 1, title: "Finish the JARVIS mobile layout", priority: "HIGH", status: "IN_PROGRESS", category: "Project" },
  { id: 2, title: "Review data structures notes", priority: "MEDIUM", status: "PENDING", category: "College" },
  { id: 3, title: "Take the evening walk", priority: "LOW", status: "PENDING", category: "Personal" },
  { id: 4, title: "Read the next chapter", priority: "MEDIUM", status: "PENDING", category: "Personal" },
].map(task => ({ ...task, due_date: null, created_at: stamp, updated_at: stamp }));
const day = (new Date().getDay() + 6) % 7;
const schedule = {
  college: [{ id: 10, event_name: "Computer networks", kind: "COLLEGE", location: "Room C410", start_time: "10:00", end_time: "11:00" }],
  routine: [{ id: 11, event_name: "Evening reading", kind: "ROUTINE", location: null, start_time: "21:00", end_time: "23:59" }],
  session: [], conflicts: [],
};
for (const name of ["college", "routine"]) schedule[name] = schedule[name].map(event => ({ ...event, day_of_week: day, day_name: new Date().toLocaleDateString("en-GB", { weekday: "long" }), time_start: null, time_end: null, notes: null, created_at: stamp, display_start: event.start_time, display_end: event.end_time, window: `${event.start_time} - ${event.end_time}` }));
let reminders = [{ id: 1, text: "Call home", due_at: "2026-12-20T18:00:00", target_at: null, created_at: stamp, fired_at: null }];
const brief = { id: null, summary_text: "Preview data only.", urgent_count: 0, generated_at: stamp, bullets: [] };
function dashboard() { return { generated_at: stamp, tasks, counts: { PENDING: tasks.filter(t => t.status === "PENDING").length, IN_PROGRESS: tasks.filter(t => t.status === "IN_PROGRESS").length, COMPLETED: tasks.filter(t => t.status === "COMPLETED").length, OVERDUE: 0 }, brief, today: [...schedule.college, ...schedule.routine], upcoming: [], schedule, ideas: [{ id: 1, title: "A thought for the next build", description: "Make the small, everyday actions feel effortless.", tags: "", status: "ACTIVE", created_at: stamp, updated_at: stamp }], memories: [], note_pages: [] }; }
let nextId = 100;
createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const path = new URL(req.url, "http://localhost").pathname;
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  let result = {};
  if (path === "/api/health") result = { status: "ok", client_owned_data: false };
  else if (path === "/api/dashboard") result = dashboard();
  else if (path === "/api/voice/config") result = { enabled: false };
  else if (path === "/api/chat/history") result = [];
  else if (path === "/api/briefs/generate") result = brief;
  else if (path === "/api/reminders" && req.method === "GET") result = reminders;
  else if (path === "/api/reminders" && req.method === "POST") { const row = { ...body, id: nextId++, target_at: null, fired_at: null, created_at: stamp }; reminders.push(row); result = row; }
  else if (/^\/api\/reminders\/\d+$/.test(path)) { const id = Number(path.split("/").pop()); if (req.method === "DELETE") reminders = reminders.filter(row => row.id !== id); else reminders = reminders.map(row => row.id === id ? { ...row, ...body } : row); }
  else if (path === "/api/tasks" && req.method === "POST") { const row = { ...body, id: nextId++, status: "PENDING", created_at: stamp, updated_at: stamp }; tasks.push(row); result = row; }
  else if (path === "/api/tasks/toggle") { const task = tasks.find(task => task.id === body.task_id); if (task) task.status = body.status; result = { task, cleared: false, counts: dashboard().counts, brief }; }
  else if (/^\/api\/tasks\/\d+$/.test(path)) { const id = Number(path.split("/").pop()); if (req.method === "DELETE") tasks = tasks.filter(task => task.id !== id); else tasks = tasks.map(task => task.id === id ? { ...task, ...body } : task); }
  else if (path === "/api/connectors") result = [];
  else { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ detail: "Not available in the isolated UI fixture" })); return; }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
}).listen(8101, "127.0.0.1", () => console.log("Disposable mobile UI fixtures: http://127.0.0.1:8101 (no real data)"));
