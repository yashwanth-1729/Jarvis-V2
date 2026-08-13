# JARVIS — v1 Command Center

A persistent AI personal command center. Split screen: a chat + tool-execution
console on the left, a live work surface on the right — driven by text **or
voice**.

Built on FastAPI + `aiosqlite` + **Sarvam AI** (`sarvam-105b` for chat with tool
calling, `saaras` for speech-to-text, `bulbul` for text-to-speech) and Next.js 14
+ TypeScript + Tailwind.

```
┌────┬────────────────────┬───────────────────────────────────────────────┐
│ ◈  │ CONSOLE          ● │ What's up   04      05      01      02        │
│    │                    │             URGENT  OPEN    ACTIVE  OVERDUE   │
│ ▣  │ YOU          23:06 │  01 Handle Renew the domain (1d overdue)      │
│ ▤  │ ┌────────────────┐ │  02 Handle Review the PR backlog (6h overdue) │
│ ▥  │ │ Renew the …    │ ├───────────────────────────────────────────────┤
│    │ └────────────────┘ │ Task Board                      synced 23:09  │
│    │                    │ ─────────────────────────────────────────────  │
│    │ JARVIS             │ TASK              CATEGORY   DUE        STATE │
│    │ │ ▸ add_task     ✓ │▐ ● Renew the domain  FINANCE  Yest 10:00  OPEN │
│    │ │ Added Renew the  │▐ ● Review PR backlog WORK     Today 16:30 OPEN │
│    │ │ domain as high…  │▎ ◐ Migrate pipeline  WORK     Sat 12:00   ACTV │
│    │                    │                                               │
│ ●  │ [ Ask JARVIS…  ↵ ] │                                               │
└────┴────────────────────┴───────────────────────────────────────────────┘
  rail        console                    work surface
```

---

## Quick start

**1. Get an API key** — <https://dashboard.sarvam.ai>

**2. Install and run**

Windows (PowerShell):

```powershell
.\run.ps1 -Setup
```

macOS / Linux / Git Bash:

```bash
chmod +x run.sh && ./run.sh setup
```

The setup step creates `backend/.venv`, installs both dependency sets, and
copies `.env.example` → `.env`.

**3. Add your key** to `backend/.env` (gitignored — never put it in source):

```
SARVAM_API_KEY=sk_...
```

**4. Start both servers** (subsequent runs skip setup):

```powershell
.\run.ps1          # or: ./run.sh
```

- Frontend → <http://localhost:3000>
- Backend → <http://127.0.0.1:8000>, interactive API docs at `/docs`

To run them separately:

```bash
cd backend && .venv/Scripts/python -m uvicorn main:app --reload --port 8000
cd frontend && npm run dev
```

---

## Architecture

```
jarvis/
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routers + response schemas
│   │   ├── core/         # settings, time helpers
│   │   ├── db/           # schema.sql, async engine, CRUD
│   │   ├── llm/          # system prompt, tool defs, streaming agent loop
│   │   ├── providers/    # vendor adapters (base protocols + sarvam)
│   │   └── services/     # proactive brief generator, context synthesizer
│   ├── storage/          # SQLite database lives here
│   ├── main.py           # app factory, CORS, lifespan
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── app/          # App Router entry (layout, page, globals.css tokens)
│       ├── components/
│       │   ├── ui/       # Primitives + the ambient shader
│       │   ├── Rail      # Icon nav + status lamp
│       │   ├── Chat      # Console: stream, tool log, composer
│       │   ├── SignalBar # "What's up" instrumentation band
│       │   └── …         # Dashboard, TaskTable, ScheduleTimeline, IdeaGrid
│       ├── lib/          # API client + SSE reader, formatting utils
│       └── types/        # TS mirror of the backend schemas
├── run.sh / run.ps1
└── README.md
```

### Data flow

```
Browser ──POST /api/chat──▶ agent loop ──▶ ChatProvider ──▶ Sarvam
   ▲                            │                          /v1/chat/completions
   │                            ├── tool_call ──▶ handler ──▶ SQLite
   └──── SSE events ────────────┘                             │
    text · thinking · tool_use · tool_result · refresh         │
                    │                                          │
                    └── "refresh" tells the browser which ─────┘
                        panels to refetch

Mic ──▶ POST /api/voice/transcribe ──▶ STTProvider ──▶ saaras  ──▶ composer
Reply ─▶ POST /api/voice/speak      ──▶ TTSProvider ──▶ bulbul  ──▶ playback
```

