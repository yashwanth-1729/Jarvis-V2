# Codex ↔ Claude Continuity Bridge

**Last updated:** 2026-09-15

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

### P12: read-only durable worker — implemented locally, awaiting this push

Current working-tree P12 changes are intentionally limited to:

- `backend/app/agent_runtime/repository.py`
- `backend/app/agent_runtime/worker.py`
- `backend/tests/agent_runtime_worker_test.py`
- `README.md`
- `docs/architecture.md`
- `explanations.md`

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

The preceding `git` push was blocked by a transient model-capacity reviewer;
this document is being added in the same P12 commit. Before beginning P13,
stage only the six P12 files above plus this handoff document, run `git diff
--cached --check`, commit `feat: add durable read-only agent worker`, and push.

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
  schema.sql       v2 control-plane schema
  migrations.py    exclusive, monotonic runtime migrations
  maintenance.py   quiesced backup / restore helpers
  repository.py    submissions, steps, atomic event/state transitions
  worker.py        P12 fixture-only read-only worker
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

It does **not** own personal tasks/schedules/memories/chat history and must not
be included in client-owned seed/drain/reseed flows.

### Known limitations — do not misrepresent as complete

- No runtime API/event replay endpoint yet (P17).
- No lease/owner generation/cancellation recovery yet (P13).
- No authenticated approval service or UI gate yet (P14).
- No real browser/shell/domain adapter plugged into the durable worker.
- No frontend run/status UI.
- No background worker scheduler, artifacts, evidence store, operations/attempts,
  scoped capability discovery, model routing or evaluation harness yet.
- No native desktop build or Android verification for this campaign.

## Exact next work: P13

Read `docs/agentic-integration-playbook.md` sections 10.3–10.5 and packet P13
before changing source.

Recommended next implementation:

1. Extend the runtime schema through a new reviewed migration (do not silently
   alter existing v2 tables) with lease ownership/generation data where needed.
2. Add repository admission/lease claim and renewal methods using expected owner
   generation predicates.
3. Add cancellation request handling. It must prevent new effects; it must not
   pretend unknown effects were cancelled or completed.
4. Add startup/recovery classification for safely queued/read-only work only.
   Unknown/external effects must become `UNCERTAIN`/waiting, never blindly rerun.
5. Add isolated fault-injection tests: competing owner, stale generation,
   expired lease, cancellation before action, cancellation after an uncertain
   action, and restart recovery.
6. Keep P12's adapter read-only while proving recovery. Do not connect
   `run_command`, browser, desktop control, tasks, schedules, or reminders yet.

## Useful verification commands

Run from `D:\Jarvis-2.0\backend` with bytecode disabled:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
& .\.venv\Scripts\python.exe -B tests\agent_runtime_contracts_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_database_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_repository_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_migration_test.py
& .\.venv\Scripts\python.exe -B tests\agent_runtime_worker_test.py
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
2. Push the pending P12 + this bridge commit.
3. Re-read P13 requirements and implement only ownership/recovery/cancellation.
4. Add/update README, architecture, `explanations.md`, and this bridge after
   every material packet.
5. Keep the user updated in concise commentary while working. Do not ask routine
   questions; continue with the recommended safe path.
