# Codex ↔ Claude Continuity Bridge

**Last updated:** 2026-09-15 (P15, by Codex)

This is a durable handoff for either Codex or Claude Code. Read it with
`AGENTS.md`, `explanations.md`, `README.md`, `docs/architecture.md`, and
`docs/agentic-integration-playbook.md` before changing the agent runtime.

## Goal

JARVIS is being upgraded from a request-bound chat/tool loop into a reliable,
local-first agent system with OpenClaw-class or stronger *engineering
properties*: durable state, clear ownership, bounded work, honest progress,
approval gates, recovery, event replay, and reproducible evidence. This is not a
claim of feature parity yet.

The user's requested execution order is strict:

1. Repair correctness and interruption failures already present in the chat/tool
   loop.
2. Build durable runtime contracts and storage separately from personal data.
3. Prove a read-only vertical slice before exposing autonomous writes, browser
   work, desktop commands, or background jobs.
4. Add ownership/recovery/cancellation, then approvals, then API/UI and later
   adapters incrementally.

The Telugu TTS Arena remains a separate project. Do not merge it into JARVIS
while working on this runtime.

## Collaboration rules

- Work directly on `main`; do not create branches.
- Before starting: `git pull origin main`, read `explanations.md`, then read this
  file for the current packet.
- Preserve unrelated untracked files. At this point they include
  `.artifact_staging/`, `JARVIS_OVERVIEW_FOR_GEMINI.md`,
  `android_tts_capture_final.log`, and `backend/backend_live.log`.
- Do not touch `backend/storage/jarvis_memory.db` or use real personal records in
  tests. Fixtures must use temporary paths.
- Use `apply_patch` for edits. Keep documentation current: README maintenance
  entry, architecture changes when boundaries/protocol/storage changes, and a
  concise `explanations.md` log entry. Commit and push completed packets.
- The user explicitly asked to continue packet-by-packet without routine
  questions. Ask only for real authority, credential, infrastructure, or policy
  decisions that cannot safely be inferred.
- All new installs/caches should use D:, never C:. No new installation was made
  during the work below.

## What happened in this implementation campaign

### P02–P08: correctness and readiness repairs — pushed

| Commit | Packet | Delivered and verified |
| --- | --- | --- |
| `8f490f8` | P02 | Gemini now issues backend-unique tool transcript IDs; prevents a later no-ID function call overwriting prior replay/thought-signature data. `gemini_provider_test.py`: 20 checks. |
| `ee3fe7f` | P03 | Tool receipts are saved before a `tool_result` SSE event. Closing the generator exactly at that event keeps the completed receipt. 5 checks. |
| `1940258` | P04 | Targeted UI/browser queries now return error outcomes for missing targets, malformed selectors and no match rather than success-shaped error strings. 2 checks plus syntax validation. |
| `7df2190` | P05 | Cancelling a shell command cleans up owned children. Windows uses a kill-on-close Job Object plus tree-kill fallback; cancellation re-raises only after cleanup. 3 checks plus `system_tools_test.py`: 109/109. |
| `1cf5e0d` | P06 | Reaching the tool-round cap triggers one final provider call with no tools. New tool calls are never executed or serialized as dangling calls. 5 checks. |
| `f2a1fa5` | P07 | Desktop backend readiness is `/api/health` with JARVIS `status: ok`, not bare TCP. Watchdog counts unready/crashing starts honestly. `rustfmt --check src/backend.rs` passed; no native build. |
| `947db8a` | P08 | Credentials/working-copy seed handshake marks completion only after endpoint acknowledgement; retry stays possible after backend startup failures. `npm run typecheck` passed. |

### P09–P11: durable control-plane foundation — pushed

| Commit | Packet | Delivered and verified |
| --- | --- | --- |
| `01af346` | P09 | `backend/app/agent_runtime/contracts.py`: strict versioned run requests, discriminated proposals, and host-issued receipts. Unknown fields/approval claims/version coercion rejected. 6 checks. |
| `c305531`, `cc0cdf9` | P10 | Separate local runtime SQLite file/schema plus `RuntimeRepository`. Personal data is excluded. Request hash + `(session_id, client_request_id)` enforce idempotency/conflict behavior. Run status/event changes commit atomically. 7 DB + 6 repository checks. |
| `da084e5` | P11 | Versioned exclusive migrations to schema v2, rollback-on-interruption, quiesced SQLite backup, SHA-256 manifest, integrity verification, staged restore and atomic replacement. 5 migration + 7 DB + 6 repository + 6 contract checks. |

### P12: read-only durable worker — pushed (`4760301`)

The `readonly-fixture-v1` worker is the first safe vertical slice:

