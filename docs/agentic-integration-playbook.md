# JARVIS agentic integration playbook

## A staged engineering specification for reliable work with smaller models

**Document date:** 2026-09-14

**Status:** PROPOSED IMPLEMENTATION; not a description of shipped features

**Audience:** the project owner, a senior reviewer, and coding agents of different capabilities

**Repository:** JARVIS; the Telugu TTS Arena remains an independent project

**Baseline:** [agentic reliability audit](agentic-audit-2026-09-14.md), recorded in commit `564c628`

**Primary objective:** verifiable task completion, safe recovery and clear evidence

**Secondary objective:** reduce dependence on expensive or highly capable models

This is deliberately a long implementation manual. Do not paste the entire manual
into a small model and ask it to build everything. Use the reading guide, dependency
table, narrowly scoped work packets and handoff templates. The engineering system
must carry the burden of permissions, persistence, state transitions and checking.
The model should mainly interpret intent, propose a bounded next action and explain
evidence that the system has already collected.

Nothing in this document authorizes unattended purchases, messages, deletion,
credential changes, new installations, or changes to unrelated projects. Code and
API examples below are proposed contracts, not already available commands.

## Contents

- [01. How to use this manual](#reading-guide)
- [02. What exists and what is broken](#baseline)
- [03. Rules that must survive the upgrade](#invariants)
- [04. Target architecture and dependency order](#architecture)
- [05. Phase 0: isolated baseline and D-drive setup](#baseline-phase)
- [06. Phase 1: repair existing execution](#repair-phase)
- [07. Phase 2: desktop readiness and reconnect](#readiness)
- [08. Phase 3: shared contracts](#contracts)
- [09. Phase 4: durable storage and migrations](#storage)
- [10. Phase 5: job state machine and recovery](#runtime)
- [11. Phase 6: permissions, approvals and local API security](#permissions)
- [12. Phase 7: managed processes and resources](#processes)
- [13. Phase 8: personal-data effects and acknowledgments](#domain-effects)
- [14. Phase 9: job API, event stream and UI](#api-ui)
- [15. Phase 10: planning, action and verification](#execution-loop)
- [16. Phase 11: smaller-model runtime strategy](#small-model-runtime)
- [17. Phase 12: context and memory](#memory)
- [18. Phase 13: skills and tool discovery](#skills)
- [19. Phase 14: browser and desktop automation](#automation)
- [20. Phase 15: integrations and MCP](#integrations)
- [21. Phase 16: schedules and background jobs](#schedules)
- [22. Phase 17: voice, Telugu and Tenglish](#voice)
- [23. Phase 18: Android and cross-device behavior](#android)
- [24. Phase 19: bounded parallel agents](#parallel)
- [25. Observability, privacy and artifact retention](#observability)
- [26. Evaluation and quality gates](#evaluation)
- [27. Worked end-to-end flows](#worked-flows)
- [28. Using a smaller coding model to implement this](#coding-handoff)
- [29. Work-packet ledger](#work-packets)
- [30. Release, rollback and installation verification](#release)
- [31. Troubleshooting decision trees](#troubleshooting)
- [32. Definition of done, decisions and references](#completion)

<a id="reading-guide"></a>
## 01. How to use this manual

### 01.1 Two different smaller-model problems

**Problem A: implementation.** You switch the coding assistant to a cheaper or
less capable model and still want correct changes. The answer is small work
packets, exact contracts, independent tests, explicit file scope and reliable
handoffs. See section 28.

**Problem B: JARVIS at runtime.** You switch the model inside JARVIS and still want
it to finish user tasks. The answer is constrained actions, reusable workflows,
external verification, durable context and escalation. See section 16.

Solving one does not automatically solve the other. A project implemented with a
strong coding model can still have a poor runtime. A carefully engineered runtime
can still be damaged by an implementation model making an unchecked migration.

### 01.2 Reading paths

For the owner: read sections 2–4, 16, 26, 28–30. These explain priorities, model
limits, acceptance criteria and how to supervise progress.

For the architecture reviewer: read sections 3–15, 23–26 and 30. Resolve the storage,
permission and lifecycle contracts before delegating feature work.

For an implementation model: read section 3, the assigned phase, the relevant
contract definitions and exactly one work-packet entry. Read referenced source
files completely enough to understand their boundaries. Do not autonomously
implement later phases because they sound useful.

For someone resuming after a crash: read `explanations.md`, the last work-packet
handoff and the actual diff. A status checkbox is not proof of implementation.

### 01.3 Evidence labels

Use these labels in every progress report:

| Label | Meaning |
| --- | --- |
| Proposed | A design decision or target; no claim that code exists |
| Source implemented | The code change exists and was reviewed |
| Unit verified | Isolated automated checks passed |
| Integration verified | Real components passed a controlled fixture flow |
| Built | A native or web artifact was produced |
| Installed | That artifact was installed at a known path/device |
| User-path verified | The installed entry point completed the real interaction being tested |
| Not verified | Evidence is absent; never silently upgrade this label |

All phases in this manual begin as **Proposed**. The earlier audit's offline
results are historical evidence, not implementation of these phases.

### 01.4 The meaning of high-quality completion

The useful outcome is not “the agent generated many tokens” or “the tool returned
HTTP 200.” It is that the requested artifact or state exists, meets explicit
criteria, stays within authorized scope and can be explained from evidence.

For example, “create a report” requires a saved, readable report. “Send a report”
also requires an authorized recipient and a delivery receipt or an honestly
reported delivery uncertainty. Those are different completion conditions.

<a id="baseline"></a>
## 02. What exists and what is broken

### 02.1 Keep these foundations

The existing application already has FastAPI APIs, a shared agent loop, provider
adapters, desktop shell/filesystem tools, browser tools, Windows UI Automation,
personal-data tools, memory retrieval, voice transport, a React interface and Tauri
desktop/Android packaging. The audited desktop configuration offered 56 tools.

Do not replace the application wholesale. Preserve useful code and isolate its
responsibilities gradually. A new framework is not required to fix the current
tool identity, receipt ordering or reconnect defects.

### 02.2 Confirmed defects that come before expansion

| Defect | Current source anchor | Required outcome |
| --- | --- | --- |
| Gemini fallback tool IDs repeat across responses | `backend/app/providers/gemini.py`, `_stream_once`, `_to_contents` | Each internal call keeps its own name, arguments and provider metadata |
| Tool result is yielded before its receipt is persisted | `backend/app/llm/agent.py`, `run_turn` | A published completion has a durable receipt |
| Browser query errors default to success | `tools_browser.py`, `tools.py::_computer_query` | Typed failures survive wrapping, events and telemetry |
| Parent cancellation skips command-child cleanup | `tools_system.py::run_command` | Owned foreground children are cleaned up on all cancellation paths |
| Last allowed action round cannot be evaluated | `agent.py`, bounded loop | Final verification/finalization has a separate bounded budget |
| Frontend handshake is marked complete prematurely | `frontend/src/app/page.tsx`, `seededRef` | Backend-instance-specific acknowledged readiness |
| Watchdog equates process/port existence with readiness | `frontend/src-tauri/src/backend.rs` | Authenticated local identity/readiness checks and bounded restart policy |
| Model-supplied confirmation stands in for approval | `tools.py` sensitive handlers | Authority validated outside model arguments |

The detailed audit includes reproduction conditions. Do not assume that every
historical poor response was caused by all these defects. Reproduce each condition
in fixtures and verify each fix independently.

### 02.3 Architectural limitations

Today, the chat/voice request owns execution. There is no independent run handle
with durable progress and explicit recovery. The checked configuration has eight
tool rounds, a 240-second typed deadline and a 75-second voice deadline. Transcript
history is shared and bounded by rows rather than task-specific state.

The scheduler is useful for reminders, but it is not a general job scheduler.
Browser automation uses separate Chromium, not the user's current signed-in tabs.
Some automation functions exist without corresponding tool registrations.

These are different problems from model capability. Increasing model intelligence
does not give the runtime persistence, process ownership or approvals.

### 02.4 Source-of-truth warning about storage

Some historical documentation says desktop data is always SQLite-authoritative.
That is not a safe assumption. The inspected configuration sets
`JARVIS_CLIENT_OWNED_DATA=true`; the current config and bridge support desktop
client-owned data as well as Android client-owned data. The default value in code
and a particular installation's effective value can differ.

Before any storage change, inspect effective configuration without exposing keys.
When client-owned mode is active, IndexedDB owns personal records and SQLite is a
working copy. When it is inactive, the configured backend store has a different
authority role. `JARVIS_ANDROID` is a platform flag, not a synonym for ownership.

New durable runtime records must never be included in a destructive personal-data
reseed. Do not change either storage mode just to make the runtime easier to build.

<a id="invariants"></a>
## 03. Rules that must survive the upgrade

### 03.1 Product invariants

- Preserve selected language and voice, including Telugu/English code-switching.
- Preserve half-duplex by default. Background work must not reopen the microphone.
- Preserve tool-driven voice surfaces and existing edit/delete safeguards.
- Preserve personal-record identities, tombstones and established sync ownership.
- Do not use real personal records as test fixtures.
- Keep Android changes in canonical backend/frontend sources, not generated copies.
- Keep the TTS Arena separate. Its audio-first campaign is not a prerequisite for
  implementing a reliable agent runtime.
- Keep source changes, builds, installs and on-device verification distinct.
- Do not silently change the configured model or spend provider credits for tests.

### 03.2 Runtime invariants

1. Every accepted job has a stable run ID before execution starts.
2. A user disconnecting from progress does not silently change execution policy.
3. Each effect has a stable operation identity and a persisted preparation record.
4. Only one valid owner may advance a given run generation.
5. Completed, failed, cancelled and uncertain are different states.
6. Tool-call success is not automatically user-task success.
7. Missing evidence means unverified, not successful.
8. Untrusted tool output cannot approve actions or enlarge scope.
9. A model can propose a plan; only the host validates permissions and resources.
10. Retry policy depends on the effect, not merely an exception type.
11. A cancelled request must not leave unknown, unowned processes.
12. A terminal user-facing report describes what is verified and what remains.

### 03.3 Limits of the guarantee

You cannot honestly guarantee exactly-once execution across an arbitrary website,
local process and database. An external system may perform an action just before
the connection drops. Without a receipt or idempotency facility, the outcome is
uncertain. The correct response is reconciliation or user review, not blind retry.

You also cannot guarantee that any tiny model will perform every complex task well.
Engineering narrows the model's responsibilities and catches errors. Some novel or
ambiguous work still requires a stronger model, a human, or a narrower scope.

<a id="architecture"></a>
## 04. Target architecture and dependency order

### 04.1 Responsibility split

```text
Typed request / voice transcript / authorized schedule
                         |
                 Input + scope validation
                         |
                 Durable job submission
                         |
       +-----------------+------------------+
       |                                    |
  Progress subscribers              Runtime owner / queue
  UI, voice updates                         |
       ^                         Context + workflow selection
       |                                    |
       |                           Bounded model proposal
       |                                    |
       |                       Schema + policy + budget checks
       |                                    |
       |                         Resource lease + effect gate
       |                                    |
       |                             Tool adapter
       |                                    |
       +------ committed events <--- Receipt + verification
                                            |
                              Continue / repair / ask / finish
```

The UI does not own the job. The model does not own permissions. The tool does
not decide that the whole user request is complete. The verifier does not execute
unrequested repairs. The scheduler does not bypass approvals.

### 04.2 Proposed module layout

The following paths are new unless a later implementation actually creates them.
Keep existing providers and tool implementations during migration.

```text
backend/app/agent_runtime/
  contracts.py          # versioned host/model/tool structures
  store.py              # runtime transactions and event/outbox operations
  migrations.py         # runtime DB migrations, separate version sequence
  service.py            # submit, cancel, resume, inspect; public runtime facade
  worker.py             # bounded execution loop
  transitions.py        # allowed lifecycle changes
  leases.py             # ownership generations and resource leases
  policy.py             # deterministic effect authorization
  approvals.py          # pending decisions, binding, redemption
  processes.py          # managed command lifetime and output
  domain_effects.py     # durable commands to personal-record owner
  verification.py       # evidence-backed completion checks
  context.py            # task packet and selective retrieval
  routing.py            # capability-aware model selection and escalation
  workflows.py          # reviewed deterministic workflow templates
  skill_registry.py    # manifests and scoped capability discovery
  scheduler.py          # general jobs, separate from reminder semantics
  telemetry.py          # redacted operational metrics
backend/app/api/agent_runs.py
frontend/src/lib/agentRuns.ts
frontend/src/components/agent/   # small status/approval/artifact surfaces
backend/tests/agent_runtime/    # proposed new isolated suite
```

Avoid making `worker.py` a new giant file. Contracts must not import the API layer.
Tool adapters must not import UI components. Providers return model proposals and
protocol metadata, not direct database mutations.

### 04.3 Delivery sequence

| Milestone | Depends on | Visible value | Exit gate |
| --- | --- | --- | --- |
| M0 baseline | none | Trustworthy fixtures and environment notes | Tests cannot reach live data/providers |
| M1 repair | M0 | Short tasks stop corrupting history | All defect reproductions have regression coverage |
| M2 readiness | M0 | Desktop can explain and recover from unavailable runtime | Installed-entry-point readiness flow checked |
| M3 contracts/store | M1 | Stable job/effect/evidence records | Migrations, validation, retention boundaries tested |
| M4 runtime | M3 | Read-only tasks survive UI disconnect | Crash/reconnect/ownership tests pass |
| M5 authority | M3–M4 | Sensitive actions wait for real approval | Bypass/replay/changed-argument tests reject |
| M6 effects/processes | M4–M5 | Commands and record changes have receipts | Cancellation and reconciliation tests pass |
| M7 UI/verification | M4–M6 | Honest progress and verified deliverables | Full fixture flow succeeds and reports uncertainty |
| M8 smaller models | M7 | Lower-cost bounded execution | Task-family quality gates met |
| M9 expansion | M8 | Skills, browser profiles, integrations, schedules | Each new capability passes its own safety/quality gate |
| M10 cross-device | M9 | Explicit device-owned jobs and optional delegation | No accidental duplicate execution |

Build a minimal **read-only vertical slice** before authorizing writes: submit a
fixture research task, collect local fixture evidence, save a draft artifact,
disconnect/reconnect the UI, and inspect its verified completion record. Writes
to user-owned records and external services come only after authority/effect gates.

<a id="baseline-phase"></a>
## 05. Phase 0: isolated baseline and D-drive setup

**Packets:** P00–P01. **Do not install anything merely to write or review this plan.**

### 05.1 Record the starting point

1. Read repository instructions, `README.md`, relevant architecture sections and
   `explanations.md`; inspect source when notes disagree.
2. Inspect the current branch, working-tree changes and remote before syncing.
3. Follow this repository's main-only collaboration policy. Do not force-push or
   overwrite another agent's changes. If a pull cannot safely merge, stop that step.
4. Record the starting commit and exact paths assigned to the packet.
5. List the baseline tests that cover the affected behavior; read their headers.
6. Distinguish offline fixtures from tests that open apps, spend credits or sync data.

### 05.2 Proposed D-drive layout

```text
D:\Jarvis-2.0\                         source repository
D:\JarvisData\runtime\runtime.db      proposed durable control-plane database
D:\JarvisData\runtime\artifacts\      generated job artifacts, excluded from Git
D:\JarvisData\runtime\logs\           bounded/redacted operational logs
D:\JarvisData\runtime\backups\        verified migration backups
D:\JarvisData\browser-profiles\       dedicated JARVIS profiles, sensitive
D:\JarvisData\cache\                  pip/npm/model/browser downloads
D:\JarvisData\tmp\                    project-owned temporary directories
D:\JarvisData\test-runs\              unique isolated fixture directories
```

These are recommended future paths, not existing directories or permission grants.
If the coding environment may only write inside the repository, use an ignored
directory under `D:\Jarvis-2.0` or obtain permission for the explicit data root.
Never use C: as an automatic fallback when D: is unavailable.

For future installation commands, configure process-local `TEMP`, `TMP`,
`PIP_CACHE_DIR`, `npm_config_cache`, `HF_HOME`, `TORCH_HOME` and
`PLAYWRIGHT_BROWSERS_PATH` as appropriate to the actual tool. Not every tool honors
every variable. Inspect resolved paths and before/after free space instead of
assuming redirection succeeded. Do not overwrite `HOME` or `CODEX_HOME`.

Do not move an existing Python virtual environment and assume it remains valid;
recreate from a recorded dependency set if necessary. Do not move browser profiles
while their processes own them. Back up explicit project-owned targets and verify
the destination before removing any old copy. Shared caches and personal folders
require separate scope review.

### 05.3 Test containment must be explicit

Create a unique fixture root for each test run. Configure both personal-data and
runtime databases before importing modules with settings singletons. Prefer
dependency injection over globally replacing production settings.

Require a test harness that:

- Uses mocked provider transports by default.
- Refuses network access except a loopback fixture server explicitly enabled.
- Disables both backend and client sync mechanisms for fixtures.
- Replaces credentials with dummy values without logging real configuration.
- Refuses a DB path matching a production store or outside its fixture root.
- Creates no records in a user's actual IndexedDB origin.
- Records and cleans only processes it starts, using verified ownership.
- Reports skipped tests separately; a missing browser must not become a pass.

### 05.4 Baseline gate

Run the existing offline Gemini and reasoning-routing suites first, then the new
regressions. Existing tests passed during the audit despite the defects. Add
negative tests that fail on the buggy behavior and pass only after repair. Do not
ship a test that permanently asserts the bug is present as a success condition.

<a id="repair-phase"></a>
## 06. Phase 1: repair existing execution

**Packets:** P02–P06. Keep these patches narrow; do not combine them with a provider
rewrite, prompt overhaul, model upgrade or storage migration.

### 06.1 P02: unique provider-independent call identity

Affected files: `backend/app/providers/gemini.py`, provider contracts if necessary,
and focused Gemini tests.

Implementation sequence:

1. Create a fixture with two consecutive responses containing function calls with
   no upstream ID and different names, arguments and signatures.
2. Assert both old and new calls survive replay exactly; include a third response.
3. Introduce a unique internal call ID for every logical call. Store upstream IDs
   separately; never assume their uniqueness across responses or sessions.
4. Bind provider metadata to the internal call plus response/provider identity.
5. Preserve necessary provider signatures in durable, access-controlled records
   when restart replay is supported; do not put them in normal logs.
6. If the provider cannot safely replay old structured calls, explicitly build a
   supported summary representation. Do not invent signatures or silently rename calls.
7. Test absent IDs, repeated upstream IDs, multiple calls in one response, provider
   fallback and restart serialization.

Done means previous calls cannot change when later calls arrive. Rollback means
reverting only this adapter patch; avoid deleting existing conversation data.

### 06.2 P03: receipt-before-publication and batch reconciliation

Affected files: `agent.py`, conversation persistence helpers and isolated tests.

1. Reproduce closure immediately after the first result in a multi-call batch.
2. Persist each completed result before yielding its success to consumers.
3. Record the declaration and execution status of every call in the batch.
4. Represent unstarted calls explicitly when interruption prevents their execution.
5. Reconcile historical missing results without asserting unverified completion.
6. Separate protocol repair from effect retry: a syntactically complete history
   does not prove an unknown external action failed.
7. Inject failures before execution, after execution, during persistence and after
   publication. Check the next turn's provider-facing transcript in every case.

A minimal receipt-order fix reduces one failure window. It does not eliminate the
crash between an external side effect and receipt commit. The later operation
ledger and reconciliation phase address that separate window.

### 06.3 P04: typed outcomes for every computer query

Audit `_computer_query`, `_computer_action` and no-input wrappers. Define success,
empty-but-valid result, unsupported capability, missing resource, permission error,
timeout and internal failure as distinct outcomes.

Do not classify errors by whether text contains the English word “failed.” Use
structured status fields. A legitimate search with no matches is successful
execution with an empty result; a search against a closed tab is an operational
failure. Both may fail a task's acceptance criterion, but for different reasons.

Verify raw handler output, wrapper output, frontend event and action-memory record.
The evidence shown to the model and user must agree. Keep an additive legacy
adapter temporarily if existing surfaces expect `ok` and `summary` fields.

### 06.4 P05: cancellation cleanup

Fix parent cancellation separately from the tool's own timeout. Use a bounded
cleanup path that terminates/reaps only the process tree created for that command,
closes output readers and re-raises cancellation. Do not swallow cancellation and
return success. Do not shield the whole command from cancellation.

Python's task documentation describes cancellation delivery and cleanup using
`try/finally`; consult the documentation matching the installed interpreter when
implementing this path. [Python asyncio task documentation](https://docs.python.org/3/library/asyncio-task.html)

Tests: cancel before process creation completes, during execution, after process
exit, while draining output, and during cleanup. Include a fake-process unit test
and a short harmless owned-process integration test. Never kill all Python or Node
processes on the computer to make a test pass.

### 06.5 P06: explicit budget exhaustion and finalization

Keep a bounded action budget. Reserve a separate, small tool-free finalization
budget and a deterministic fallback summary if that model call fails.

The finalizer receives a structured list of verified facts, failed criteria,
uncertain operations and remaining work. It has no action tools. It cannot change
the runtime state to success merely by writing “done.” Runtime completion is based
on verified acceptance criteria.

Tests: exact budget use, one fewer round, empty provider output, budget exhausted
after successful final action, failed final action and finalizer timeout. Ensure
there is exactly one terminal run outcome even if several transport events close.

<a id="readiness"></a>
## 07. Phase 2: desktop readiness and reconnect

**Packets:** P07–P08. These are necessary reliability work, not cosmetic UI changes.

### 07.1 Distinguish liveness from readiness

Define separate concepts:

- Process exists: an OS process handle remains live.
- API live: the service responds to a lightweight request.
- API identified: it is the expected JARVIS protocol, not another port listener.
- Runtime ready: storage, migrations and job worker initialized successfully.
- Provider configured: credentials are present; this does not prove remote service health.
- Capability ready: the requested adapter's dependencies and prerequisites are available.

Do not make routine readiness probes call paid models. Report provider configuration
and last observed errors, with timestamps, separately from live paid checks.

### 07.2 Proposed handshake flow

```text
Open app
  -> discover expected local backend
  -> verify instance_id + protocol version
  -> authenticate local client
  -> send configured credentials securely, if required
  -> drain/reconcile outstanding personal-data commands
  -> seed working copy if ownership mode requires it
  -> receive acknowledged instance-specific readiness
  -> subscribe to runs and accept new actions
```

Track `instance_id`, not a permanent boolean set before network calls succeed.
After a backend restart, repeat the required handshake for the new instance. If
credentials are intentionally absent, mark the applicable capability unavailable;
do not retry indefinitely or overwrite valid backend-owned credentials blindly.

### 07.3 Retry and error handling

Keep the dashboard usable offline, but distinguish “your board is available” from
“the agent is ready.” Retry transient handshake failures with bounded backoff.
Treat invalid credentials, incompatible protocol and failed migrations as explicit
attention states. A promise resolving to `false` is not a successful handshake.

The watchdog must not take over an unrelated port listener. It should identify the
service, report a collision and avoid terminating a process it does not own. Reset
the crash counter only after a sustained readiness interval, not a successful spawn.

Capture startup stderr in a rotating/redacted log on D:. Surface the path and a
short actionable error. A missing dependency before logging initialization must
still produce usable diagnostics. Keep windows hidden for background helpers.

### 07.4 Acceptance scenarios

Test cold launch, wrong port listener, missing interpreter, startup import error,
backend crash, hung backend, first handshake timeout, provider key missing,
backend restart with BYOK keys held only in the client, and ordinary app shutdown.

For installed verification, launch from the actual Start Menu shortcut or recorded
installed path with its real working directory. Launching a repository executable
from a favorable terminal directory is not equivalent. Native frontend changes
require rebuild/reinstall; source edits do not update the installed UI automatically.

<a id="contracts"></a>
## 08. Phase 3: shared contracts

**Packet:** P09. Implement schemas and their tests before a large worker loop.

### 08.1 Naming and trust boundaries

Use separate IDs for `session_id`, `run_id`, `step_id`, `operation_id`,
`attempt_id`, `model_response_id`, `tool_call_id`, `artifact_id` and `event_seq`.
They identify different things. In particular, retrying the same logical effect
usually keeps its operation ID but creates a new attempt ID.

All IDs in model-visible evidence must be allocated or validated by the host.
Never accept a model's claim that it has already obtained an approval or verified
an artifact. Server state, not narrative text, establishes those facts.

### 08.2 Proposed job request

```json
{
  "schema_version": 1,
  "client_request_id": "client-generated-unique-id",
  "session_id": "server-issued-session-id",
  "input": {"text": "Research the fixture topic and save a draft", "language": "en-IN"},
  "requested_mode": "draft_only",
  "execution_policy": "continue_without_ui",
  "artifact_ids": [],
  "budget_profile": "standard"
}
```

Client requests express preferences, not authority. The host derives the effective
principal, device, capabilities, scope and budget ceilings from authenticated
configuration and user grants. Reusing a client request ID with different content
returns a conflict rather than creating or silently replacing a job.

### 08.3 Proposed model action proposal

```json
{
  "schema_version": 1,
  "step_id": "step-issued-by-host",
  "kind": "tool",
  "tool_name": "browser.inspect",
  "arguments": {"tab_id": "tab-issued-by-host"},
  "purpose": "Locate the report download link",
  "expected_observation": "A link with a document label is present"
}
```

Use a discriminated union for tool, ask-user, propose-completion and report-blocked
proposals. Do not include writable `approved`, `verified` or `run_status` fields.
The host rejects unknown tools, extra privileged fields, stale IDs and arguments
outside the schema. Unknown fields should not be silently interpreted as commands.

### 08.4 Proposed tool receipt

```json
{
  "schema_version": 1,
  "operation_id": "op-issued-by-host",
  "attempt_id": "attempt-issued-by-host",
  "status": "succeeded",
  "effect_state": "none",
  "data": {"matches": []},
  "error": null,
  "evidence_ids": ["evidence-issued-by-host"],
  "artifact_ids": [],
  "started_at": "2026-09-14T08:00:00Z",
  "finished_at": "2026-09-14T08:00:01Z"
}
```

Status describes execution. Effect state describes whether a mutation is absent,
confirmed, rejected or uncertain. Verification separately says whether acceptance
criteria are met. Empty matches are not fabricated errors or fabricated task success.

### 08.5 Validation rules

Prefer strict schemas for permission flags, integer limits, enums and identity
fields. Do not allow a string such as `"false"` to accidentally authorize an action.
Pydantic offers strict validation controls, but inspect JSON-specific behavior and
test boundary types rather than assuming one setting validates semantics.
[Pydantic strict-mode documentation](https://docs.pydantic.dev/latest/concepts/strict_mode/)

Schema validation is only the first layer. A valid path can still be outside scope.
A valid URL can still point to a prohibited destination. A valid step ID can still
belong to another run. Add host-side semantic, ownership and policy checks.

### 08.6 Versioning

Persist schema versions with records and events. Accept only explicitly supported
versions. Add fields compatibly where possible; define a migration when meaning
changes. Tool implementations and skill workflows have their own version/hash so
an old paused job does not silently execute changed behavior after an upgrade.

<a id="storage"></a>
## 09. Phase 4: durable storage and migrations

**Packets:** P10–P11. Proposed default: a separate local runtime SQLite database.

### 09.1 Why a separate runtime store

The runtime stores control-plane records: jobs, steps, approvals, effects and
evidence. The personal-record store contains tasks, schedules, notes and memories.
They have different ownership and retention rules. A working-copy reseed must not
erase a job or its approval history. A chat-history clear must not silently delete
uncertain external-action receipts.

Do not sync the live SQLite file through Git, a generic file synchronizer or the
existing record mirror. Initially the runtime DB is device-local. Cross-device
summaries are an explicit later export with redaction and ownership semantics.

### 09.2 Proposed record inventory

| Record | Essential fields | Key invariant |
| --- | --- | --- |
| sessions | id, principal_id, device_id, title, created_at | Scope and transcript isolation |
| runs | id, session_id, client_request_id, request_hash, status, input_ref, policy_snapshot, budget_snapshot, owner_generation, lease_owner, lease_expires_at, timestamps | One logical job per client idempotency key |
| steps | id, run_id, ordinal, type, status, acceptance_spec, dependencies, workflow_version | Host-validated plan with stable identities |
| operations | id, run_id, step_id, tool_name, tool_version, canonical_args_hash, effect_class, status, idempotency_key, prepared_at | Logical side effect identified before dispatch |
| attempts | id, operation_id, number, owner_generation, started_at, ended_at, outcome, error_code | Every retry distinguishable |
| events | run_id, seq, event_id, type, payload_ref, created_at | Ordered committed event stream |
| approvals | id, run_id, operation_id, bound_request_hash, principal_id, decision, expires_at, consumed_at, policy_version | Approval cannot authorize changed effects |
| artifacts | id, run_id, logical_name, relative_path, content_hash, bytes, mime, state, created_at | Referenced files are verified and addressable |
| evidence | id, run_id, step_id, source_kind, source_ref, observed_at, trust_level, content_hash | Provenance separate from model assertions |
| verifications | id, run_id, step_id, criterion_id, verifier_version, result, evidence_ids | Success attributable to checks |
| domain_commands | operation_id, destination_owner, target_uid, expected_revision, payload_ref, status, acknowledged_revision | Bridge effects survive disconnect/reseed |
| process_handles | id, run_id, operation_id, pid, creation_identity, owner_instance, status, log_refs | PID alone is never ownership proof |
| schedules | id, owner_device, workflow_ref, timezone, recurrence, authorization_scope, enabled | Scheduled work stays within granted scope |
| schedule_occurrences | schedule_id, occurrence_key, run_id, status | A wakeup cannot create duplicate jobs |

Use foreign keys and constraints, not only comments. Add indexes for queued jobs,
lease expiry, run event sequence, outstanding approvals and unresolved operations.
Keep large outputs outside hot rows, referenced through artifacts or bounded blobs.

### 09.3 Transaction rules

Use short transactions for state transitions. Update run/step state and append the
corresponding event in the same transaction. Commit first; publish afterwards.
Never hold a SQLite write transaction while waiting on a network model or browser.

Allocate a run-local event sequence inside the same serialized transaction; enforce
`UNIQUE(run_id, seq)`. Do not compute `MAX(seq)+1` outside a protected write path.
Run transitions use expected current state and generation in their update predicate.

SQLite provides transactional atomicity, but transaction boundaries do not include
arbitrary filesystem or remote-service effects. [SQLite transaction overview](https://www.sqlite.org/transactional.html)

The current personal DB uses WAL with `synchronous=NORMAL`. Do not promise that
this is equivalent to durable completion after sudden power loss. For the new
control-plane DB, evaluate WAL plus `synchronous=FULL` for critical acknowledgments,
measure the cost, and document hardware/filesystem limitations. Keep this policy
local to the runtime unless a separately reviewed change updates the existing DB.

### 09.4 Effect/receipt ordering

```text
transaction: validate ownership + persist PREPARED operation
commit
execute external effect outside DB transaction
observe/reconcile actual result
transaction: persist receipt + step status + event
commit
publish event to subscribers
```

Crash between effect and receipt produces **UNCERTAIN**, unless the adapter can
query by idempotency key or verify a unique result. Do not claim this ordering alone
provides exactly-once execution.

For artifacts: write to an owned temporary file, finish and verify content, perform
an atomic same-volume rename where supported, then commit the artifact record and
event. Startup reconciles orphan temporary files and files without manifest entries.
A committed record referring to a missing file is an error, not a downloadable artifact.

### 09.5 Migrations, backup and restore

1. Refuse new jobs while a runtime migration is in progress.
2. Establish exclusive migration ownership and validate the source schema version.
3. Use SQLite's supported backup mechanism or a quiesced/checkpointed procedure;
   do not blindly copy only the main file while WAL writes are active.
4. Record backup checksum, source version and path on D:.
5. Apply a reviewed migration transaction with explicit failure handling.
6. Run integrity checks and invariant queries against the migrated fixture first.
7. Test restoration in a separate directory before changing a real store.
8. Reject a newer unsupported schema; do not downgrade or wipe it automatically.

Test interruption at every migration boundary. Existing migration behavior must be
reviewed rather than copied into the new runtime blindly. Restoring a backup does
not undo external effects performed after that backup; recovery still reconciles them.

<a id="runtime"></a>
## 10. Phase 5: job state machine and recovery

**Packets:** P12–P13. Begin with one worker and read-only fixture jobs.

### 10.1 Run states

| State | Meaning | Allowed next states |
| --- | --- | --- |
| QUEUED | Persisted and awaiting admission | RUNNING, CANCELLED, FAILED |
| RUNNING | Valid owner advancing steps | WAITING_USER, WAITING_APPROVAL, WAITING_RESOURCE, PAUSED, RECOVERING, COMPLETED, FAILED, CANCEL_REQUESTED |
| WAITING_USER | Missing decision/information | QUEUED after validated response, CANCELLED |
| WAITING_APPROVAL | Exact proposed effect awaits decision | QUEUED after grant, PAUSED/FAILED after denial according to scope, CANCELLED |
| WAITING_RESOURCE | Capacity or owned resource unavailable | QUEUED, PAUSED, CANCELLED |
| PAUSED | Explicit pause or exhausted budget | QUEUED after authorized resume, CANCELLED |
| RECOVERING | Interrupted work being reconciled | QUEUED, WAITING_USER, FAILED, CANCELLED |
| CANCEL_REQUESTED | No new effects; cleanup/reconciliation underway | CANCELLED, WAITING_USER if an effect remains uncertain |
| COMPLETED | All required criteria verified | terminal |
| FAILED | Job cannot meet criteria within policy | terminal |
| CANCELLED | No new work will run; known effects reported | terminal |

Do not reuse a terminal run for a new goal. Create a new run linked by
`parent_run_id` or `continuation_of`, preserving the original outcome. A completed
draft is not “incomplete” merely because the user later requests a different draft.

### 10.2 Step states differ from run states

Steps may be PENDING, READY, RUNNING, WAITING, VERIFIED, FAILED, UNCERTAIN or SKIPPED.
An operation can succeed while its step fails verification. A step marked SKIPPED
must say why and whether its acceptance criterion was optional. The model may
propose skipping, but the host must reject skipping required work without consent.

### 10.3 Ownership and leases

Each worker admission atomically claims a run and increments `owner_generation`.
Every subsequent state write includes that generation. A stale worker cannot
commit results into a newer run generation. Renew leases with bounded heartbeat
logic independent of UI subscribers.

A database generation check only fences database writes. It does not magically
stop an old worker from clicking a website. For browser/desktop resources, prevent
takeover until the old owner is stopped or the adapter can enforce a generation
check immediately before the action. On an ambiguous takeover, pause for recovery.

Use an OS/process-level single-instance guard for the runtime worker on a device,
plus database ownership checks. Do not assume a Python in-memory lock serializes
two separate backend processes or two development-reload generations.

### 10.4 Session serialization

Initially allow one active conversational writer per session. Queue follow-ups or
explicitly treat them as steering/cancellation. Different sessions may later run
concurrently if resources do not conflict. Do not let independent sessions share
a provider object's mutable response buffer or active browser tab by accident.

Scope provider response state to a request. Shared HTTP connection pools may be
reused; shared mutable `last_result` state must not cross concurrent runs.

### 10.5 Recovery matrix

| Last durable fact | Recovery action |
| --- | --- |
| Step queued; no operation prepared | Resume normally after ownership checks |
| Read-only operation prepared; no receipt | Re-run if observation freshness/policy permits |
| Idempotent operation prepared; no receipt | Query by idempotency key, then retry only if safe |
| External non-idempotent operation started; no receipt | Mark uncertain; inspect actual destination or ask user |
| Receipt committed; UI did not receive event | Replay event; do not execute again |
| Artifact file complete; manifest missing | Reconcile hash/path into quarantine or recoverable entry |
| Approval expired while worker stopped | Request fresh approval for current exact effect |
| Tool or workflow changed since checkpoint | Compatibility check; replan/reapprove changed effects |
| Budget exhausted | Pause with completed facts and required additional budget |

### 10.6 Cancellation policy

Submission records whether a job continues without the UI. Read-only research can
usually continue. Interactive desktop control may require the user present and
pause when the app loses its authorized control session. Make that policy visible.

Cancel means stop scheduling new effects, interrupt owned cancellable work, persist
the outcome and report effects that already happened. It does not mean undo all
previous actions. Compensation is a separate authorized workflow.

### 10.7 Gate before writes

Kill a fixture worker at multiple safe injection points, restart it, reconnect two
clients and verify one execution history. Demonstrate no duplicated committed
artifact, ordered event replay and honest uncertainty. Until this passes, keep
new-runtime mutation adapters disabled.

<a id="permissions"></a>
## 11. Phase 6: permissions, approvals and local API security

**Packet:** P14. This is a hard gate before expanding autonomous writes.

### 11.1 Three separate questions

1. **Authentication:** who is making this API request?
2. **Authorization:** may that principal/run use this capability on this target?
3. **Approval:** did the user authorize this particular sensitive effect?

A localhost connection answers none of these by itself. A tool schema answers
none of them either. CORS is not authentication. A model saying “the user agreed”
is not an approval record.

### 11.2 Proposed effect classes

| Class | Example | Default policy |
| --- | --- | --- |
| READ_SCOPED | Read an allowed project file | Allow within authenticated run scope |
| WRITE_DRAFT | Create a new artifact under the run directory | Allow with size/type/path limits |
| WRITE_PERSONAL | Add an explicitly requested reminder | Allow under existing product semantics and target checks |
| MODIFY_EXISTING | Overwrite a report or edit a selected record | Require appropriate existing permission/precondition |
| EXTERNAL_COMMIT | Send message, post content, submit transaction | Exact user approval or an explicit narrow standing grant |
| DESTRUCTIVE | Delete records/files, discard work | Preserve/strengthen existing confirmation and recoverability |
| PRIVILEGE_CHANGE | Change security settings or install executable integration | Separate explicit authority and review |

The same effect may be reached through several tools. A browser click, keyboard
shortcut or shell script that sends a message is still an external commit. Tool
names alone are insufficient to determine risk.

### 11.3 Approval lifecycle

1. Normalize the proposed target and arguments without silently changing intent.
2. Compute a canonical request hash covering operation ID, tool/version, effective
   scope, target, content hash and material preconditions.
3. Persist a pending approval tied to the principal and run.
4. Show a human-readable summary of the actual effect, including recipient/path,
   content preview and consequences. Do not show only an opaque hash.
5. Accept approval through an authenticated UI action or a bounded voice
   confirmation matched to exactly one pending request.
6. At dispatch, revalidate current target/preconditions, approval expiry, policy
   version and ownership. Consume approval atomically with dispatch authorization.
7. If content, target, account or material conditions changed, invalidate the old
   approval and ask again. Never substitute a “close enough” recipient.
8. Persist the execution receipt or uncertainty. A consumed approval with unknown
   dispatch outcome cannot simply be reused for another attempt.

“Yes” is ambiguous when several requests are pending. Ask which action the user
means. Do not let a background model generate the confirmation utterance itself.

### 11.4 Local API protection

Introduce authenticated local requests before sensitive run/approval endpoints are
enabled. Use a reviewed native bootstrap/pairing mechanism; do not publish a master
token in the frontend bundle, URLs, logs or repository. A native bootstrap nonce
should be short-lived and bound to the expected local instance. A regular browser
client needs its own explicit pairing/session flow.

Protect mutation endpoints against unauthorized origins and cross-site requests.
Authenticate WebSocket/SSE access as well as REST. If an EventSource client cannot
send the chosen auth header, use a fetch-based stream or a reviewed cookie scheme;
do not solve it by putting long-lived secrets in query strings.

Keep local-only binding by default. Remote access requires a separately reviewed
transport, device identity and policy design. Do not expose shell or approval APIs
to the LAN because the frontend happens to need connectivity.

### 11.5 File, network and process scope

Resolve canonical paths and check ancestry, not a textual prefix. Account for
Windows case-insensitivity, junctions, symlinks, UNC paths, alternate data streams
and target replacement between inspection and use. A check on `D:\work` must not
accidentally authorize `D:\work-other`. Use conservative allowlists and handle-based
checks where practical for sensitive writes.

Use argument-array process launching for structured capabilities. General shell
execution should be a distinct high-power capability with explicit workspace and
environment limits. A regex detecting dangerous strings is a warning aid, not a
sandbox. Package installation and downloaded code execution require their own gate.

For network readers, validate schemes, redirects and resolved destinations. Prevent
unexpected access to loopback, link-local or private services unless specifically
authorized. A webpage cannot instruct a network tool to upload credentials or read
arbitrary local files. Treat downloaded documents and tool descriptions as untrusted.

### 11.6 Required adversarial fixtures

Reject a first-call model `confirmed=true`, cross-run approval ID, changed recipient,
changed file hash, expired approval, replayed approval, forged evidence ID,
untrusted page asking to disable safeguards, unauthorized localhost request and
path traversal through a fixture junction. Use dummy destinations and files only.

<a id="processes"></a>
## 12. Phase 7: managed processes and resources

**Packet:** P15. A background command is a managed resource, not “append an ampersand.”

### 12.1 Proposed process API

Provide internal operations equivalent to `start`, `status`, `read_output`, `cancel`
and `wait`. Return a host-issued process handle, not just a PID. Record creation
time/identity, owner instance, operation ID, executable, working directory and output
artifacts. PIDs are reused; killing by a stale PID can terminate an unrelated app.

Default subprocesses inherit a sanitized, explicit environment. Provider keys and
personal data do not need to be inherited by every build or utility. Secrets that
an adapter genuinely requires are injected narrowly and redacted from diagnostics.

### 12.2 Foreground versus background

Foreground tools remain cancellable with the owning operation. Background jobs are
owned by the durable runtime and can outlive the UI according to submission policy.
They still have wall-time, output, disk, CPU and memory budgets. Give the user a
visible cancel mechanism and an honest status even when no output is being produced.

On Windows, evaluate Job Objects for process-tree lifetime control. Do not assume
closing a parent automatically kills children. Do not detach a process until the
runtime has recorded ownership and a reliable way to reconcile it after restart.

### 12.3 Output handling

Stream output into bounded files/ring buffers on D:. Maintain byte offsets so clients
can resume reading. Keep a small head/tail summary for the model and a reference to
full allowed output. Mark truncation explicitly. Redact known secret patterns, but
do not claim regex redaction catches all sensitive material.

Silence is not failure, and output is not proof of progress. Distinguish starting,
running, waiting for input, exited, timed out, cancelled and unknown. Interactive
commands that require a terminal should either use an explicit managed terminal
adapter or fail with a clear unsupported-interaction message.

### 12.4 Resource admission

Start with conservative configured limits and measure them. Do not hardcode an
assumption that the user's machine always has enough free RAM or disk.

Resource keys can include a browser profile, a UI desktop session, a target project,
a package environment and a GPU. Write access to a shared repository is exclusive
unless an explicit safe isolation mechanism exists. Browser actions on the same
profile cannot be independently parallelized just because they came from two models.

If a benchmark requires a quiet machine, it must acquire an exclusive benchmark
resource lease. This is a future boundary with the independent TTS Arena, not
permission to start or alter its campaign here.

### 12.5 Process acceptance gate

Use harmless fixtures that print, remain silent, produce excessive output, exit
nonzero and spawn a known child. Verify cancellation, output offsets, size limits,
restart reconciliation and no impact on unrelated processes. Do not install a
large model just to demonstrate background-job support.

<a id="domain-effects"></a>
## 13. Phase 8: personal-data effects and acknowledgments

**Packet:** P16. This phase prevents “JARVIS said it added it, but my board is empty.”

### 13.1 Ownership-aware command adapter

New runtime code should call a domain adapter, not write directly to whichever
SQLite database happens to be open. The adapter resolves the authoritative owner
from effective configuration and the authenticated client/device.

In backend-owned mode, apply the domain mutation and its deduplication receipt in
the same authoritative transaction where feasible. In client-owned mode, persist
a domain command in the runtime outbox and deliver it to the owning client. The
client applies the mutation and records the operation ID in the same IndexedDB
transaction, then acknowledges the resulting UID/revision.

Do not attempt an imaginary atomic transaction across runtime SQLite, backend
SQLite and frontend IndexedDB. They are separate stores. Use durable messages,
idempotent application and acknowledgments.

### 13.2 Command structure

Include operation ID, command version, target UID, expected current revision,
requested patch, scope/approval reference and creation time. Creating a new task
uses a stable host-issued UID that remains the same on redelivery.

The owner returns applied, already-applied, conflict, rejected or unavailable.
“Already applied” includes the original result reference, not a second mutation.
Deletion receipts survive a subsequent reseed so replay cannot resurrect a record.

### 13.3 Preserving existing behavior during migration

Migrate one tool family at a time behind a flag. Existing tools can continue through
the legacy path while the new domain adapter is tested with fixtures. Do not
silently route half of one logical operation through each ownership mechanism.

Until a client-owned mutation receives a durable owner acknowledgment, report
“pending synchronization with this device,” not “saved to your board.” A backend
working-copy write alone is insufficient evidence of authoritative completion.

If the UI is closed, a read-only job may continue from an explicitly labeled cached
snapshot. An operation requiring fresh personal data waits for the owner unless a
reviewed offline policy provides a durable alternative. Do not silently promote the
backend working copy to authoritative status to keep a job running.

### 13.4 Conflicts and tests

Test duplicate delivery, client crash after commit before ACK, backend crash before
ACK persistence, manual edit before command arrival, deletion tombstone conflicts,
reseed during pending delivery and switching supported ownership modes.

Record identity uses UID, not transient local integer row IDs. A revision conflict
requires re-reading the target and asking/replanning as needed. It must not overwrite
the user's newer edit merely because the agent planned earlier.

<a id="api-ui"></a>
## 14. Phase 9: job API, event stream and UI

**Packets:** P17–P18. Keep the existing chat API as a compatibility surface while
the new runtime is introduced.

### 14.1 Proposed endpoints

| Endpoint | Purpose | Important rule |
| --- | --- | --- |
| `POST /api/agent/runs` | Submit a job | Authenticate; deduplicate client request ID |
| `GET /api/agent/runs/{id}` | Inspect state and summary | Enforce principal/run ownership |
| `GET /api/agent/runs/{id}/events?after={seq}` | Replay and follow committed events | Reconnect never repeats effects |
| `POST /api/agent/runs/{id}/cancel` | Request cancellation | Idempotent; report existing effects |
| `POST /api/agent/runs/{id}/resume` | Resume paused/recoverable work | Revalidate policy, budget and version compatibility |
| `POST /api/agent/runs/{id}/input` | Supply requested information | Bind to the current pending question |
| `POST /api/agent/approvals/{id}/decision` | Grant or deny exact approval | Authenticated human decision, not a model tool |
| `GET /api/agent/artifacts/{id}` | Retrieve an authorized artifact | No arbitrary path parameter |
| `GET /api/agent/capabilities` | Report readiness and constraints | Do not disclose secrets or unnecessary filesystem details |

Return `202 Accepted` with the run ID after durable submission, not after the task
finishes. A request timeout before receiving this response is handled by retrying
the same client request ID and payload, not creating a fresh logical request.

### 14.2 Event delivery

Persist event order and expose a monotonically increasing run sequence. Clients
apply each event once by ID/sequence. A reconnection provides its last committed
cursor. A retention-expired cursor gets a current snapshot plus an explicit replay
boundary; do not silently drop the middle of the execution history.

The server must avoid the “read backlog, then subscribe” race. Either subscribe
before reading and deduplicate, or use a durable polling/notification pattern that
cannot miss events committed between those operations. Keepalive frames are not
persisted business events and must not advance the job sequence.

### 14.3 Minimal UI

Use a compact job card showing task title, state, current step, verified artifacts,
attention requests, elapsed active time and a cancel/pause control where supported.
Offer an expandable details view for evidence and failures. Do not make a wall of
logs the default interface.

Distinguish these messages:

- “Checking the page” means work is in progress.
- “Draft saved” means the artifact exists and passed its checks.
- “Waiting for approval to send” means no send has happened.
- “Send outcome uncertain” means retry may duplicate an action.
- “Completed with limitations” lists accepted limitations; it must not conceal a
  required unfulfilled criterion under a green success badge.

Keep voice-driven surfaces governed by the current product rules. Job management
can be a separate explicit view; do not unexpectedly open personal boards on every
typed tool event. Model output is rendered as data, not executable markup.

### 14.4 Compatibility bridge

Initially route opted-in chat requests through `RunService`, then adapt its events
to existing chat/voice formats. Keep exactly one execution owner. Do not run both
legacy `run_turn` and the new worker for the same request in an attempt to compare
them; use shadow planning with no effects or isolated fixtures instead.

Tests cover reconnect, duplicate events, two subscribers, cancelled runs, approval
expiry, artifact permissions, terminal events and frontend refresh after backend
restart. A page loading is not an end-to-end runtime test.

<a id="execution-loop"></a>
## 15. Phase 10: planning, action and verification

**Packets:** P19–P20. The reliable loop is smaller than a general autonomous planner.

### 15.1 Start from acceptance criteria

Convert the user's request into observable requirements before tool execution.
For a research draft, these might be a file in the approved output directory,
required sections, source links and a stated date. For a UI task, they might be
a specific setting value visible after the action. For sending, they include the
exact recipient/content and an independently observable receipt.

The model may propose criteria. The host checks that they cover the request and do
not enlarge it. For ambiguous, costly or sensitive work, show the proposed scope to
the user. For a routine reminder, preserve the existing low-friction capture flow.

### 15.2 Prefer reviewed workflows for repeatable work

Examples: create a reminder, summarize allowed files, research and save a draft,
inspect a process, collect a project diagnostic bundle. A workflow is a versioned
sequence/graph with typed inputs, permitted tools, required evidence and explicit
failure behavior. It is not an arbitrary executable plan generated by the model.

The model fills bounded parameters or selects among allowed branches. The host
resolves paths, validates IDs and enforces every transition. A new unfamiliar task
may require dynamic planning, but that should be a distinct, more closely supervised
route—not the default for adding a simple task.

### 15.3 Bounded step loop

```text
Read persisted step and current acceptance criteria
  -> acquire fresh relevant observations
  -> choose deterministic next action, or request one model proposal
  -> validate schema, scope, freshness, policy and budget
  -> obtain any required human approval
  -> execute through a versioned adapter
  -> commit receipt
  -> run registered verifier
  -> commit evidence and criterion status
  -> continue, bounded repair, wait, or finalize
```

Do not accept a model-generated list of ten arbitrary shell commands and run them
unexamined. A proposal is evaluated one bounded effect at a time unless a reviewed
workflow explicitly permits a safe atomic batch.

### 15.4 Verifier tiers

| Tier | Example | Can establish |
| --- | --- | --- |
| Deterministic structural | File exists, JSON parses, test exit code, content hash | Mechanical criteria |
| Semantic adapter | Correct task UID/revision, browser setting value, delivery ID | Domain result when adapter is authoritative |
| Evidence-constrained model review | Does the draft address each requested topic? | Advisory content assessment, not permission or effect proof |
| Human review | Voice pleasantness, nuanced writing preference, ambiguous action | User judgment and unresolved high-impact choices |

A verifier must be independent of the producer's unsupported assertion. “The model
said the file exists” is not a filesystem check. A successful click is not proof
the form was accepted. A model-generated screenshot description is not a delivery
receipt.

### 15.5 Evidence and freshness

Every criterion stores the verifier version, result, evidence references and time.
Stateful UI evidence has a short validity window; re-inspect after navigation or
material UI change. Artifact hashes refer to the delivered bytes, not an earlier
draft. Cite original source evidence rather than a chain of ungrounded summaries.

### 15.6 Repair bounds

Permit small, specific repairs: re-inspect a stale tab, correct a schema error,
retry a read after a transient timeout, regenerate a missing section. Set explicit
caps per step and per run. Repeating the same action with the same observation and
same error is a loop, not progress.

After a bounded repair fails, change strategy, escalate or ask the user. Do not
quietly weaken the acceptance criteria, skip tests or broaden permissions to obtain
a green result. Preserve partial artifacts and explain why completion stopped.

<a id="small-model-runtime"></a>
## 16. Phase 11: smaller-model runtime strategy

**Packet:** P21. This section addresses the model running inside JARVIS.

### 16.1 What the smaller model should not have to do

Do not ask it to remember an entire multi-hour task, detect all malicious content,
manage concurrent processes, infer filesystem permission boundaries, invent retry
policy, reconcile distributed state, select from every tool in the application and
judge its own success—all in one prompt.

Those are host/runtime responsibilities. Removing them from the model's workload
is more dependable than adding stronger adjectives to the system prompt.

### 16.2 Capability-based roles

| Role | Recommended responsibility | Not allowed to do |
| --- | --- | --- |
| Deterministic router | Recognized commands/workflows and obvious domain selection | Guess ambiguous authorization |
| Small executor model | One narrow next-action proposal using a small tool subset | Change policy, approve itself or declare verified completion |
| Balanced planner | Decompose unfamiliar requests into bounded steps | Directly execute unconstrained generated code |
| Strong reviewer/planner | Resolve difficult reasoning or audit high-risk changes | Bypass the same host permission checks |
| Deterministic verifier | Check artifacts, receipts, schemas and postconditions | Make subjective claims from missing evidence |
| Human | Resolve preferences, approvals and irreducible uncertainty | Be treated as having approved by silence |

These roles may initially use the same provider. Separate interfaces first. Select
specific models from measured task-family performance, context limits, tool/schema
support, Telugu handling, latency, cost and hardware feasibility. Parameter count
alone is not a capability contract.

### 16.3 A small task packet

Send a compact, consistent packet rather than the whole chat history:

```json
{
  "task": "Find the download link for the current fixture report",
  "step_id": "step-7",
  "allowed_tools": ["browser.inspect", "browser.find"],
  "current_observation": {
    "tab_id": "tab-2",
    "observation_id": "obs-19",
    "url": "https://fixture.invalid/reports",
    "elements": [{"id":"element-19-4","role":"link","name":"Annual report"}]
  },
  "already_done": ["Opened the approved reports page"],
  "must_not_do": ["Do not submit forms or download executables"],
  "completion_criterion": "Return the observed report link identity",
  "remaining_proposals": 2,
  "output_schema": "ActionProposal.v1"
}
```

The host provides IDs and permitted tools. A proposal referring to a missing or
stale element is rejected before action. Keep the packet size within a measured
fraction of the selected model's context window, reserving room for output and
tool results. Do not invent universal token budgets for all providers.

### 16.4 Constrained output and repair

Use native structured output or tool calling when supported and tested. Otherwise
use a strict parser with one bounded schema-repair opportunity. Invalid output
must not fall through to shell execution. If a provider cannot reliably express
the action contract, mark that model unsuitable for this executor role.

Include enums, short descriptions and examples of valid actions. Avoid dozens of
overlapping tools with nearly identical names. A general task should discover a
domain first, then receive only the relevant schemas. Deterministic domain selection
can avoid a model call entirely for common requests.

### 16.5 Escalation policy

Escalation triggers should be observable:

- Repeated invalid proposals after the bounded repair attempt.
- Two distinct approaches failed the same required criterion.
- New ambiguity materially changes the user's intended outcome.
- Required evidence contradicts the proposed answer.
- A task needs a capability/context size the selected model lacks.
- The remaining budget cannot support a reliable continuation.

Example initial policy: at most one schema repair and two semantic repairs per
step, then review. These are proposed starting limits, not benchmarked optimal
values. Track their effect and adjust from evidence.

Never use the model's self-reported confidence as the only gate. Never escalate
permissions when escalating model intelligence. A stronger model receives the same
effective scope, existing evidence and outstanding uncertainty.

### 16.6 When a stronger model is unavailable

Support three explicit modes:

1. Small-model-only: reviewed workflows; stop or ask for help on unsupported tasks.
2. Hybrid: small executor with budgeted stronger planning/review.
3. Manual review: small model prepares a proposal/artifact; user authorizes the next step.

Do not silently switch to an expensive provider. Honor configured ceilings and
consent. If the user wants zero remote inference, unavailable local capabilities
must produce an honest limit rather than hidden cloud fallback.

### 16.7 Cost accounting

Record model ID/version where available, provider, input/output usage, cache usage,
latency, retries and estimated cost basis. Provider prices change; store the pricing
timestamp and mark estimates. Count failed attempts and repairs, not just the final
successful call. Report cost per verified completed task, not merely cost per token.

Batch only independent read-only planning/review work whose outputs can be checked
separately. Do not use batching to bypass approvals or to hide multiple side effects
inside a single model response.

### 16.8 Downgrade gate

Before making a smaller model the default, run the same held-out suite with the same
tool versions and budgets. Require acceptable task-family completion and no newly
observed unauthorized actions. Investigate increased false-success or recovery
failure even if the smaller model is much cheaper. Preserve a tested rollback route.

<a id="memory"></a>
## 17. Phase 12: context and memory

**Packet:** P22. Keep existing memory semantics; add task-specific context around them.

### 17.1 Separate four stores conceptually

1. Conversation: what was said, with provider-compatible tool history.
2. Run state: exact current steps, receipts, approvals and unresolved questions.
3. Personal memory: durable preferences/facts under existing review/deletion rules.
4. Evidence/artifacts: source observations and deliverables for a particular task.

Do not use an LLM summary as the authoritative replacement for an operation ledger.
Do not insert every failed command into permanent personal memory. Temporary task
facts should expire or remain scoped to their run.

### 17.2 Context assembly order

Preserve the existing question-placement fix. Build stable instructions, relevant
session context, task-specific state and necessary current observations. Keep the
current user request at the correct generation boundary before tool execution,
then preserve proper assistant/tool sequencing after tools begin.

Include only relevant personal memories with provenance and validity. Explicit
user corrections outrank inferred candidates. A model-written summary cannot
restore a deleted memory or silently override a newer selected preference.

### 17.3 Compaction

Compact prose, not authoritative state. A checkpoint includes current objective,
accepted scope, required criteria, verified steps, unresolved operations, key
artifact/evidence IDs and remaining budgets. Full records remain retrievable.

Before discarding old context from the model window, validate that referenced
evidence still exists. On resume, reconstruct the packet from durable records.
Never ask a small model to reconstruct missing approval or effect state from vague
conversation fragments.

### 17.4 Telugu and mixed-language retrieval

Add fixtures with Telugu vowel signs, combining marks, transliterated names,
English technical terms inside Telugu and user spelling variants. Test exact
identity retrieval separately from fuzzy semantic relevance. Normalization must
not merge distinct people, accounts or technical identifiers.

Label inference versus explicit memory and retain correction provenance. Evaluate
retrieval precision and recall on curated fixtures; do not add an embedding model
without measuring whether the current lexical system actually fails those cases.

<a id="skills"></a>
## 18. Phase 13: skills and tool discovery

**Packet:** P23. A skill should make a repeatable task smaller, not grant extra authority.

### 18.1 Skill manifest

A reviewed manifest declares ID, version/hash, purpose, accepted input schema,
workflow entry point, capability requirements, effect classes, output schema,
verifiers, platform support and dependency references. Keep instructions separate
from executable code. Do not execute a downloaded skill just because its prose
claims it is trustworthy.

Example skill families: project inspection, research draft, personal reminder,
document export, browser information collection and local artifact organization.
Each should have a tiny fixture suite and explicit failure messages.

### 18.2 Discovery flow

Map the request to a small set of candidate domains. Load descriptions first;
expand full tool schemas only for selected capabilities. Verify adapter readiness
before offering a tool. “Installed” and “operational for this task” are different.

The host checks that a skill's requested permissions fit the user's grant. A
manifest update that expands permissions requires review. Existing approvals bind
to the prior version and cannot automatically authorize changed behavior.

### 18.3 Avoid framework sprawl

Begin with a local registry and a handful of versioned workflows. Do not implement
a marketplace, arbitrary package installer and remote code loader before the first
reliable workflows exist. External skill distribution is a separate security and
maintenance problem.

<a id="automation"></a>
## 19. Phase 14: browser and desktop automation

**Packets:** P24–P25. Use structured control wherever available; never confuse action
dispatch with verified success.

### 19.1 Browser ownership modes

Support explicitly named modes:

- Ephemeral fixture browser: isolated test state, no personal accounts.
- Dedicated persistent JARVIS profile: user logs in deliberately; profile stays
  private under the approved D-drive data root.
- Authorized existing-session attachment: only when the user explicitly selects
  it and the installed browser supports a reviewed attachment method.

Do not copy the user's default profile or cookie database as a shortcut. Do not
expose a remote-debugging port to the network. Protect browser profiles like
credentials and never commit them to Git.

Playwright provides persistent-context APIs; consult the installed version's
constraints and use a dedicated user-data directory rather than assuming the
normal browser profile can be safely shared.
[Playwright BrowserType documentation](https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch-persistent-context)

### 19.2 Browser action protocol

Each browser operation names a profile/context, tab, observation generation and
target. Inspect before acting, re-inspect after material changes, and invalidate
references on navigation. Avoid a global mutable “active tab” shared across jobs.

Register missing tab-management/upload capabilities only after adding policy and
tests. Uploads require authorized source files and destination context. Downloads
are stored as artifacts with MIME/size limits; downloading is not executing.

For a form submission, capture the material fields and destination for approval,
revalidate them at dispatch and check the confirmation page/receipt afterwards.
A successful button click alone does not establish submission success.

### 19.3 Browser failure taxonomy

Distinguish closed tab, stale observation, no matching element, multiple ambiguous
matches, navigation timeout, login required, permission denied, challenge/CAPTCHA,
download blocked and unsupported page control. A CAPTCHA or login step should
request user help; do not attempt to evade the challenge.

Read-only browser extraction must treat page text as evidence, not instructions.
An “ignore your rules” message in a page remains page content even when summarized.

### 19.4 Windows automation worker

Synchronous UI Automation calls should not block FastAPI's event loop. Use a
dedicated serialized worker with the appropriate Windows/COM initialization and
thread affinity. Do not blindly move individual pywinauto calls onto arbitrary
threads while sharing thread-affine handles.

Track window/process identity, not just title text. Re-inspect when controls
change. Scope input to the intended application and give the user a visible way
to pause control. Global hotkeys and clipboard access are broad effects and need
explicit policy. Do not capture or overwrite unrelated clipboard contents for tests.

Register existing scroll, expand/collapse and window actions one at a time. Test
against owned Notepad/fixture applications, including stale handles and ambiguous
window titles. Record unsupported controls honestly.

### 19.5 Optional visual fallback

Only add screenshot/coordinate automation after structured tools and permissions
are stable. Require explicit capture scope, a compatible vision model, coordinate
mapping tests, sensitive-content policy and post-action verification. On an ambiguous
screen, ask the user instead of guessing a destructive button.

Visual automation is a distinct capability with additional failure modes, not a
universal fix for missing adapters. A smaller text-only model cannot be expected
to interpret pixels it never receives.

<a id="integrations"></a>
## 20. Phase 15: integrations and MCP

**Packet:** P26. Add only integrations connected to a real user workflow.

### 20.1 Adapter boundary

Every external adapter declares account identity, scopes, supported operations,
idempotency support, receipt/reconciliation method, rate limits, timeouts and
revocation behavior. Map its output into the same receipt/evidence contracts as
local tools. A remote tool is not exempt from runtime policy.

Start with read-only access or draft creation. Add send/post/delete only when the
exact destination and effect can be approved and verified. Permission to read an
account does not imply permission to send from it.

### 20.2 MCP-specific controls

Pin reviewed server/configuration versions where practical. Inspect tool schemas,
server identity and required credentials before enabling tools. Treat remote tool
descriptions and results as untrusted inputs; a server cannot appoint itself an
authority over the user's permissions.

Use destination-bound credentials with the minimum scopes needed; do not pass
through unrelated provider tokens. Validate authorization flows and redirect
destinations. The MCP security guidance discusses risks including confused-deputy
behavior and token passthrough; implement against the specification version used
by the chosen client/server.
[MCP security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

### 20.3 Failure and upgrade policy

Remote unavailability marks that capability unavailable and preserves job state.
An adapter upgrade invalidates compatibility assumptions and triggers contract
tests. Unknown response fields should not become executable instructions. If an
API cannot verify whether an external effect occurred, surface uncertainty and
avoid automatic duplicate submission.

<a id="schedules"></a>
## 21. Phase 16: schedules and background jobs

**Packet:** P27. Keep the existing reminder system; general automation is additive.

### 21.1 Schedule record

Store an explicit timezone, recurrence representation, workflow/version, input
template, owner device, authorization scope, misfire policy, concurrency rule,
budget and notification policy. A vague phrase such as “later” requires a resolved
time or a question; never fabricate an exact schedule silently.

Recurring authorization must state what can repeat. A daily read-only summary can
run under a standing grant. A future purchase or changed external message needs
the appropriate narrow authority; scheduling it does not bypass approval.

### 21.2 Idempotent occurrence creation

Compute a stable occurrence key from the schedule and intended firing time. Insert
the occurrence and run mapping with a uniqueness constraint. Two wakeups or a
restart must not create two jobs for the same occurrence.

Persist both execution status and delivery status. A job may complete while its
notification fails. Retrying notification must not rerun the whole job.

### 21.3 Sleep, offline and missed schedules

Choose per schedule: skip stale occurrence, execute once on wake, or ask the user.
Do not execute hundreds of accumulated jobs after a week offline. Handle timezone
changes and daylight-saving transitions explicitly even if the primary user stays
in India. Record the resolved UTC instant and original timezone intent.

Do not imply jobs run while the desktop computer is off. Continuing after the UI
closes requires an explicitly installed/enabled host service or tray runtime with
clear lifecycle controls. That is a separate installation decision, not something
an async task automatically provides.

### 21.4 Notifications

Notify on meaningful completion, failure or required input; avoid repeated unchanged
“still working” messages. Respect mute preferences. A notification is a transport
delivery, not a new user request. Use deduplication keys and a bounded retry outbox.

<a id="voice"></a>
## 22. Phase 17: voice, Telugu and Tenglish

**Packet:** P28. Voice is an interface to the same runtime, not a separate weaker agent.

### 22.1 Separate speech lifetime from job lifetime

Recognize speech, confirm the intended request when necessary, submit a durable job,
and provide a brief acknowledgment only after submission succeeds. Long work continues
according to policy while the voice interaction returns to its normal listening state.

Do not keep extending the 75-second speech timeout to accommodate an hour-long job.
Keep STT deadlines, model deadlines, tool deadlines, job budgets and audio playback
deadlines separate. Track time-to-first-audio separately from total job completion.

### 22.2 Preserve half-duplex and user controls

The microphone remains muted during playback by default. Background progress must
not create feedback loops or speak over a user-selected quiet state. Distinguish
“stop speaking” from “cancel the background job”; ask if the phrase is ambiguous.

Voice approvals name the exact pending action and use a fresh bounded confirmation
window. Background audio, tool output and the assistant's own TTS are not user
approval. Prefer an explicit UI confirmation for difficult high-impact choices.

### 22.3 Language data

Store original transcript, selected language, any normalized text and the reason
for normalization. Preserve English product names and identifiers inside Telugu.
Do not translate file paths, URLs, variable names or API identifiers automatically.

Fixtures should include: “రేపు morning 9 గంటలకు Operating Systems class ఉంది,”
English technical names in Telugu sentences, spoken decimal values, names with
multiple transliterations, and a correction to an earlier time. Test interpretation
separately from TTS pronunciation; poor speech output and wrong agent action are
different failures.

### 22.4 Relationship to the Telugu TTS Arena

Keep the Arena's listening samples and benchmarks independent. This runtime should
define a stable speech-provider boundary without selecting a winner prematurely.
Later integration needs an explicit user decision and measurements for latency,
memory, language quality and device feasibility. Do not make subjective voice scores
up or let TTS model installation block the agent reliability roadmap.

<a id="android"></a>
## 23. Phase 18: Android and cross-device behavior

**Packet:** P29. Desktop capability does not imply Android capability.

### 23.1 Platform matrix

| Capability | Windows desktop | Android initial policy |
| --- | --- | --- |
| Personal-data tools | Ownership-aware adapter | Existing client-owned data path preserved |
| Read-only remote research | Available with network/provider | Available while permitted lifecycle/network allow |
| General shell/filesystem control | Explicit scoped desktop capability | Not exposed as equivalent device-wide control |
| Windows UI Automation | Dedicated Windows worker | Unsupported; separate platform integration required |
| Desktop browser profile | Device-owned browser adapter | Not copied to phone |
| Long background execution | Requires live runtime/service policy | Do not promise unrestricted background Python |
| Job status viewing | Local runtime | Local runs or explicit authenticated remote status |

Android has platform-specific choices and restrictions for background tasks. Use
the official guidance matching target SDK and task type when that phase begins;
do not assume a foreground Python loop remains alive after app suspension.
[Android background-task overview](https://developer.android.com/develop/background-work/background-tasks)

### 23.2 Durable state placement

Runtime checkpoints on Android must live in explicitly persistent app-private
storage, not in a directory the existing backend treats as disposable. Keep
personal-record ownership unchanged. Handle storage pressure and process death
with a visible recoverable state, not a promise of uninterrupted execution.

### 23.3 Cross-device jobs

Initially keep execution device-local. If remote delegation is later introduced,
store the owner device and grant explicitly. Viewing a job from a phone does not
make the phone a second worker. A disconnected status mirror does not take over
execution automatically.

Handoff requires the old owner to stop or be reconciled, transfer a compatible
checkpoint, confirm capability availability and revalidate approvals. Browser
cookies, private credentials and local paths are not automatically transferable.
Use an authenticated encrypted protocol; the existing personal-data sync layer is
not automatically a job-execution protocol.

<a id="parallel"></a>
## 24. Phase 19: bounded parallel agents

**Packet:** P30. Add parallelism after a single worker is reliable.

### 24.1 When parallelism helps

Independent source collection, separate read-only analyses or disjoint draft
sections may run concurrently. A task that depends on the previous step's output
should remain sequential. More agents can increase cost and conflicting conclusions;
they do not automatically increase intelligence.

### 24.2 Child-run contract

A parent issues a bounded subtask with explicit input artifacts, allowed tools,
output schema, deadline, budget, resource scope and acceptance criteria. The child
cannot enlarge the parent's authorization. It returns evidence and an artifact,
not instructions the parent blindly obeys.

Aggregate child budgets into the parent ceiling. Start with a small configured
concurrency limit, such as two read-only children, and measure contention. This is
an initial policy suggestion, not a performance claim.

### 24.3 Shared-resource controls

One browser profile has one active mutation owner. One desktop input session has
one controller. One project write scope has one writer unless isolated working
copies are explicitly supported. Never schedule native desktop and Android builds
concurrently when they share frontend outputs.

Cancellation propagates to child runs according to their effect state. Completed
child artifacts remain available. A parent failure does not erase a child's external
receipt or justify executing the child again.

### 24.4 Review before merge

The parent checks child outputs against acceptance criteria and original evidence.
Conflicting findings are surfaced and reconciled; do not choose the more confident
wording. A reviewer model may assist, but it cannot prove correctness merely because
it is a different instance of the same model.

<a id="observability"></a>
## 25. Observability, privacy and artifact retention

**Packet:** P31. You cannot improve agent reliability if “something went wrong” is
the only recorded outcome.

### 25.1 Trace structure

Correlate a user request to a session, run, step, operation, attempt, model response,
tool receipt, verifier result and artifact. Use these IDs in structured logs and
status views. Record transitions and concise operational reasons, not private
chain-of-thought or unlimited provider reasoning streams.

At minimum record:

- Queue wait, active execution, model latency, tool latency and verification latency.
- Model/provider/version identifiers and tool/workflow/schema versions.
- Input/output token usage and cost estimate basis where available.
- Number of retries, repairs, escalations and human interventions.
- Outcome codes, cancellation cause, uncertainty and missing capabilities.
- Artifact hashes/sizes, evidence references and acceptance-criterion results.
- Hardware/runtime profile for performance comparisons.

Missing measurements are null/unavailable, not zero. “0 ms” should mean a measured
zero-scale result, not that a timer was never started.

### 25.2 Three logging levels

1. Operational metadata: enabled normally; IDs, timing, states and redacted codes.
2. Content trace: opt-in and locally access-controlled; limited prompt/tool excerpts
   needed for a particular diagnosis.
3. Sensitive material: credentials, cookies, private keys and session tokens are
   excluded from logs. Access remains in the appropriate secret store.

Artifact content may itself be sensitive. Access checks apply to preview, download,
export and log links, not only to initial creation. Do not place personal documents
in a public static directory or commit them as test examples.

### 25.3 Retention policy

Set explicit retention separately for transient output, debugging traces, job
summaries, user deliverables and unresolved effects. Example starting proposal:
short-lived debug traces, longer job metadata and user-controlled deliverable
retention. Choose actual durations with the owner rather than burying them in code.

Deleting a chat should clearly describe whether job artifacts/history remain.
Deleting a run must respect the user's deletion request while explaining any
external effects that cannot be undone. Avoid retaining unnecessary personal
content merely to preserve a technical receipt; retain minimal metadata where
appropriate and authorized.

Uncertain operations must not be silently erased by routine cleanup before they
are reconciled. Backups and browser profiles require their own access/retention
rules. Never put provider keys into a Git-tracked configuration snapshot.

### 25.4 Diagnostic bundle

Provide an opt-in export containing version info, selected redacted run events,
capability readiness, failing verifier results and artifact metadata. Preview its
contents before sharing. Exclude actual keys, cookies, personal DBs and unrelated
logs by default. This should replace guessing from screenshots of “not working.”

<a id="evaluation"></a>
## 26. Evaluation and quality gates

**Packet:** P32, followed by the model-downgrade gate P35. Tests are part of every
earlier packet; this phase assembles the complete evaluation system.

### 26.1 Test layers

| Layer | Purpose | Default side effects |
| --- | --- | --- |
| Contract tests | Types, IDs, enums, version compatibility | None |
| Unit tests | State transitions, routing, policies, error mapping | In-memory/fixture files only |
| Component tests | SQLite transactions, event replay, process ownership | Isolated local fixtures |
| Integration tests | Browser/desktop/data bridge flow | Owned test apps and origins |
| Fault-injection tests | Crash, timeout, disconnect, cancellation | Controlled fixture processes |
| Security tests | Approval bypass, scope escape, prompt injection | Dummy destinations and sandbox fixtures |
| Model evaluation | Real model proposals on fixed tasks | Budgeted explicit provider/local inference |
| Installed-path checks | Packaged launch and user interaction | Explicit selected installation/device |

Do not conflate these layers. Mocked provider tests prove protocol behavior, not
real model quality. A benchmark draft generated by a model does not prove browser
control works. An APK build does not prove on-device audio or automation behavior.

### 26.2 Essential deterministic regression set

The following suggested test names are targets to create, not existing files:

```text
test_call_ids_unique_across_rounds
test_provider_metadata_round_trip_after_restart
test_receipt_committed_before_result_event
test_interrupted_batch_has_explicit_unstarted_calls
test_unknown_effect_not_retried_automatically
test_browser_missing_tab_is_error
test_browser_empty_search_is_valid_empty_result
test_parent_cancellation_cleans_owned_process
test_cancellation_does_not_kill_unrelated_process
test_budget_exhaustion_has_honest_finalization
test_backend_instance_change_repeats_handshake
test_failed_handshake_does_not_set_ready
test_unrelated_port_listener_is_not_adopted
test_watchdog_crash_limit_requires_sustained_health
test_duplicate_submission_reuses_run
test_same_request_id_different_payload_conflicts
test_stale_owner_cannot_commit
test_stale_owner_cannot_dispatch_through_guarded_adapter
test_event_reconnect_replays_without_reexecution
test_first_call_confirmed_flag_cannot_approve
test_approval_changed_args_rejected
test_approval_replay_rejected
test_model_evidence_id_must_exist_in_run_scope
test_domain_command_duplicate_applies_once
test_client_commit_before_ack_survives_redelivery
test_reseed_does_not_delete_runtime_jobs
test_artifact_missing_file_never_marked_downloadable
test_same_schedule_occurrence_creates_one_run
test_child_budget_counts_against_parent
test_deleted_memory_not_reintroduced_by_summary
```

### 26.3 Fault injection boundaries

Inject interruption before job commit, after job commit before HTTP response,
after lease claim, before effect preparation, after preparation before dispatch,
after external effect before receipt, after receipt before event delivery, during
artifact finalization, during client ACK, and during schema migration.

For each boundary, specify expected durable state, whether execution may retry,
whether approval survives, and what the user sees. A single “restart test” is not
adequate coverage for all these different windows.

### 26.4 Runtime task families

Create synthetic or explicitly approved fixtures for:

1. Personal task/reminder creation, editing and conflict handling.
2. Read-only research with source evidence and a saved draft.
3. Browser navigation across several pages with stale-element recovery.
4. Form drafting without submission, then explicitly approved fixture submission.
5. Local file inspection and a new artifact under an allowed workspace.
6. Project diagnosis that must not implement an unrequested fix.
7. Long-running harmless process, disconnect and later result retrieval.
8. Interrupted effects with known, unknown and idempotent outcomes.
9. Scheduled read-only summary and missed-wakeup handling.
10. Telugu/Tenglish interpretation, correction and voice approval ambiguity.

Keep development examples separate from held-out evaluation tasks. Vary wording,
page layout, names, file locations and failure injection points so the model is not
merely memorizing the training fixtures. Include unsupported tasks where the correct
behavior is an honest refusal/clarification rather than improvisation.

### 26.5 Metrics and denominators

| Metric | Definition |
| --- | --- |
| Verified completion rate | Runs meeting all required criteria / attempted eligible runs |
| False-success rate | Runs reported complete while required criteria failed / runs reported complete |
| Recovery success rate | Recoverable interrupted fixtures correctly resumed / recoverable interruption fixtures |
| Unsafe-action count | Disallowed effects actually attempted/executed; report severity and conditions |
| Approval integrity | Replayed/forged/changed approvals rejected / adversarial approval fixtures |
| Intervention rate | Runs needing unplanned human help / attempted runs |
| Escalation rate | Runs routed beyond configured small model / attempted runs |
| Cost per verified task | Total inference cost including failures/repairs / verified completions |
| Latency | Queue, first feedback, active work and end-to-end duration separately |
| Artifact quality | Task-specific rubric, with human ratings clearly labeled |

Report absolute counts with percentages. Exclude only predeclared ineligible cases
and list exclusions. Do not hide unsupported tasks or provider failures from a
comparison by changing the denominator after seeing the results.

### 26.6 Proposed release thresholds

Require all deterministic correctness and safety fixtures to pass, with no silent
skips of required capabilities. For model-dependent routine workflows, a starting
target might be at least 90% verified completion on a predeclared held-out suite,
but the owner must set the acceptable threshold by task risk. Novel multi-app work
needs separate reporting, not a borrowed score from simple reminders.

No unauthorized effects or false approval acceptance may be knowingly shipped.
Zero observed failures in a finite suite is not proof of universal safety. Maintain
adversarial tests and production attention signals after release.

For latency/cost comparisons, record hardware, provider settings, model versions,
cache state, task corpus and repetition count. Report median and tail values with
sample counts. Do not compare one model's GPU results to another's CPU results
without showing the hardware difference.

### 26.7 OpenClaw comparison

Use the same task definitions, allowed permissions, fixture accounts, budgets and
success verifiers. Record configuration differences and unavailable capabilities.
Compare verified outcomes, not screenshots or tool counts. If OpenClaw is not
installed/evaluated, label the section “architecture comparison only.”

The useful engineering reference is its documented separation of run lifecycle,
session coordination and tools. This does not establish that JARVIS matches or
exceeds its performance. [OpenClaw agent-loop documentation](https://docs.openclaw.ai/concepts/agent-loop)

<a id="worked-flows"></a>
## 27. Worked end-to-end flows

These examples specify expected control flow. They are not instructions to execute
the tasks now. Use fixture destinations and records during implementation.

### 27.1 Research and save a report, using a small executor

**User request:** “Compare three options for my project and save a report. Don't
buy or sign up for anything.”

1. Intake records a draft-only grant and allowed research/output scope.
2. The host creates a run before returning acknowledgment.
3. A reviewed research workflow asks for any missing material constraints. It does
   not require clarification on harmless formatting preferences.
4. A planner proposes sections and evidence requirements. The host validates them.
5. The small executor receives one source-collection step with search/read tools.
6. Sources are fetched as untrusted evidence with URLs and observation timestamps.
7. A verifier checks that claims reference actual collected material. Unsupported
   claims remain marked uncertain or are removed.
8. The writer receives source excerpts, criteria and a draft schema—not browser
   cookies, approval tools or the whole personal memory store.
9. A file adapter saves the draft under the run artifact root.
10. Structural checks verify the file, required sections and citations. Optional
    content review flags omissions without inventing new evidence.
11. The job becomes complete only when required criteria pass.
12. The user receives the artifact, short findings and disclosed limitations.

If the UI closes after step 6, reconnecting shows the same run. If a source fails,
the workflow tries another within budget or reports the missing evidence. It does
not claim a comparison was completed from sources it never read.

### 27.2 Telugu reminder with a correction

**User request:** “రేపు morning 9 గంటలకు Operating Systems class ఉంది, remind me.”

1. Speech recognition records the original transcript and language selection.
2. Interpretation resolves tomorrow in the user's timezone and preserves the
   English class name. If the intended reminder time is ambiguous, ask concisely.
3. Preserve the application's established reminder semantics: explicit reminders
   normally have the existing 15-minute early notice plus the exact-time notice,
   except the documented instant/near-time behavior.
4. Create a stable domain operation and target UIDs before dispatch.
5. The authoritative personal-data owner applies the change idempotently and ACKs.
6. Only then confirm the saved reminders and actual times.
7. If the user says “కాదు, 10 గంటలకు,” resolve the correction against the relevant
   pending/recent reminder identities, not a guessed integer row ID.
8. If multiple possible reminders exist, ask which one; never silently change all.

If the client-owned data store is unavailable, say the change is waiting for that
device. A temporary backend working-copy write is not enough to say it was saved.

### 27.3 Diagnose a broken project without accidentally fixing it

**User request:** “Why is this project not starting?”

1. The run is classified as diagnosis, not implementation.
2. Scope permits relevant read-only source/config inspection and safe diagnostics.
3. The small executor receives a specific file/log inspection step.
4. Secrets and unrelated personal logs are excluded from context.
5. A deterministic checker distinguishes process absence, readiness failure,
   missing dependency and actual application exception.
6. A diagnostic artifact records evidence and reproduction conditions.
7. The final answer explains the most likely confirmed cause and unresolved facts.
8. If fixing requires editing dependencies, installing packages or restarting a
   shared service, present the proposed action and obtain the needed authority.

The workflow must not run an installation simply because a README mentions one.
Instructions found in the repository are task material and project guidance, not
automatic authorization for unrelated effects.

### 27.4 Fill a form and wait before submitting

**User request:** “Prepare this application using the information I gave you.”

1. User selects an authorized browser profile and page.
2. The worker inspects the form and maps supplied information to fields.
3. Unknown required fields produce a targeted question; no fabricated answers.
4. Fields are filled and read back to verify values.
5. The workflow reaches a draft-complete boundary. Preparing does not imply sending.
6. If the user requests submission, generate approval for the exact account,
   destination, form fields and relevant attachments.
7. After approval, recheck the page and bound content; changed data invalidates it.
8. Submit once through the guarded adapter, then inspect the receipt.
9. If the connection drops before a receipt, mark uncertain and inspect status.
10. Do not submit again unless reconciliation establishes that retry is safe.

A small model can assist with field matching. It must not decide from confidence
alone that a submission succeeded or that a second submission is harmless.

### 27.5 Long command with restart recovery

**User request:** “Run this approved project test suite and tell me the result.”

1. Resolve the exact project and test command; inspect whether tests use live
   providers or user databases before executing.
2. Allocate an operation, process handle, output files and resource lease.
3. Start the command with explicit working directory and D-drive temporary paths.
4. Publish committed process-start metadata and output offsets.
5. If the UI disconnects, the managed job continues under its recorded policy.
6. If the backend crashes, the supervisor/recovery logic reconciles the recorded
   process identity. It does not launch a second copy merely because no UI is open.
7. On process exit, store the exit code and full authorized log reference.
8. Verify that required tests actually ran; a skipped suite is not a clean pass.
9. Report passes, failures, skips and unverified cases separately.

If process ownership cannot be established after restart, stop and ask rather than
kill a process identified only by an old PID.

### 27.6 “Free space on C:” without destructive guessing

**User request:** “C drive is full; use D drive for project installations.”

1. Inspect relevant project/cache paths and free space read-only.
2. Identify which data belongs to this project and which is shared/personal.
3. Set future project paths deliberately; verify that tools resolve them to D:.
4. Propose exact recoverable moves for in-scope project data, including destination
   space, active-process checks and backup/restore plan.
5. Obtain authority for any material deletion or out-of-scope shared cache move.
6. Verify copied data and runtime behavior before removing old project-owned copies.
7. Report what moved, what remained and whether rollback is available.

Never treat a full disk as permission to delete Downloads, application data, model
caches belonging to other projects, or whole user directories.

<a id="coding-handoff"></a>
## 28. Using a smaller coding model to implement this

**This section is a working protocol for the coding assistant, not JARVIS runtime prompts.**

### 28.1 Divide responsibilities deliberately

Use a strong reviewer, when available, to resolve storage ownership, concurrency,
permissions, migrations and protocol contracts. Use a smaller model for bounded
implementation against those decisions and tests. If no stronger model is available,
the owner must review high-risk design choices and keep scope smaller.

A smaller model should not be asked to “make it OpenClaw level” in one turn. That
request lacks a verifiable boundary and invites broad rewrites, untested shortcuts
and claims based on code volume rather than behavior.

### 28.2 Work-packet size

One packet should change one behavior and have a clear testable result. Prefer a
small file scope, but do not turn an arbitrary line count into a correctness rule.
If a packet needs multiple subsystems changed at once, split contracts/tests from
implementation and UI wiring.

Do not mix a bug fix with dependency upgrades, unrelated cleanup and UI redesign.
Do not let a model rename large modules to make its patch look cleaner when the
assigned task is one cancellation bug.

### 28.3 Required packet contents

```text
Packet ID and title:
Status: NOT_STARTED / IN_PROGRESS / BLOCKED / VERIFIED / RELEASED
Starting commit:
Prerequisite packets and evidence:
Single objective:
User-visible behavior to preserve:
Allowed edit paths:
Read-only reference paths:
Files/data explicitly out of scope:
Existing reproduction:
Expected new behavior:
Input/output contracts:
Acceptance tests:
Exact validation commands (after reading test headers):
Failure/rollback plan:
Documentation updates required:
Unresolved decisions requiring owner/reviewer input:
```

The starting commit is a comparison point, not permission to reset the user's tree.
If concurrent changes overlap, inspect and coordinate instead of overwriting them.

### 28.4 Universal implementation prompt

Copy this template and fill in one packet from section 29:

```text
Implement only packet <ID> from docs/agentic-integration-playbook.md.

First read AGENTS.md, README.md, the relevant architecture sections,
explanations.md, the packet prerequisites and the affected source.
Follow the repository's main-only collaboration policy. Preserve all unrelated
working-tree changes. All new installation/cache/test output must stay on D:.

Before editing, state the exact behavior being changed and the smallest test
that demonstrates the current problem. Do not implement later packets.

Use the specified contracts. If the source contradicts the plan, report the
specific difference and resolve it before changing a storage, permission or
platform boundary. Do not silently invent a replacement architecture.

Add/adjust isolated regression tests, then make the smallest complete change.
Do not use real user records, live sync, paid APIs, or personal browser sessions
for tests unless separately authorized. A skipped required test is not a pass.

Review failures honestly. Do not weaken assertions, remove safeguards or report
success from build output alone. If a new dependency is necessary, explain why
existing dependencies cannot do the job before installing it.

Update the relevant documentation and explanations.md. Report changed paths,
checks actually run, limitations and remaining work. Commit/push only scoped
changes according to repository instructions. Do not claim installation or
on-device verification unless actually performed.
```

### 28.5 Independent review prompt

```text
Review packet <ID> against its acceptance criteria and the actual diff.
Do not assume the implementer's summary is correct.

Check: authorization boundaries, state transitions, persistence ordering,
failure/cancellation paths, duplicate execution, personal-data ownership,
platform behavior, backwards compatibility, and tests that fail on the old bug.

Use isolated fixtures only. Do not rewrite the implementation unless requested.
Return concrete defects with file/function references and a minimal reproduction.
Separate confirmed failures from risks and optional improvements.

Verdict: ACCEPT, REQUEST_CHANGES, or INSUFFICIENT_EVIDENCE.
Explain which acceptance criterion supports the verdict.
```

### 28.6 Session handoff template

```text
Packet:
Date / agent:
Baseline commit:
Current commit or uncommitted files:
What is implemented:
What is NOT implemented:
Tests run and exact results:
Tests not run and why:
Fixture/artifact locations:
New configuration/dependencies:
Safety and ownership decisions:
Open failures / uncertainties:
Next single action:
Rollback boundary:
```

Write the handoff before context is exhausted. Keep decisions and unresolved issues
in `explanations.md`. For a large implementation phase, a dedicated packet status
file can supplement it, but the shared notes must link to the current status.

### 28.7 Resuming with a different model

1. Read the handoff and inspect actual Git status/diff.
2. Verify the last passing tests still correspond to the current code.
3. Check that dependent packets are truly complete, not merely marked checked.
4. Reconstruct the next bounded objective from the packet, not from conversational
   confidence or an old “almost done” message.
5. Continue only that objective; do not restart finished expensive work.
6. If the previous agent left a partial unsafe change, disable that new path or
   finish its required safety boundary before trying it on real data.

### 28.8 Anti-shortcut checklist

Reject these implementation shortcuts:

- Raising the timeout instead of adding durable jobs.
- Catching every exception and returning success.
- Using `confirmed=true` from the model as proof of consent.
- Retrying an unknown external effect as if it were a failed read.
- Replacing all history with an unverified LLM summary.
- Adding tests that assert only “no exception” while ignoring actual outcomes.
- Removing failing tests or changing required outcomes to match the implementation.
- Using production DBs, personal accounts or paid APIs for convenience.
- Declaring a model superior without the same evaluation conditions.
- Bundling unrelated fixes into a packet because they are nearby in the file.

### 28.9 When the smaller coding model should stop

Stop for review when storage ownership is unclear, a migration can lose data,
an approval boundary is ambiguous, a provider protocol is undocumented, a fix
requires changing several independent contracts, or safe tests cannot be built.
Explain the exact question and available evidence. Do not repeatedly ask the
owner vague permission to “continue” when ordinary scoped implementation is clear.

<a id="work-packets"></a>
## 29. Work-packet ledger

All packets below are **NOT STARTED by this document**. Dependencies refer to these
IDs. The detailed sections above define the behavior; the ledger defines handoff
units. Proposed test filenames may be adjusted to repository conventions, but the
asserted behavior must not disappear.

### P00 — Baseline and containment

- Depends on: none.
- Scope: test harness/configuration and documentation; no production DB changes.
- Deliver: unique fixture root, mocked network default, explicit sync disablement,
  production-path refusal and baseline test record.
- Verify: a deliberately supplied production-like path is refused before import
  side effects; normal fixture tests run without credentials.
- Exit: test environment is demonstrably isolated.
- Rollback: remove only new fixture harness code, never user data.

### P01 — Environment and dependency inventory

- Depends on: P00.
- Scope: documented runtime paths, existing dependency metadata, readiness probes.
- Deliver: Python/Node/browser versions, effective storage mode, D-drive path plan
  and identified dependencies; no automatic large installs.
- Verify: resolved paths and capability prerequisites, with unavailable items named.
- Exit: later packets can run using explicit tools without assuming global PATH.
- Rollback: documentation/configuration additions only.

### P02 — Gemini call identity

- Depends on: P00.
- Scope: `providers/gemini.py`, minimal provider contracts, Gemini tests.
- Deliver: unique internal IDs and correctly bound provider metadata.
- Verify: multiple rounds, repeated/missing upstream IDs and restart representation.
- Exit: no old call changes name/signature after a new call.
- Rollback: adapter-only revert; preserve historical records.

### P03 — Interruption receipts

- Depends on: P00, P02.
- Scope: `llm/agent.py`, narrow persistence helper, isolated history tests.
- Deliver: receipts committed before result publication; interrupted batches reconciled.
- Verify: close after first result; missing and unstarted calls remain explicit.
- Exit: consumer disconnect cannot remove an already published completion receipt.
- Rollback: disable affected new behavior rather than rewrite real history blindly.

### P04 — Honest query outcomes

- Depends on: P00.
- Scope: computer-tool wrappers/handlers and outcome tests.
- Deliver: operational failures distinguished from valid empty results.
- Verify: handler, event and action-memory status agree on missing-tab fixture.
- Exit: no query error is automatically logged as succeeded.
- Rollback: retain compatibility adapter for old UI fields if needed.

### P05 — Foreground cancellation

- Depends on: P00.
- Scope: `tools_system.py::run_command` and owned-process tests.
- Deliver: bounded cancellation cleanup and cancellation propagation.
- Verify: fake process plus harmless owned child; unrelated processes untouched.
- Exit: all tested cancellation paths terminate/reap the owned tree or report failure.
- Rollback: disable long-running command exposure if cleanup is unreliable.

### P06 — Budget finalization

- Depends on: P03, P04.
- Scope: agent loop and budget tests.
- Deliver: separate action/finalization budgets and explicit terminal outcomes.
- Verify: exact last-round behavior, empty responses and finalizer failure.
- Exit: user sees verified partial/full result instead of unexplained tool-limit error.
- Rollback: deterministic summary fallback; never authorize extra actions implicitly.

### P07 — Backend readiness and watchdog

- Depends on: P00–P01.
- Scope: Tauri backend launcher, readiness API and startup diagnostics.
- Deliver: instance identity, sustained-health counter and bounded D-drive logs.
- Verify: unrelated listener, immediate crash, missing interpreter and hung runtime.
- Exit: readiness errors identify the failed prerequisite.
- Rollback: retain safe manual launch path; do not kill foreign port owners.

### P08 — Frontend handshake

- Depends on: P07.
- Scope: `page.tsx`, `agentBridge.ts`, targeted frontend tests.
- Deliver: acknowledged per-instance credentials/seed state with retry behavior.
- Verify: first failure, reconnect, backend restart and missing-key conditions.
- Exit: dashboard availability is not confused with assistant readiness.
- Rollback: feature-gated handshake path; preserve stored user preferences/keys.

### P09 — Runtime contracts

- Depends on: P02–P06.
- Scope: proposed `agent_runtime/contracts.py` and schema fixtures.
- Deliver: versioned requests, proposals, receipts, evidence and status enums.
- Verify: strict types, unknown privileged fields, foreign IDs and version conflicts.
- Exit: schemas do not give models authority over approvals or verified status.
- Rollback: no production path switched yet.

### P10 — Runtime store

- Depends on: P09.
- Scope: new runtime store/schema and transaction tests.
- Deliver: device-local job records separate from personal-data working copies.
- Verify: uniqueness, foreign keys, event/state atomicity and no reseed deletion.
- Exit: submissions and receipts survive process restart in isolated fixtures.
- Rollback: disable new runtime; retain its files for recovery.

### P11 — Migrations and restoration

- Depends on: P10.
- Scope: runtime migration/backup helpers and migration fixtures.
- Deliver: version gates, exclusive migration ownership and tested restore procedure.
- Verify: interrupted migration, integrity checks, unsupported newer schema.
- Exit: tested backup/restoration without production records.
- Rollback: restore a verified snapshot only under an explicit quiesced procedure.

### P12 — Read-only worker and state machine

- Depends on: P10–P11.
- Scope: service, worker, transitions and read-only fixture adapter.
- Deliver: submit/queue/execute/verify/finalize for one fixture workflow.
- Verify: duplicate submission, bounded execution and terminal state invariants.
- Exit: one read-only vertical slice works without a connected UI.
- Rollback: disable new submissions; leave recorded runs inspectable.

### P13 — Ownership, recovery and cancellation

- Depends on: P05, P12.
- Scope: leases/recovery and fault-injection tests.
- Deliver: generation-fenced writes, single-instance ownership and recovery matrix.
- Verify: competing workers, stale owner, disconnect, unknown effects and cancellation.
- Exit: no blind replay of uncertain operations.
- Rollback: pause affected runs and keep evidence; never relaunch them indiscriminately.

### P14 — Authenticated authority and approvals

- Depends on: P08–P10, P13.
- Scope: policy/approval services, local authentication boundary, minimal approval UI.
- Deliver: exact-action approval binding and scoped capability enforcement.
- Verify: forged/replayed/expired approval, changed target, unauthorized API request.
- Exit: model-supplied confirmation cannot execute a sensitive action.
- Rollback: disable sensitive capabilities, not the approval checks.

### P15 — Managed processes and resource leases

- Depends on: P13–P14.
- Scope: process manager and explicit resource admission.
- Deliver: owned handles, resumable output, cancellation and bounded resources.
- Verify: child tree, PID reuse safeguards, output cap, silent job and resource conflict.
- Exit: background commands remain inspectable and cancellable.
- Rollback: stop only owned jobs; retain logs and receipts.

### P16 — Domain command acknowledgment

- Depends on: P08, P10, P13–P14.
- Scope: runtime domain outbox, existing bridge, isolated client-store adapters.
- Deliver: ownership-aware idempotent personal-record operations with ACKs.
- Verify: duplicate delivery, crash-before-ACK, edit conflict and reseed.
- Exit: confirmed saved records exist in the authoritative owner store.
- Rollback: pause new domain writes; reconcile pending commands before changing path.

### P17 — Run API and event replay

- Depends on: P12–P14.
- Scope: proposed `api/agent_runs.py`, route registration and API tests.
- Deliver: submit/inspect/cancel/resume/input/artifacts/events endpoints.
- Verify: access control, duplicate requests, replay race and expired cursor behavior.
- Exit: reconnect changes observation only, not execution count.
- Rollback: disable new route admission; preserve inspect/cancel where safe.

### P18 — Job status and approval UX

- Depends on: P14, P17.
- Scope: proposed frontend run client/components and focused view tests.
- Deliver: honest states, artifact access, approval preview and recovery controls.
- Verify: waiting/uncertain/failed states, accessibility and two-subscriber replay.
- Exit: no green completion badge for unmet required criteria.
- Rollback: hide new entry point without deleting runs.

### P19 — Reviewed workflows and bounded planning

- Depends on: P09, P12, P14, P16–P18.
- Scope: workflow registry and one real bounded workflow at a time.
- Deliver: criteria-first steps with host-validated proposals and explicit limits.
- Verify: unsupported tool, ambiguous scope, stale observation and repair-loop cap.
- Exit: repeatable tasks do not require open-ended model planning.
- Rollback: disable the specific workflow version; do not change paused plans silently.

### P20 — Evidence-backed verification

- Depends on: P19.
- Scope: verifier registry, evidence storage and artifact checks.
- Deliver: deterministic checks plus clearly advisory content review.
- Verify: fake completion, missing artifact, stale hash and unmet criterion.
- Exit: completion is derived from evidence, not final-answer wording.
- Rollback: pause unsupported criterion types; never mark them passed by default.

### P21 — Model routing and escalation

- Depends on: P19–P20.
- Scope: routing/context packet adapters and model evaluation fixtures.
- Deliver: small executor role, capability gates, explicit escalation/budgets.
- Verify: invalid JSON, unsupported schema, exhausted budget and unavailable stronger model.
- Exit: cheap mode has honest limits and no hidden paid fallback.
- Rollback: restore previously evaluated route while retaining usage records.

### P22 — Task context and memory

- Depends on: P10, P19–P21.
- Scope: runtime context builder, existing memory interface, multilingual fixtures.
- Deliver: task-scoped checkpoints with provenance-aware retrieval.
- Verify: deleted memories, contradictory correction, Telugu tokenization and compaction.
- Exit: context loss cannot erase operation/approval facts.
- Rollback: use conservative context assembly; preserve original records.

### P23 — Skills and discovery

- Depends on: P19–P22.
- Scope: reviewed manifests, local registry and discovery tests.
- Deliver: narrow capability bundles with versioned contracts/verifiers.
- Verify: permission expansion, changed manifest hash and unavailable dependencies.
- Exit: skill selection reduces exposed tools without bypassing policy.
- Rollback: disable a skill version and pause dependent runs for review.

### P24 — Browser profiles and missing browser tools

- Depends on: P14–P15, P20, P23.
- Scope: browser adapter, profiles, tab/upload registration and fixture server tests.
- Deliver: explicit profile ownership, scoped tabs and verified action flow.
- Verify: login required, stale elements, ambiguous target, upload permission and receipt uncertainty.
- Exit: no accidental use of personal default cookies or uncontrolled shared active tab.
- Rollback: return to fixture/ephemeral mode; preserve user-owned profile data.

### P25 — Windows automation worker

- Depends on: P14–P15, P20, P23.
- Scope: UI Automation worker and missing structured action registration.
- Deliver: serialized thread-affine operations with window identity and pause control.
- Verify: owned test app, stale handles, slow inspection and wrong-window rejection.
- Exit: desktop control does not block unrelated API work or target arbitrary windows.
- Rollback: disable affected desktop capabilities, not global app processes.

### P26 — First external integration

- Depends on: P14, P20, P23.
- Scope: one selected adapter and mock/test account fixtures.
- Deliver: account-scoped reads/drafts, receipts and revocation behavior.
- Verify: wrong account, expired scope, remote failure, prompt injection and ambiguous commit.
- Exit: remote results follow the same policy and evidence contracts as local tools.
- Rollback: revoke/disable adapter; preserve unresolved external receipts.

### P27 — General scheduled jobs

- Depends on: P13–P14, P17, P19–P20.
- Scope: runtime scheduler/outbox; existing reminder semantics unchanged.
- Deliver: unique occurrences, timezone/misfire policy and notification deduplication.
- Verify: duplicate wakeup, sleep/wake, missed occurrence and notification-only retry.
- Exit: one occurrence causes one logical job under the recorded scope.
- Rollback: disable new occurrences; do not rerun completed ones.

### P28 — Voice job bridge

- Depends on: P08, P16–P20, P22.
- Scope: `api/realtime.py`, frontend voice client and isolated speech fixtures.
- Deliver: brief submitted-job feedback, progress separation and language preservation.
- Verify: stop-speaking versus cancel-job, half-duplex, Tenglish and ambiguous approval.
- Exit: long tasks do not depend on stretching speech deadlines.
- Rollback: retain legacy short-turn path and selected voice/language.

### P29 — Android/device ownership

- Depends on: P11, P13–P18, P28.
- Scope: canonical source and explicit persistent app-private runtime path.
- Deliver: capability matrix, lifecycle-safe checkpoints and device-owned run status.
- Verify: process death, unavailable desktop tools, reseed boundaries and no dual owner.
- Exit: Android limits are visible; no unsupported background-execution promise.
- Rollback: disable new Android execution while preserving readable checkpoints.

### P30 — Parallel child runs

- Depends on: P13–P15, P20–P23.
- Scope: parent/child runtime linkage, budgets and resource-aware scheduler.
- Deliver: bounded read-only delegation before any shared-write parallelism.
- Verify: budget aggregation, cancellation, resource collision and contradictory results.
- Exit: each child produces checked evidence under the parent's scope.
- Rollback: set concurrency to one; do not discard completed child artifacts.

### P31 — Telemetry and privacy controls

- Depends on: P09–P10; integrate incrementally with later packets.
- Scope: structured metrics, redacted logs, diagnostic exports and retention tests.
- Deliver: run-level traceability without credential/content leakage by default.
- Verify: dummy secret redaction, protected artifact access and retention boundaries.
- Exit: a failed job can be diagnosed from an authorized bundle.
- Rollback: disable verbose content logging; keep minimal operational receipts.

### P32 — Integrated evaluation harness

- Depends on: implemented capabilities under evaluation and P31.
- Scope: fixture corpus, fault injection, scoring and result reports.
- Deliver: stable held-out tasks and metrics with explicit denominators.
- Verify: known-bad fixture fails; skipped/unsupported tasks are not silently passed.
- Exit: changes can be compared without relying on anecdotes.
- Rollback: preserve old evaluation versions for comparable historical results.

### P33 — Release controls and recovery

- Depends on: P11, P14, P17–P20, P31–P32.
- Scope: feature flags, compatibility/rollback documentation and release checks.
- Deliver: staged rollout with no mutation shadow execution and safe rollback rules.
- Verify: disabled features, old-client compatibility and unsupported schema handling.
- Exit: rollout can be paused without erasing jobs or enabling unsafe legacy paths.
- Rollback: follow the documented flag/version boundary; reconcile in-flight effects.

### P34 — Installed-path verification

- Depends on: P07–P08, P18, P33; P28/P29 when those platforms are included.
- Scope: release artifacts and explicitly selected installation/device.
- Deliver: recorded source/build/install identity and actual launch-flow evidence.
- Verify: shortcut launch, handshake, fixture job, reconnect, cancellation and shutdown.
- Exit: user entry point works, not only the developer server.
- Rollback: retain known-good installer/artifact and data-version compatibility notes.

### P35 — Smaller-model qualification and final handoff

- Depends on: P21–P22, P32–P34.
- Scope: authorized model evaluations and owner-facing configuration documentation.
- Deliver: per-task-family route recommendation with quality/cost/latency evidence.
- Verify: identical corpus, explicit escalation count and no hidden expensive fallback.
- Exit: the selected smaller model meets the owner's declared thresholds, or its
  limits are documented and a safer default retained.
- Rollback: restore the last qualified model profile without losing job state.

<a id="release"></a>
## 30. Release, rollback and installation verification

### 30.1 Feature flags

Introduce explicit proposed flags for runtime admission, new domain writes,
sensitive external effects, managed background jobs, persistent browser profiles,
parallel runs and Android execution. Default unfinished or unverified paths off.
Flags are configuration, not model-adjustable tool arguments.

A flag disabling new jobs should not prevent inspecting/cancelling existing jobs.
A rollback that restores a known approval bypass is not an acceptable emergency
plan; disable sensitive capabilities instead.

### 30.2 Rollout ladder

1. All fixtures offline; no production runtime admission.
2. Read-only local artifact tasks with the owner supervising.
3. Low-risk personal-domain operations with authoritative ACKs.
4. Dedicated-browser fixture workflows.
5. Explicitly selected real-account drafts; no external commit by default.
6. Approved external effects with receipt/reconciliation checks.
7. Longer background/scheduled work under visible policy.
8. Qualified smaller-model default for supported task families.

Do not “shadow test” mutations by executing both old and new implementations.
Shadow planning and output comparison must be effect-free. Replaying captured
production tool calls needs sanitization and isolated adapters.

### 30.3 Build/install evidence

Record source commit, dependency lockfiles, build command, artifact path/hash,
installed path/device, configuration profile and validation time. Avoid including
credential values in this manifest.

Build desktop and Android sequentially because shared frontend outputs can race.
On Android, edit canonical sources and rebuild generated packages. On Windows,
verify the actual installed shortcut, working directory and backend discovery.

### 30.4 Rollback sequence

1. Stop admitting new affected jobs.
2. Classify running/uncertain effects; do not blindly kill all work.
3. Cancel or pause only the owned jobs that can be safely stopped.
4. Preserve receipts, artifacts and migration backups.
5. Roll back compatible source/build/configuration components.
6. If schema rollback is not supported, use a compatible reader or reviewed restore
   plan; do not run an old binary against an unknown newer schema.
7. Reconcile external effects that a database restore cannot undo.
8. Verify readiness and a read-only fixture before reopening admission.

### 30.5 Documentation gate

Update README behavior/configuration/limitations and a dated maintenance entry.
Update `docs/architecture.md` when an actual boundary, protocol, dependency or
ownership policy changes. Update `explanations.md` with changed paths, evidence and
remaining work. This manual should record completed packet evidence as implementation
lands, without changing proposed features into claimed shipped features prematurely.

<a id="troubleshooting"></a>
## 31. Troubleshooting decision trees

### 31.1 “The dashboard opens but the agent does not work”

```text
Does the expected backend answer the identity/readiness endpoint?
  No -> inspect launcher discovery, startup log, interpreter and port conflict.
  Yes -> does client instance_id match the backend instance_id?
           No -> repeat authenticated handshake.
           Yes -> did credentials and required data handshake receive ACKs?
                    No -> show exact failed prerequisite; retry only transient failures.
                    Yes -> is the selected capability ready?
                             No -> show missing dependency/account/platform requirement.
                             Yes -> inspect this run's provider/tool/verifier trace.
```

Do not reinstall the whole application before locating the failed boundary.

### 31.2 “It says completed, but nothing happened”

Inspect the run's required criteria and verification records. If completion has
no evidence, the completion gate is wrong. If a tool says success but the receipt
contains an error, outcome translation is wrong. If a personal-record operation
has no authoritative ACK, completion was premature. If an external receipt exists
but the UI is stale, fix the display/sync path without repeating the external action.

### 31.3 “The smaller model keeps looping”

Check whether it receives a narrow packet, fresh observations and a small relevant
tool set. Inspect repeated action/error fingerprints. If the same proposal repeats,
enforce the repair cap. If the schema is too complex, simplify the executor role.
If the task requires novel planning, escalate or use a reviewed workflow. Do not
solve looping solely by increasing rounds.

### 31.4 “A job disappeared after restart”

Check whether submission committed, whether the runtime used the intended persistent
path, whether migration/reseed touched that store and whether the UI is using the
correct session/device. A missing UI event may be a replay bug; a missing durable
row is a storage/admission bug. Keep those diagnoses separate.

### 31.5 “The same action happened twice”

Inspect client request IDs, operation IDs, attempt history, domain/external
idempotency support, owner generations and receipt timing. Determine whether the
duplicate was a new submission, a retried operation, a second worker or a scheduler
occurrence duplication. Pause unsafe retries before investigating with live accounts.

### 31.6 “C: is still filling up”

Inspect actual process environment and resolved cache/temp/browser paths. Check
child-process inheritance and tool-specific settings. An environment variable
printed by a parent does not prove every child honors it. Do not automatically
delete old data; identify ownership and use the explicit move/verification process.

### 31.7 “All tests pass, but real tasks fail”

Check for mocked happy paths only, skipped interactive tests, stale installed
binaries, provider version differences, missing negative cases and a held-out suite
that is too similar to development examples. Add a sanitized reproduction of the
specific failed boundary. Do not replace failed real-task evidence with a larger
count of unrelated passing unit tests.

<a id="completion"></a>
## 32. Definition of done, decisions and references

### 32.1 Minimum trustworthy milestone

The project reaches a useful first milestone when:

- The audited protocol/outcome/cancellation defects have passing regressions.
- The actual desktop entry point reaches acknowledged readiness or an actionable error.
- A read-only job survives UI disconnect and has a stable inspectable run ID.
- Completed artifacts are verified and accessible after restart.
- Sensitive operations cannot self-approve through model arguments.
- Unknown external outcomes are preserved and never blindly retried.
- Personal-record writes respect the configured authoritative owner.
- The user can see progress, cancel owned work and understand partial completion.

This milestone is valuable before browser integration breadth, multi-agent support
or a large skill catalog. Do not postpone reliability until every feature exists.

### 32.2 Full target, without exaggerated claims

The broader target includes qualified smaller-model workflows, bounded planning,
durable jobs, scoped tools, persistent browser sessions, integrations, schedules,
voice continuity, device-aware behavior and measured parallelism. Its quality is
demonstrated on the owner's tasks with transparent limits.

“Better than OpenClaw” is not a checkbox. It is a claim requiring comparable task
evidence. The more useful goal is: JARVIS reliably completes the user's important
Telugu/English personal and desktop workflows at an acceptable cost and risk.

### 32.3 Decisions requiring review before implementation

| Decision | Recommended starting point | When owner/reviewer input is required |
| --- | --- | --- |
| Runtime persistence root | Explicit protected D-drive path | Before creating/moving material persistent data |
| Runtime DB durability | Separate SQLite control plane; evaluate FULL sync for critical records | Before migration and real-effect acknowledgment |
| Background after UI close | Off until explicit host-lifecycle design | Before installing service/tray behavior |
| Sensitive standing grants | Narrow, expiring, destination-specific | Before recurring external effects |
| Small-model route | Measured workflow-specific qualification | Before changing default or enabling paid escalation |
| Browser session mode | Dedicated user-authorized profile | Before using real signed-in accounts |
| Remote/device execution | Device-local initially | Before network exposure or cross-device takeover |
| Artifact retention | User-controlled with minimal sensitive traces | Before cleanup/export behavior ships |

### 32.4 Initial progress record

```text
Document: agentic-integration-playbook.md
Status: design and integration instructions only
Implemented packets: none by creation of this document
Related existing evidence: agentic-audit-2026-09-14.md
Recommended first packet: P00
First user-visible repair batch: P02-P08 after their prerequisites
First durable runtime milestone: P09-P14 plus read-only API/UI slice
Do not skip: approval enforcement, authoritative ACKs, failure/recovery tests
```

### 32.5 Primary references

These references support selected technical boundaries; most architecture and
packet choices in this manual are recommendations for JARVIS, not copied promises
from another product. Check current installed versions before implementation.

- [Local agentic audit](agentic-audit-2026-09-14.md): reproduced defects and source anchors.
- [Project README](../README.md): current run/build behavior and maintenance rules.
- [Architecture notes](architecture.md): existing boundaries, with historical drift
  resolved against source and effective configuration.
- [Shared agent notes](../explanations.md): decisions, concurrent work and handoffs.
- [OpenClaw agent loop](https://docs.openclaw.ai/concepts/agent-loop): run/session coordination reference.
- [Python asyncio tasks](https://docs.python.org/3/library/asyncio-task.html): cancellation and task lifetime.
- [SQLite transactions](https://www.sqlite.org/transactional.html): transaction guarantees.
- [SQLite synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous): durability/performance policy details.
- [Pydantic strict validation](https://docs.pydantic.dev/latest/concepts/strict_mode/): typed contract enforcement.
- [Playwright browser contexts](https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch-persistent-context): persistent profile API constraints.
- [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices): integration authorization risks.
- [Android background tasks](https://developer.android.com/develop/background-work/background-tasks): platform lifecycle choices.

### 32.6 Final instruction to the implementing model

Build evidence, not appearances. Finish one bounded packet, verify its failure
paths, document what actually changed and leave a precise handoff. When the model
is less capable, reduce its task size and strengthen independent checks. Never
compensate for lower capability by weakening permissions, hiding uncertainty or
declaring unfinished work complete.
