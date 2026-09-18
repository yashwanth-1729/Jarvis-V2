# Desktop JARVIS: from tool-caller to autonomous operator

*Written 2026-09-19 after reading the current code. Goal: make requests like
"download Antigravity, install it and set it up" or "do X on my PC while I'm
away" actually work end to end, safely.*

---

## TL;DR

Desktop JARVIS already has most of the **hands** it needs (35 real computer
tools: shell, files, Windows UI automation, its own browser, apps, clipboard).
Codex has also built most of the **skeleton** for long-running work (durable
runs, approvals, verification, leases, recovery) in `app/agent_runtime/`.

What is missing is the **brain and the plumbing between them**:

1. Work today is confined to **one chat turn**: at most 8 tool calls and 240
   seconds. An install-and-setup job needs dozens of steps and several minutes.
2. The chat model (gpt-4.1-nano) is chosen for fast voice replies. It is too
   small to plan and recover across a 30-step job.
3. The agent runtime is **fixture-only and closed by default**. None of it
   drives real tools yet.
4. There is no plan → act → verify → checkpoint loop, no "resume after
   failure", and no way to ask for your approval mid-job from your phone.
5. JARVIS can only "see" apps through the Windows accessibility tree. Many
   modern apps (Electron, custom UIs, installers) expose little there.

Closing those five gaps, in the phased order below, gets you to reliable
high-level autonomous tasks. Nothing needs to be rewritten.

---

## 1. What desktop JARVIS can do today (verified in code)

Tool registry: `backend/app/llm/tools.py`. The 35 `capability="system"` tools are
enabled on desktop only (`system_tools_enabled` is forced off on Android).

| Area | Tools | Notes |
|---|---|---|
| Shell | `run_command` | Two-step: describes the command, runs only with `confirmed=true`. |
| Files | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `find_files`, `disk_usage` | Full filesystem reach. |
| Apps & OS | `launch_app`, `close_app` (two-step), `open_path`, `list_processes`, `send_hotkey`, `clipboard_get/set` | `tools_os_control.py`. |
| Windows UI | `ui_list_windows`, `ui_focus_window`, `ui_inspect`, `ui_find_element`, `ui_click`, `ui_set_text`, `ui_get_text`, `ui_press_key`, `ui_toggle`, `ui_select` | pywinauto / UI Automation tree, elements addressed as `[eN]`. |
| Browser | `browser_open`, `browser_navigate`, `browser_inspect`, `browser_find`, `browser_click`, `browser_type`, `browser_submit`, `browser_get_text`, `browser_current_url`, `browser_title` | Playwright, a **separate isolated Chromium** (not your logged-in Chrome). |
| Web | `web_search`, `fetch_url` (core tools) | DuckDuckGo + Wikipedia. |

**Agent loop limits** (`app/llm/agent.py`, `core/config.py`):
- `JARVIS_MAX_TOOL_ITERATIONS = 8` model↔tool rounds per turn.
- `JARVIS_CHAT_TURN_TIMEOUT = 240s` for a typed turn. A voice turn is capped at 75s.
- History sent to the model is the last 6 messages.

**Safety today:** two-step confirmation on `run_command`, `close_app`, and the
delete tools. Each `ToolSpec` has a `risk` field (`low`/`medium`/`high`), but
**nothing enforces it yet**. Its own comment says it is informational. Oddly,
`run_command` is tagged `low`.

**What a single turn can already do well:** "what's using my RAM", "open VS
Code", "find the PDF I downloaded yesterday", "rename these files", "search
the web for X and summarize". These are short, one to eight steps.

---

## 2. What the agent runtime already provides (Codex, P12–P34)

`backend/app/agent_runtime/` is a careful foundation for long-running work.
Every module states it is fixture-only, and `release.py` keeps every
capability off unless explicitly enabled:

| Module | What it is | Status |
|---|---|---|
| `worker.py` | Durable worker: lease claim/renewal, safe cancellation, crash recovery | Runs only a side-effect-free `observe()` |
| `approvals.py` | Exact-effect approvals ("approve *this* command, not a category") + pairing tokens | Built |
| `verification.py` | Deterministic evidence; "no self-attested success" | Skeleton |
| `workflows.py` | Reviewed, host-owned workflow definitions; "never executable model plans" | Skeleton |
| `skills.py` | Reviewed local skill manifests; no remote loading | Skeleton |
| `processes.py` | Managed subprocess ownership (argv from host code, never model text) | Fixture-safe |
| `children.py` | Bounded read-only child runs (sub-agents) | Read-only |
| `desktop.py` / `browser.py` | Serialized desktop/browser workers | "No UI Automation calls registered" |
| `release.py` | Closed-by-default rollout flags | All closed |
| `scheduler.py`, `telemetry.py`, `domain_commands.py`, `voice_bridge.py` | Scheduling, redacted event buffer, cross-device commands, voice hand-off | Contracts |

This is the right shape. It just isn't connected to the real tools or to a
planner yet.

---

## 3. Walkthrough: "download Antigravity, install it and set it up"

Traced against today's code, step by step:

| Step | What's needed | Today |
|---|---|---|
| 1. Find the official download | `web_search` → confirm the vendor's own domain | ✅ Works. No check that the source is official. |
| 2. Download the installer | `run_command` (`curl`/`Invoke-WebRequest`) or the browser | ⚠️ Works, but each command needs your yes. No signature check on the file. |
| 3. Prefer a package manager | `winget search/install` handles download + silent install + version | ⚠️ Possible via `run_command`, but nothing tells the model to prefer it. |
| 4. Run the installer | Silent flags, or click through the wizard | ⚠️ UI clicks work if the wizard exposes accessibility info. Many don't. |
| 5. **UAC elevation prompt** | Windows shows it on the secure desktop | ❌ **No app can click it, by design.** A human must approve (or install per-user). |
| 6. First-run setup / sign-in | Wizard clicks; account login | ⚠️ Clicks maybe. ❌ JARVIS must never type your password. This is a hand-off to you. |
| 7. Verify it's installed | `winget list`, registry, exe exists, app launches | ❌ Nothing does this; success is whatever the model says. |
| 8. Whole job | 20–40 tool calls, 3–10 minutes | ❌ The loop stops at 8 calls / 240s. |
| 9. Report back | Notify you (phone) when done or when it needs you | ❌ No job notifications. |

So the verdict today: **steps 1–4 can partly work in one sitting, and the job
reliably dies at step 5 or at the 8-call limit.**

---

## 4. The gaps, ranked by how much they block autonomy

### G1. Jobs must outlive a chat turn (the biggest blocker)
Autonomous work needs a **background job** with its own lifetime: started by a
request, running for minutes, surviving an app restart, cancellable.
`agent_runtime/worker.py` already solves lease/recovery/cancellation. Connect it
to the real tool executor behind a release flag.

### G2. A planner model for jobs (keep nano for voice)
gpt-4.1-nano was picked because it is fast and follows tool calls for short
turns. Planning, recovering from errors, and judging "is this done?" over 30
steps needs a stronger model. Use **two models**: nano for chat/voice, a
stronger one (e.g. gpt-4.1, or a comparable model on OpenRouter) only inside
background jobs. Jobs are rare, so the extra cost stays small.
*Decision for you: which model, and a per-job budget cap.*