```text
QUEUED run
  -> RUNNING
  -> one READY step
  -> step RUNNING
  -> deterministic read-only observation
  -> VERIFIED + COMPLETED
```

Missing/empty evidence creates FAILED step/run records. Re-running a terminal
run returns stored state and performs no action. Validation passed:

- `backend/tests/agent_runtime_worker_test.py`: 5/5
- `backend/tests/agent_runtime_repository_test.py`: 6/6

### P13: ownership, recovery and cancellation — implemented, this push

Picked up by Claude Code (2026-09-15): confirmed P12 was already pushed clean
(nothing pending), read playbook §10 and the P13 packet entry, then extended
the P12 files rather than adding new schema:

- `backend/app/agent_runtime/repository.py`: `claim_run` (atomic
  QUEUED->RUNNING admission, `owner_generation += 1` — exactly one concurrent
  admitter wins), `reclaim_stale_run` (the only legal takeover of a RUNNING
  run, gated on an actually-expired `lease_expires_at`), `renew_lease`,
  `request_cancel` (no lease needed — flips `status` only, which is the whole
  cancellation mechanism: the owning worker's next generation-fenced write
  just fails on its own). `transition_with_event`, `create_step` and
  `transition_step_with_event` gained an optional `expected_generation`
  (plus `require_run_status` on the step variant — see the bug note below).
- `backend/app/agent_runtime/worker.py`: `run()` claims before executing and
  returns current state (no forced status) on any lease/generation conflict;
  `recover_stale_runs`/`_resume` implement playbook 10.5's recovery matrix
  for this worker's one real case — a step with no committed result is safe
  to re-run (read-only + deterministic; this justification does **not**
  transfer to a future non-idempotent adapter), a step already VERIFIED
  before a crash only needs the run's own COMPLETED transition replayed.
- Real bug caught by a test, not by inspection: the step-write fence
  hardcoded `agent_runs.status = 'RUNNING'`, which also blocked
  cancellation's own finalizer (which must write while the run sits in
  CANCEL_REQUESTED) — a step could be left dangling in RUNNING forever after
  a mid-flight cancel. Fixed with a `require_run_status` parameter instead of
  a hardcoded literal. The test that caught it: a fixture adapter whose own
  `observe()` calls `request_cancel` on itself mid-call — a deterministic way
  to simulate the race without real concurrency.
- New `backend/tests/agent_runtime_lease_test.py`: 13/13 (competing
  admission, stale-generation write rejected not merged, active-vs-expired
  lease reclaim, restart recovery re-running exactly once, cancellation
  before any action with zero adapter calls, cancellation racing an
  in-flight action landing on CANCELLED with the step UNCERTAIN — never
  silently COMPLETED or dropped).
- All P10–P12 tests re-verified unchanged: contracts 6/6, database 7/7,
  repository 6/6, migration 5/5, worker 5/5 (same exact event sequence as
  before — the claim folds into the existing `run.running` event).
