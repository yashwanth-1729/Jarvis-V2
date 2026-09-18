# JARVIS Autonomy Blueprint (desktop)

*2026-09-19. Replaces the first-pass version of this file. Grounded in the
current code and in research on the strongest agents (OpenClaw, Hermes Agent,
Microsoft UFO², OSWorld leaders, long-horizon harness work). Sources are at the end.*

**The goal:** you tell JARVIS an **outcome**, not steps. "Download Antigravity,
install it and set it up." "Every Friday clean my Downloads folder and tell me
what you archived." "Get my project running on this machine." Then you walk
away, and JARVIS comes back when it's done or when it genuinely needs you.

**What "better than OpenClaw" means here:**
- **Match** OpenClaw's reach: an always-on runtime, skills loaded on demand,
  long-term memory, scheduled work, and chat/phone control.
- **Beat it** where it is measurably weak:
  - **Safety.** Independent audits put OpenClaw at 58.9% safe behavior, 0%
    on ambiguous requests, and 57% on injection tests.
  - **Proof of completion.** No "done" without evidence.
  - **Being Windows-native.**
  - **Voice-first control** from the phone in English, Hindi and Telugu.

Capability that isn't safe is just a faster way to wreck a machine. So here,
safety is part of the capability, not a tax on it.

---

## Part 1: Where JARVIS stands today

### Hands (already built, desktop only)
There are 35 system tools in `backend/app/llm/tools.py`:
- **Shell:** `run_command` (asks before running).
- **Files:** read, write, edit, list, search, find, disk usage.
- **Apps and OS:** launch, close (asks first), open path, list processes, hotkeys, clipboard.
- **Windows UI Automation (pywinauto):** list/focus windows, inspect, find, click,
  set text, get text, press key, toggle, select.
- **An isolated Playwright Chromium:** open, navigate, inspect, find, click, type,
  submit, read text, URL, title.
- **Web:** search and page fetch.

### Skeleton (built by Codex, all switched off)
`backend/app/agent_runtime/`:

| Module | Status |
|---|---|
| `worker.py` | Durable worker: leases, cancellation, crash recovery. Runs only a side-effect-free `observe()`. |
| `approvals.py` | Exact-effect approvals plus pairing tokens. |
| `verification.py` | Deterministic evidence; "no self-attested success". |
| `workflows.py` | Reviewed, host-owned workflows; "never executable model plans". |
| `skills.py` | Reviewed skill manifests; no remote loading. |
| `evaluation.py` | Held-out evaluation with explicit denominators. |
| `processes.py`, `children.py`, `scheduler.py`, `telemetry.py`, `domain_commands.py`, `voice_bridge.py` | Contracts for subprocesses, sub-agents, scheduling, event logging, cross-device commands and voice hand-off. |
| `release.py` | Every switch is **off**: `admit_new_runs`, `background_jobs`, `domain_writes`, `sensitive_effects`, `persistent_browser_profiles`, `parallel_runs`, `android_execution`. |

### Brain (the limiting factor)
- All work happens inside **one chat turn**: at most **8 tool steps** and **240s**.
- The model is **gpt-4.1-nano**. It's right for fast voice replies and wrong
  for planning a 40-step job.
- **No plan, no checkpoints, no verification, no resume.**
- **Sight is limited to the accessibility tree.** Electron apps, installers
  and custom UIs are often invisible to it.
- The tool `risk` field exists but is **not enforced** (`run_command` is even
  tagged `low`).

**Honest verdict:** JARVIS is a strong *single-turn* desktop assistant today and
has no autonomy yet. Nearly every part needed to get there exists in some form.
The work is connecting them under a planner, with a safety kernel in front.

---

## Part 2: Lessons from the best agents

| Source | Lesson | What JARVIS takes |
|---|---|---|
| **OpenClaw** | An always-on loop; skills listed as metadata and read on demand; searchable memory; scheduled tasks; messaging channels. Huge adoption. | The runtime shape and on-demand skills. **Not** its trust model: untrusted web and file content can steer it (ClawHavoc, repeated CVEs). |
| **Hermes Agent** | A closed learning loop: a successful multi-step task becomes a reusable skill; SQLite FTS5 memory; periodic consolidation. | Self-improving skills. JARVIS adds a **review gate** before a learned skill is trusted, matching `skills.py`. |
| **Microsoft UFO²** | A HostAgent splits the task, per-app AppAgents act; **UI Automation plus vision** hybrid detection; **API calls before GUI clicks**; several actions planned per model call; a **separate virtual desktop** so the agent never fights you for the mouse. | The Windows-native core of this plan. |
| **OSWorld-Verified (Sep 2026)** | Top systems finish **85–86%** of 369 real desktop tasks. Leader: **Qwen3.8-Max, 86.1%**, **$2 / $6 per M tokens** on OpenRouter. Claude Fable 5 scores 85% at $10 / $50. | Qwen3.8-Max is the best capability per dollar and stays in the Qwen family. |
| **Long-horizon harnesses** | Recover the goal and verified state, do one bounded step with **fresh context**, check the real result, **checkpoint**, and feed failures into the next round. Context editing alone gave +29%, memory +39%, and cut tokens 84%. Sub-agents with separate context return short summaries. | The execution loop and context hygiene. |