The agent streams tokens as they arrive, executes every tool call against SQLite,
and feeds the results back inside the same turn — so a single message can create
a task, block a calendar slot and report back without a round trip to the user.

### Providers

The agent never imports a vendor SDK. It speaks the OpenAI-shaped message format
defined by the protocols in `app/providers/base.py`, and each capability resolves
independently from env:

| Capability | Protocol | v1 | Switch |
| --- | --- | --- | --- |
| Chat | `ChatProvider` | Sarvam `sarvam-105b` | `JARVIS_CHAT_PROVIDER` |
| Speech-to-text | `STTProvider` | Sarvam `saaras:v4` | `JARVIS_STT_PROVIDER` |
| Text-to-speech | `TTSProvider` | Sarvam `bulbul:v3` | `JARVIS_TTS_PROVIDER` |

That makes the roadmap additive rather than a rewrite:

- **v2 — Gangi for speech.** Add `app/providers/gangi.py` implementing
  `STTProvider` / `TTSProvider`, register it in `app/providers/__init__.py`, set
  `JARVIS_STT_PROVIDER=gangi` and `JARVIS_TTS_PROVIDER=gangi`. Chat is untouched.
- **v3 — Anthropic / OpenAI for chat.** Add a `ChatProvider` that translates the
  OpenAI-shaped messages at its own boundary and flip `JARVIS_CHAT_PROVIDER`.
  Nothing in the agent loop, API layer or UI changes.

---

## Design system

**"Graphite & Ember"** — a warm-ink command center. The brief was explicitly to
avoid the slate-and-cyan look that reads as machine-generated, so the palette,
type stack and layout all move deliberately away from it.

**Direction:** Swiss Modernism (strict grid, mathematical spacing, hairline
rules, zero decoration, a single accent) at data-dense-dashboard density
(11–13px UI text, 40px rows, 12px padding).

**Colour** — tokens live in `src/app/globals.css` as HSL triplets and are
consumed through Tailwind with full opacity-modifier support. One accent carries
brand, focus and "active work"; semantic hues are rationed to two.

| Token | Value | Role | Contrast on canvas |
| --- | --- | --- | --- |
| `surface-0` | `#0A0908` | Canvas — warm near-black, not blue-slate | — |
| `ink` | `#F1ECE3` | Primary text | **17.1:1** |
| `ink-muted` | `#C8C0B6` | Secondary text | **11.3:1** |
| `ink-dim` | `#A69C90` | Tertiary text | **7.5:1** |
| `ink-faint` | `#877D70` | Smallest usable text | **5.0:1** |
| `ember` | `#E8A33D` | Brand · focus ring · active work | **9.2:1** |
| `critical` | `#E5484D` | Overdue · P1 · destructive | **5.1:1** |
| `positive` | `#4CC38A` | Completed | **8.9:1** |

Every foreground token clears WCAG AA (4.5:1) against the canvas — measured in
the browser, not estimated.

**Type** — a tri-stack, self-hosted via `next/font` (no render-blocking request,
no FOIT). A single-family Inter system is the generic tell; a display face with
character plus tabular mono for data is what production tools actually do.

| Family | Role |
| --- | --- |
| Space Grotesk | Brand, view titles, section headings |
| Inter | All UI and prose |
| JetBrains Mono | Every number, timestamp, ID, key and tool name |

All numerics use `font-variant-numeric: tabular-nums` (`.tnum`) so columns never
jitter as values change.

**Layout** — `rail · console · work surface` (`56px / 400px / 1fr`), replacing
the symmetric 40/60 split. View switching lives in the rail, which frees the
work surface of a tab strip and gives the product an identity at a glance. Below
`lg` the console and work surface stack while the rail stays fixed.

**Colour is never the only signal.** Task priority is encoded as a left edge bar
*and* a `P1`/`P2`/`P3` label *and* screen-reader text; status carries a distinct
glyph (dot / dash / check) as well as a badge.

**Motion** — micro-interactions are 150–300ms with `ease-out`; the ambient
shader runs at 0.34× base speed. `prefers-reduced-motion` is honoured globally
in CSS *and* inside the shader, which renders a single static frame and stops
scheduling `requestAnimationFrame` entirely rather than merely slowing down.

### The ambient shader