### G3. A plan → act → verify → checkpoint loop
Every job should:
1. **Plan**: write explicit steps with a success condition for each.
2. **Act**: one step at a time through the existing tools.
3. **Verify**: check the success condition with a *deterministic* probe
   (`verification.py`'s principle: no self-attested success). Examples:
   "installed" means `winget list` shows it or the exe exists; "running" means
   `list_processes`.
4. **Checkpoint**: persist progress, so a crash or restart resumes at the step
   that failed, not from zero.
5. **Replan** on failure, with a bounded number of retries.

### G4. Approvals that fit autonomy
Asking "yes?" before every command defeats autonomy; approving nothing is
unsafe. Proposed policy:
- You approve the **job scope once** ("install Antigravity: allowed to
  download from its official domain, run its installer, use winget").
- Inside that scope, low/medium-risk steps run without asking.
- The job **pauses and pings your phone** for anything outside the scope or
  high-risk: UAC, payments, passwords, deleting outside the job's folders,
  sending messages.
- `approvals.py` (exact-effect approvals) is the right primitive.
- Make the `ToolSpec.risk` field actually enforced, and re-tag `run_command`.

### G5. Installs done the robust way
Teach the planner an install playbook:
1. `winget install --id <verified id> --silent --accept-package-agreements`.
   Search first; never guess an id.
2. Else the vendor's official installer with its documented silent flags.
3. Else the wizard via UI automation.
4. Always verify the download: official domain, and
   `Get-AuthenticodeSignature` shows a valid publisher.
5. Prefer per-user installs to avoid UAC. When UAC is unavoidable, pause and
   ping you.

### G6. Seeing apps that hide from UI Automation
Add a **screenshot + vision** fallback for when `ui_inspect` returns nothing
useful: capture the window, have a vision-capable model locate the control,
then click by coordinates, and re-verify with a fresh screenshot. Use it only
as a fallback, since the accessibility tree is faster and more reliable when
present.

### G7. Hand-offs, progress, and notifications
- Job status on screen: steps done / current / next.
- Phone notification on "needs you" (UAC, sign-in, approval) and on
  finish/fail. `domain_commands.py` + `voice_bridge.py` are the cross-device
  hooks.
- A spoken summary when done: "Antigravity is installed and opens; sign-in is
  waiting for you."

### G8. Guardrails (must exist before any real autonomy ships)
- Never type passwords, card numbers or 2FA codes. Always hand these off.
- Never approve UAC, never disable Defender/firewall, never change security
  settings.
- Downloads only from official vendor domains; verify signatures before
  running anything.
- Hard caps per job: steps, wall-clock, money spent on model calls.
- Everything logged (the telemetry buffer), and a one-tap "stop job".
- Destructive file operations limited to the job's own working folder unless
  you approved otherwise.

---

## 5. Target architecture (reuses what exists)

```
 You (voice/phone/desktop)
   │  "install Antigravity and set it up"
   ▼
 Job intake ──► Scope approval (once, on your phone)          approvals.py
   │
   ▼
 Background job (durable, resumable, cancellable)              worker.py
   │
   ├─► Planner (strong model) ── writes steps + success checks
   │
   ├─► Executor ── existing 35 tools, risk-gated               tools.py
   │     └─► Vision fallback when UIA sees nothing (new)
   │
   ├─► Verifier ── deterministic post-conditions               verification.py
   │
   ├─► Checkpoint store ── resume after crash                  database.py
   │
   └─► Hand-off / notify ── phone push for UAC, sign-in,       domain_commands.py
                            approval, done/failed               voice_bridge.py
```

---

## 6. Phased roadmap (each phase ships something usable)

**Phase 1: background jobs + winget installs (the first real autonomous task)**
- Connect `worker.py` to the real tool executor behind a release flag.
- Plan/act/verify/checkpoint loop with a planner model.
- Job-scope approval, enforced `risk` levels, and a hard step/time/cost cap.
- Acceptance test: "install 7-Zip" end to end via winget, verified by
  `winget list`, surviving an app restart mid-job, with no per-step prompts
  inside the approved scope.

**Phase 2: installers and setup wizards**
- Official-installer path with a signature check; UI automation through
  wizards; pause-and-ping on UAC and sign-in.
- Acceptance test: install one app that has no winget package and a
  multi-page wizard.

**Phase 3: vision fallback**
- Screenshot + vision locate-and-click when the accessibility tree is empty.
- Acceptance test: complete a setup screen in an Electron app.

**Phase 4: from your phone**
- Start a desktop job by voice on the phone, approve from the phone, get
  progress and "needs you" pushes, and hear a spoken summary when done.

**Phase 5: reusable skills**
- Save a successful job as a reviewed skill (`skills.py`), e.g. "set up a new
  Python project", so the next run skips planning and uses the proven steps.

---

## 7. Decisions needed from you

1. **Planner model** for background jobs, and a per-job cost cap.
2. **Default approval scope**: what JARVIS may do inside an approved job
   without asking.
3. **Where jobs may run**: only when the desktop app is open, or also started
   remotely from the phone?
4. **UAC policy**: always hand off to you, or prefer per-user installs even
   when a system-wide install exists?

## 8. Notes and caveats

- This plan builds on Codex's `agent_runtime` rather than replacing it. Its
  closed-by-default, no-self-attested-success design is exactly what
  autonomy needs. Coordinate through `explanations.md` before wiring it to
  real effects.
- Nothing here has been implemented yet. This document describes the gap
  and the path.
- The Antigravity example was traced against the code, not run. Its exact
  winget id (if any) must be looked up with `winget search`, never guessed.