---

## Part 3: Target architecture

```
 You ── voice (phone/desktop) · chat · schedule · trigger
  │
  ▼
┌──────────────── Job Intake ────────────────┐
│ outcome → scope proposal (what may be touched, budget, risk ceiling)      │
│ you approve the scope ONCE (phone tap / voice "yes")      approvals.py    │
└────────────────────────────┬──────────────────────────────┘
                             ▼
┌──────────────── Supervisor (planner model) ───────────────┐
│ writes the plan as TYPED STEPS from an allowlisted vocabulary             │
│   e.g. winget.install(id), download(url), verify.file_signature(path),    │
│        gui.complete_dialog(window, goal), shell(cmd, cwd=job_dir) …      │
│ never raw code; the host validates every step against scope + policy      │
└────────────────────────────┬──────────────────────────────┘
                             ▼
┌──────────────── Safety Kernel (host code, not the model) ─────────────────┐
│ scope check · risk enforcement · taint tracking of untrusted content ·    │
│ budget/step/time caps · kill switch · audit log            release.py     │
└──────────┬───────────────────────────────┬──────────────────────────────┘
           ▼                               ▼
┌──── Executor (fresh context per step) ─────┐   ┌──── Hand-off ────────────┐
│ API-first: winget / PowerShell / app CLIs /│   │ UAC · sign-in · payment · │
│   COM (Office) / config files              │   │ out-of-scope → push to    │
│ GUI fallback: UIA tree → vision marks →    │   │ phone + voice; job pauses │
│   click; optional separate virtual desktop │   │ and resumes on your reply │
└──────────┬─────────────────────────────────┘   └───────────────────────────┘
           ▼
┌──── Verifier (independent) ───────┐    ┌──── Memory & Skills ──────────────┐
│ deterministic post-conditions:     │    │ episodic job log · facts (existing │
│  winget list · file hash/signature │    │ memory service) · learned skills   │
│  · process running · screenshot    │    │ (Hermes-style, reviewed before     │
│  diff · a separate model audits    │    │ trusted)              skills.py    │
│  fuzzy goals     verification.py   │    └────────────────────────────────────┘
└──────────┬─────────────────────────┘
           ▼
 Checkpoint (durable, resumable)  worker.py + database.py  →  next step or replan
```

### Key design decisions (and why)

1. **Plans are typed data, not code.** The model picks from an allowlisted
   action vocabulary, and host code validates each step before running it.
   This keeps Codex's "never executable model plans" principle while still
   letting a model plan. It's also the core defense OpenClaw lacks: a
   poisoned web page can't make up a new action, because the action has to
   exist in the vocabulary *and* be inside the scope you approved.

2. **Taint tracking.** Anything read from the web, a file, a download or an
   app's screen is *untrusted*. It can fill in values (a version number, a
   file path the job created). It can never add a step, widen the scope, or
   change a destination. In the CaMeL style, the plan comes from trusted
   input (you and the host), and data flows through it.

3. **API before GUI** (UFO²). `winget install --id …` beats clicking through
   an installer on every count: reliability, speed, cost and verifiability.
   GUI automation is the fallback, not the default.

4. **Fresh context per step** (long-horizon research). Each step's executor
   sees only the goal, the verified state so far, and the step to do, not
   the whole history. The supervisor keeps the big picture. Accuracy stays
   up and cost stays down.

5. **No self-attested success.** Every step has a success condition checked by
   host code or a separate audit. A job is "done" only when its final
   post-conditions pass. This is the direct fix for the 11-of-12 fake actions
   we found in voice mode: the same failure, at desktop scale.

6. **Two-level sight** (UFO²). The accessibility tree comes first: fast,
   exact, cheap. If a window exposes nothing useful, take a screenshot,
   overlay numbered marks on candidate controls, and have the vision model
   pick a mark. Then verify with a fresh screenshot.