`src/components/ui/simplex-noise-first-contact.tsx` is the 21st.dev Shader
Builder component, retuned rather than dropped in as-is:

- `UNIFORMS.colors` remapped to the Graphite & Ember ramp (ink → graphite →
  ember brown → vermilion → amber), weighted dark so it reads as depth behind
  the UI instead of a rainbow.
- `prefers-reduced-motion` support added (the upstream component animates
  unconditionally).
- `speed` / `paused` props read through refs, so retuning does not tear down and
  re-create the WebGL context.

It renders at 28% opacity behind an 85% scrim plus a hairline grid texture. Every
surface above it is opaque, so the contrast ratios above hold regardless of what
the field is doing underneath. It also stops rendering when the tab is hidden or
scrolled out of view.

> Component path is `src/components/ui/` — this project's `@/components/ui`
> alias, matching the shadcn convention (`tsconfig.json` maps `@/* → ./src/*`).

---

## Database

SQLite via `aiosqlite`, at `backend/storage/jarvis_memory.db`. Created
automatically on first boot from [`app/db/schema.sql`](backend/app/db/schema.sql).

| Table | Purpose |
| --- | --- |
| `tasks` | title, category, priority, status, due date |
| `schedules` | event name, start/end, location, notes |
| `memories` | key concept, category, content — one row per concept |
| `ideas` | title, description, tags, status |
| `proactive_briefs` | generated summary text + urgent counter |
| `chat_messages` | conversation persistence (see *Design notes*) |

**Concurrency.** WAL mode with a bounded pool of read connections plus one
dedicated writer guarded by an `asyncio.Lock` — the shape SQLite actually
supports. Connections are opened once at startup and closed at shutdown; the
acquire helpers are context managers, so a connection cannot leak.

**Timestamps.** Every `DATETIME` holds a local-time naive ISO string
(`YYYY-MM-DDTHH:MM:SS`). They sort lexicographically, so "due today" and
"next 7 days" are index range scans, and the browser parses them as local time
with no timezone conversion.

---

## Tools

| Tool | What it does |
| --- | --- |
| `add_task` | Create a task with priority, category and due date |
| `update_task_status` | Move a task between PENDING / IN_PROGRESS / COMPLETED |
| `get_dashboard_summary` | Read pending tasks, today's schedule and active ideas |
| `save_idea_or_note` | Store an idea card, or a durable memory keyed on its title |
| `search_memory` | Case-insensitive search across memories, ideas and tasks |
| `generate_proactive_brief` | Rank all commitments into a 3-bullet action summary |
| `add_schedule_event` | Put an event on the calendar *(addition — see below)* |

Each tool has a Pydantic input model, a JSON schema, and an async handler in
[`app/llm/tools.py`](backend/app/llm/tools.py). Handlers never raise: a bad input
or a missing ID comes back as an error result the model can recover from inside
the same turn.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Stream one agent turn as SSE |
| `GET` | `/api/chat/history` | Replay the visible transcript |
| `DELETE` | `/api/chat/history` | Clear the conversation |
| `GET` | `/api/dashboard` | Tasks, schedule, ideas, memories, brief, counts |
| `POST` | `/api/tasks/toggle` | Set or cycle a task's status |
| `POST` | `/api/briefs/generate` | Force a fresh proactive brief |
| `GET` | `/api/voice/config` | Whether voice is available, and which vendors |
| `POST` | `/api/voice/transcribe` | multipart audio → `{ text, language_code }` |
| `POST` | `/api/voice/speak` | `{ text }` → `audio/wav` bytes |
| `GET` | `/api/health` | Config and connectivity check |

### SSE event types on `/api/chat`

| Event | Payload |
| --- | --- |
| `start` | `{ model }` |
| `text` | `{ text }` — an assistant token |
| `thinking` | `{ text }` — summarized reasoning |
| `tool_use` | `{ id, name }` — execution started |
| `tool_result` | `{ id, name, ok, summary, display }` |
| `refresh` | `{ domains }` — which dashboard panels are now stale |
| `error` | `{ message }` |
| `done` | `{ stop_reason, refresh, usage, text }` |

---

## Configuration

All backend settings live in `backend/.env` (see `.env.example` for the full
annotated list). The ones worth knowing:

| Variable | Default | Notes |
| --- | --- | --- |
| `SARVAM_API_KEY` | — | **Required** |
| `SARVAM_CHAT_MODEL` | `sarvam-105b` | Or `sarvam-105b-conversations` — see below |
| `SARVAM_STT_MODEL` | `saaras:v4` | Speech-to-text |
| `SARVAM_TTS_MODEL` | `bulbul:v3` | Text-to-speech |
| `SARVAM_TTS_SPEAKER` | `shubh` | **Speaker sets differ per model version** |
| `SARVAM_LANGUAGE` | `en-IN` | BCP-47; STT hint and TTS output language |
| `SARVAM_REASONING_EFFORT` | `low` | `low`/`medium`/`high`, or blank for the default |
| `JARVIS_MAX_TOKENS` | `4000` | **Reasoning bills against this** — see below |
| `JARVIS_MAX_TOOL_ITERATIONS` | `8` | Runaway-loop backstop |
| `JARVIS_HISTORY_LIMIT` | `40` | Messages replayed to the model per turn |
| `JARVIS_VOICE_ENABLED` | `true` | Hides the mic and speaker controls when false |
| `JARVIS_CORS_ORIGINS` | `localhost:3000` | Must include the frontend's origin |

The frontend reads one variable, `NEXT_PUBLIC_API_BASE`, from
`frontend/.env.local`.

---

## Design notes

**Reasoning tokens bill against `max_tokens` — this bites.** `sarvam-105b`
reasons before answering, and that reasoning counts toward the completion budget.
At `max_tokens: 100` the API returns HTTP 200 with `content: null` and
`finish_reason: "length"` — a *successful* response containing nothing, because
the budget was spent thinking. A trivial "say hello world" consumed 518
completion tokens in testing. Hence the 4000 floor, enforced in `config.py`; if
it still happens the agent surfaces an explicit message naming the setting rather
than showing an empty reply.

**Reasoning is streamed, not hidden.** Sarvam emits it as `reasoning_content`
deltas alongside `content`, which the agent forwards as its own `thinking` SSE
event. The console renders it in a collapsed block you can expand per message.

**`sarvam-105b-conversations` is the voice-latency variant.** On the same prompt
the standard model produced 1,393 characters of reasoning; the conversations
variant produced **zero** and answered immediately. If you drive JARVIS mostly by
voice, set `SARVAM_CHAT_MODEL=sarvam-105b-conversations` and accept shallower
reasoning on complex agentic turns.

**TTS speaker sets differ between model versions.** `anushka` is valid for
`bulbul:v2` and rejected by `bulbul:v3`. Rather than fail the request, the
provider retries once without the speaker field, logs a warning naming the
setting, and lets the model's own default answer — so a model swap degrades to a
different voice instead of a broken button.

**Voice is a thin layer over the existing loop.** The mic records with
`MediaRecorder`, POSTs the clip to `/api/voice/transcribe`, and *appends* the
transcript to the composer rather than replacing it — so dictation can extend a
typed draft. Playback runs through one shared `<audio>` element, so starting a
new reply stops whatever was already speaking, and object URLs are revoked on
replacement rather than leaking across a long session. If the backend reports
voice unavailable, or the browser lacks `MediaRecorder`, both controls are hidden
rather than shown broken.

**Two additions beyond the original spec**, both flagged rather than folded in
silently:

- **`add_schedule_event` (7th tool).** The spec lists a `schedules` table and a
  Schedule tab but no tool that writes to it, so the calendar would have been
  permanently empty. Chat is the only input surface in v1, so it needed a write
  path.
- **`chat_messages` table + `/api/chat/history`.** "Persistent" implies the
  conversation survives a refresh or a server restart. Content blocks are stored
  verbatim so a restarted process replays the exact turn structure — including
  `tool_use` / `tool_result` pairs — back to the model.

**Known scope gaps** (spec-faithful, not oversights): there is no delete for
tasks, events or ideas, and no tool to edit a task's title or due date after
creation — the spec defines status toggling as the only mutation affordance.
Records can be re-created or completed, not removed.

---

## Verification

**Backend** — [`tests/smoke_test.py`](backend/tests/smoke_test.py) covers the
schema, all seven tool handlers including their error paths, the provider
registry, the brief generator, the context synthesizer, history round-tripping
and every HTTP route. It runs against a throwaway database and makes **no
network calls**, so it is safe to run at any time:

```bash
cd backend
.venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python tests/smoke_test.py
```

**Frontend**:

```bash
cd frontend
npx tsc --noEmit     # type check
npm run build        # production build + lint
```

All three pass clean as of this commit.