- **Deliberately not built:** an OS-level single-instance process lock
  (playbook 10.3's other requirement, alongside the DB generation fence).
  There is no real background worker process yet for a lock to guard —
  building one now would be untestable infrastructure. Add it when a
  scheduler/background process actually exists (likely alongside P15's
  process manager, or whenever the worker first runs unattended).

## Current architecture and safety boundaries

### Existing request-bound path

- `backend/app/llm/agent.py` is the current conversational loop. It remains the
  production chat path.
- The new runtime is not wired into chat, API, frontend, or scheduler yet.
- Do not run legacy `run_turn` and durable worker against the same request as an
  experiment; use fixture jobs only until API admission is implemented.

### New runtime modules

```text
backend/app/agent_runtime/
  contracts.py     P09 input/proposal/receipt boundaries
  database.py      separate FULL-sync SQLite owner
  schema.sql       v3 control-plane schema
  migrations.py    exclusive, monotonic runtime migrations
  maintenance.py   quiesced backup / restore helpers
  repository.py    submissions, steps, atomic event/state transitions,
                   P13: lease claim/reclaim/renew, cancellation
  worker.py        P12 fixture-only read-only worker,
                   P13: generation-fenced execution + startup recovery
  approvals.py     P14 local pairing, authorization and exact-effect approvals
  processes.py     P15 internal managed subprocess ownership and resource leases
```

`JARVIS_RUNTIME_DB_PATH` can select the runtime database. If it is empty,
production derives `backend/storage/jarvis_runtime.db`; a test overriding
`JARVIS_DB_PATH` derives a sibling temporary runtime DB automatically.

The runtime database currently owns:

- `runtime_sessions`
- `agent_runs`
- `agent_steps`
- `agent_events`
- `runtime_migration_history`
- `agent_approvals` (P14 exact human-decision records)
- `managed_processes` / `resource_leases` (P15 process facts and named locks)

It does **not** own personal tasks/schedules/memories/chat history and must not
be included in client-owned seed/drain/reseed flows.

### Known limitations — do not misrepresent as complete

- No runtime API/event replay endpoint or approval UI yet (P17).
- No real browser/shell/domain adapter plugged into the durable worker —
  lease/generation fencing and cancellation (P13) are proven only against the
  read-only fixture adapter; a non-idempotent adapter needs its own review of
  the recovery matrix before connecting (see 10.5's "external non-idempotent
  operation" row, which this fixture worker never has to satisfy).
- No OS-level single-instance process lock (playbook 10.3) — no real
  background worker process exists yet for one to guard; add it alongside
  whatever packet first runs the worker unattended.
- No frontend run/status UI.
- No background worker scheduler, artifacts, evidence store, operations/attempts,
  scoped capability discovery, model routing or evaluation harness yet.
- No native desktop build or Android verification for this campaign.

## P14: exact-effect approvals and local pairing — implemented, this push

- Schema v3 adds `agent_approvals` outside the client-owned personal-data
  store. Its states are PENDING, GRANTED, DENIED, EXPIRED, INVALIDATED and
  CONSUMED.
- `ApprovalRequest` hashes operation ID, tool/version, effect class, scope,
  target, content and preconditions. Only `EXTERNAL_COMMIT`, `DESTRUCTIVE`
  and `PRIVILEGE_CHANGE` require this gate; a changed request invalidates the
  old grant and dispatch atomically consumes a grant exactly once.
- `LocalAuthenticator` is an expiring in-memory pairing boundary. The service
  separately authorizes the authenticated principal against the runtime
  session. Unknown client fields such as `confirmed=true` cannot grant power.
- Temporary-fixture checks pass 43/43 across P09-P14. There is deliberately
  still no HTTP endpoint, frontend approval UI or write-capable adapter.

## P15: managed processes and resource leases — implemented, this push

P15 adds a schema-v4, internal-only process manager. It accepts explicit host
argv only, reserves a durable handle/resource lease before spawn, records the
PID plus psutil creation identity after spawn, captures bounded output and
releases its lease at durable terminal state. Cancellation refuses a mismatched
identity; Windows holds P05's kill-on-close Job Object for descendants. Fixture
tests cover output cap, resource conflict, stale identity and cancellation.
There is no model command path, HTTP endpoint, real installer, package install
or linkage to legacy `run_command`.

## Exact next work: P16

Read P16 and phase 8 before source changes. Implement an ownership-aware,
fixture-only domain command outbox and acknowledgment flow; do not write directly
to personal data from the runtime. Test duplicate delivery, crash-before-ACK,
revision conflict and reseed behavior. Keep all caches/tools on D:.


## Useful verification commands

Run from `D:\Jarvis-2.0\backend` with bytecode disabled:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
& .\.venv\Scripts\python.exe -B tests\agent_runtime_contracts_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_database_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_repository_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_migration_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_worker_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_lease_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_approval_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_process_test.py
```

Other already-validated targeted checks:

```powershell
& .\.venv\Scripts\python.exe -B tests\gemini_provider_test.py
& .\.venv\Scripts\python.exe -B tests\agent_receipt_order_test.py
& .\.venv\Scripts\python.exe -B tests\computer_query_outcome_test.py
& .\.venv\Scripts\python.exe -B tests\command_cancellation_test.py
& .\.venv\Scripts\python.exe -B tests\system_tools_test.py
& .\.venv\Scripts\python.exe -B tests\agent_tool_budget_finalization_test.py
```

Frontend check previously passed from `D:\Jarvis-2.0\frontend`:

```powershell
npm run typecheck
```

Do not claim an installed/native build or on-device verification from any of
these source-level checks.

## Handoff checklist

1. Inspect `git status --short`; preserve untracked logs/artifacts.
2. Push the pending P13 + this bridge commit.
3. Re-read P14 requirements (playbook §11) before implementing anything —
   it is a hard gate on autonomous writes, not a routine next packet.
4. Add/update README, architecture, `explanations.md`, and this bridge after
   every material packet.
5. Keep the user updated in concise commentary while working. Do not ask routine
   questions; continue with the recommended safe path. (This session's one
   exception: asking whether to continue P13 at all, since picking up another
   agent's safety-sensitive architecture without any confirmation was judged
   worth one question — not "routine" in the sense this rule means.)