7. **Your mouse stays yours.** GUI jobs run on a separate Windows virtual
   desktop where possible (UFO²'s picture-in-picture idea), so JARVIS can
   install something while you keep working.

---

## Part 4: The safety kernel (how JARVIS beats OpenClaw)

**Hard never-list.** Enforced in code, not in the prompt:
- Typing passwords, card numbers or 2FA codes, and solving CAPTCHAs. These are always handed off to you.
- Approving UAC, or turning off Defender, the firewall or SmartScreen.
- Sending messages, email, posts or payments without an explicit per-action yes.
- Deleting or overwriting outside the job's own folder unless the scope
  explicitly names the path.
- Running a downloaded binary unless it came from the vendor's official
  domain **and** `Get-AuthenticodeSignature` shows a valid publisher.

**Scope grants.** You approve once per job, for example:
"Antigravity install: may download from antigravity.google / official
mirrors, run its signed installer, use winget, write under
`%LOCALAPPDATA%\Programs`, budget $0.50, 30 min."

Inside the scope, steps run without asking. Anything outside pauses the job
and asks you.

**Risk enforcement.** The existing `risk` tag becomes binding:
- `low`: runs inside any active scope.
- `medium`: must be covered by the scope.
- `high`: always needs an exact-effect approval (`approvals.py`).
- Re-tag `run_command`, which is currently `low`.

**Budgets and kill switch:**
- Per-job caps on steps, wall-clock time and model dollars.
- A global monthly cap.
- One tap or "JARVIS stop" cancels safely (the `worker.py` cancellation already
  handles in-flight work).

**Audit.** Every step, what it saw, what it did, and what verified it goes
into the telemetry buffer. The job report can be replayed.

**Measured, not claimed.** Build an injection and misuse test suite:
poisoned pages, malicious READMEs, "ignore previous instructions" inside
downloads, and ambiguous requests. The release gate is **≥95% blocked**,
against OpenClaw's audited 57%.

---

## Part 5: Models and budget

| Role | Model | Why | Price (per M tokens, in / out) |
|---|---|---|---|
| Voice and chat | gpt-4.1-nano (current) | Fast; 11/12 real actions in our tests | $0.10 / $0.40 |
| Supervisor, vision GUI steps, final audit | **Qwen3.8-Max** (recommended) | #1 on OSWorld-Verified (86.1%); 1M context; Qwen family | $2 / $6 |
| Simple deterministic steps (shell/API) | gpt-4.1-nano or qwen3-30b-a3b | Cheap; no judgment needed | ≤ $0.10 / $0.40 |

**Rough cost per job (estimate, not measured).** A typical "install and set
up an app" job might take:
- about 5 supervisor calls,
- about 10 GUI steps with screenshots,
- a final audit.

That comes to about 200–300k input tokens and ~10k output, so **~$0.40–0.70 per job**
at list price. Prompt caching and API-first steps bring it lower. Budget
controls:
- a per-job cap (default $0.50, asks before exceeding),
- a monthly cap,
- smaller screenshots,
- the cheap model on deterministic steps,
- learned skills that skip re-planning jobs it has already done.

---

## Part 6: Walkthrough of the target design: "download Antigravity, install it, set it up"

1. **Intake.** JARVIS proposes a scope (official domain + winget + signed
   installer + per-user install path, $0.50, 30 min). You say "yes" on the phone.
2. **Plan.** `winget.search("Antigravity")`, then `winget.install(<verified id>)`
   if a package exists. Otherwise `web.find_official_download`,
   `download`, `verify.signature`, `run_installer(silent flags)`. Then
   `launch`, `gui.complete_first_run`, `verify.app_running`.
3. **Act and verify, step by step.** Each step checkpoints. If the PC restarts
   mid-download, the job resumes at the download.
4. **UAC appears.** The job pauses and your phone buzzes: "Antigravity needs
   admin approval on your desktop." You click Yes, and the job continues.
5. **First run asks you to sign in.** It hands off: "It's installed and open;
   sign in when you're ready." JARVIS never types your password.
6. **Done**, with evidence: winget lists it, the exe is signed by the
   expected publisher, the process launches. Spoken summary on your phone.
7. **Learning.** The successful trace becomes a draft skill, "install app X via
   winget". Once you (or a review step) approve it, the next install skips
   planning.

---

## Part 7: Roadmap (each phase ships something you can use)

### Phase 0: Foundations (safety kernel first)
- Enforce `risk`, add scope grants, set per-job caps, add the kill switch.
- Define the typed action vocabulary; the host validator rejects anything off-list.
- Wire `worker.py` to the real tool executor behind `background_jobs` and `admit_new_runs`.
- **Done when:** a job runs in the background, survives an app restart,
  can be cancelled mid-step, and an off-scope step is refused by code, not by the model.

### Phase 1: Plan → act → verify, API-first
- Qwen3.8-Max supervisor, fresh-context executor, deterministic verifier, checkpoints.
- The winget/PowerShell action set, plus signature verification.
- **Done when:** "install 7-Zip", "install VLC" and "install Python 3.12"
  each complete end to end with no per-step prompts inside scope, verified by
  `winget list` and a signature check.

### Phase 2: Hand-offs and phone control
- Scope approval from the phone.
- UAC, sign-in and out-of-scope pauses pushed to the phone, with a voice summary when done.
- Start desktop jobs from the phone by voice (`domain_commands.py`, `voice_bridge.py`).
- **Done when:** you start a desktop install from your phone by voice,
  approve UAC when pinged, and hear the result.

### Phase 3: Sight
- A vision fallback with numbered marks on screenshots, plus screenshot-diff verification.
- A separate virtual desktop for GUI jobs.
- **Done when:** the Antigravity walkthrough (Part 6) completes, including a
  first-run screen that UI Automation can't see.

### Phase 4: Injection-proof
- Taint tracking and the injection/misuse test suite.
- **Done when:** the suite shows ≥95% blocked.

### Phase 5: Skills that grow
- Hermes-style: turn successful traces into draft skills, a review gate, and a skill library.
- Skills are listed as metadata and loaded on demand (OpenClaw-style), so
  prompts stay small.
- **Done when:** the second run of a learned job uses the skill and is at least
  50% cheaper and faster than the first.

### Phase 6: Standing jobs
- Schedules and triggers: "every Friday…", "when a PDF lands in Downloads…",
  "when the build fails…". The scheduler contract exists.
- **Done when:** a weekly job runs unattended for a month with a report each time.

### Phase 7: JARVIS-Bench (keeps us honest)
- About 40 real Windows tasks with deterministic checkers: installs, settings,
  file organization, browser forms, Office edits, dev setup. It runs on
  `evaluation.py` with explicit denominators, nightly.
- Track success rate, steps, dollars and injection block rate.
- **Target:** ≥80% task success at ≤$0.50 per task average, alongside the
  ≥95% injection block rate.

---

## Part 8: Decisions needed from you

1. **Supervisor model.** Qwen3.8-Max (recommended: best score, cheapest of
   the top tier) or a Claude/OpenAI model.
2. **Budget.** Default per-job cap (proposed $0.50) and monthly cap.
3. **Default scope.** What may run without asking inside an approved job.
4. **UAC policy.** Always hand off, or prefer per-user installs to avoid it.
5. **Remote start.** May jobs be started from the phone while you're away from the PC?
6. **Coordination.** The runtime is Codex's work. Decide who builds which phase,
   and log it in `explanations.md` before switching on any release flag.

## Caveats
- Nothing in this document is implemented yet.
- Benchmark scores are for model + harness on test tasks. Real-world success
  will be lower until JARVIS-Bench says otherwise.
- Some things no agent should or can do alone: UAC, CAPTCHAs, 2FA, payments.
  The goal is to make those one-tap hand-offs, not to remove them.
- The cost per job is an estimate until Phase 1 measures it.
- Antigravity's winget id, if one exists, must be looked up with `winget search`, never guessed.

## Sources
- OpenClaw architecture: https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764 · memory docs: https://docs.openclaw.ai/concepts/memory
- OpenClaw safety audits: https://arxiv.org/pdf/2603.11619 · https://arxiv.org/pdf/2604.27464 · https://www.giskard.ai/knowledge/openclaw-security-vulnerabilities-include-data-leakage-and-prompt-injection-risks
- Hermes Agent: https://github.com/nousresearch/hermes-agent · https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving
- Microsoft UFO²: https://arxiv.org/abs/2504.14603 · https://microsoft.github.io/UFO/ufo2/overview/
- OSWorld-Verified: https://benchlm.ai/benchmarks/osworld-verified · https://leaderboard.steel.dev/leaderboards/osworld/
- Qwen3.8-Max pricing: https://openrouter.ai/qwen/qwen3.8-max-0902 · https://www.datacamp.com/blog/qwen3-8-max
- Long-horizon harness: https://github.com/AMAP-ML/LongHorizon-Harness · https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026
