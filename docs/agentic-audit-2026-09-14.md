# JARVIS agentic reliability audit — 2026-09-14

## Conclusion and scope

JARVIS has real desktop tools, not just placeholder UI. The checked desktop
configuration exposes 56 tools, including shell, filesystem, browser and Windows
UI Automation. However, its request-bound conversation loop is not yet a durable
job runtime. There are also concrete protocol, interruption and reporting bugs
that can undermine even short multi-step tasks.

This was a diagnostic audit, not a feature implementation. No application code,
installed binaries, credentials, user records or TTS installations were changed.
No paid model calls or real browser/desktop actions were performed. The exact
cause of a particular historical failed user request cannot be established without
that request's execution trace; the findings below distinguish reproduced defects
from architectural limits and plausible consequences.

Paths and line numbers refer to the checkout audited on this date.

## Reproduced agent defects

### 1. Gemini tool-call identity is not unique across rounds

`backend/app/providers/gemini.py:293` resets `call_index` for every HTTP response.
At line 334, a function call without an upstream ID becomes `call_0`, `call_1`,
etc. The signature cache uses those IDs as keys. History translation at line 210
uses the cached function name and signature, but the historical call's arguments.

Two isolated HTTP fixtures produced this result:

```text
first call:  web_search(query="fixture"), id=call_0, signature=sig-one
second call: fetch_url(url="https://example.invalid"), id=call_0, signature=sig-two
first call replayed as: fetch_url(query="fixture"), signature=sig-two
```

This corrupts the model's record of what happened. Actual upstream rejection or
confused continuation is a plausible consequence, not a live-provider result from
this audit. It specifically affects the Gemini path under the missing-ID condition,
not every provider. Use unique internal IDs and preserve each call's provider
metadata without overwriting it. Add multi-round replay coverage.

### 2. A completed action can lose its conversation receipt on interruption

`backend/app/llm/agent.py:791` persists an assistant's complete batch of tool calls.
It then executes a tool and yields its result at line 834. The tool-result history
entry is not persisted until line 852, after the consumer resumes the generator.
Closing at that yield can leave a completed action without its replay receipt.

An in-memory audit fixture executed one action from a two-call batch, then closed
the generator after its first result. History contained two calls and zero result
receipts. The action ledger is separate and does not reconcile this conversation
history. `_close_interrupted_tool_cycles` adds closure text after tool messages;
it does not reconcile missing results for declared calls.

Persist completion receipts before announcing them. Track each declared call as
completed, not started or uncertain. An interrupted non-idempotent action must not
be automatically repeated merely because its result is missing.

### 3. Browser query failures are marked successful

`backend/app/llm/tools_browser.py:443` returns ordinary error text when a tab is
missing or a query fails. `_computer_query` in `tools.py:2455` wraps any string in
a default-success `ToolOutcome`. The event and action ledger therefore record
success even for errors.

An offline call against a nonexistent fixture tab returned:

```text
No open tab 'nonexistent-fixture-tab'. Open tabs: (none).
is_error=False
```

Use typed query outcomes, distinguishing operational failure from a valid search
with zero matches. Test the UI status and action ledger as well as returned text.

### 4. Parent cancellation skips command-process cleanup

`backend/app/llm/tools_system.py:261` handles the command's own timeout, but not
`asyncio.CancelledError` from a cancelled chat/voice turn. An isolated fake-process
probe confirmed parent cancellation propagates with zero calls to `_kill_tree`.

This establishes the missing cleanup path; no real orphan was created during the
audit. A real child may continue untracked after the request ends. Add cancellation
cleanup and explicit managed background-process ownership; do not solve this with
machine-wide process killing.

### 5. Final tool-round results cannot be assessed

The configured limit is eight rounds (`agent.py:724`). The eighth round's tools
execute, but the loop then emits exhaustion (`agent.py:854`) without another model
call to inspect those results or compose a final answer. An offline fixture
executed eight actions and ended with an error followed by
`done(stop_reason="tool_calls", text="")`.

Keep bounded execution, but separate the action budget from a tool-free
finalization pass. Return explicit completed, exhausted, failed or awaiting-input
states; raising the limit alone is not a sufficient fix.

## Safety requirement before greater autonomy

`tools.py:1944` trusts the model-supplied `confirmed` boolean for a classified
dangerous command. No server-owned approval record is required. A mock-only probe
passed `confirmed=True` on its first invocation and reached the mocked executor.
No command was actually executed. Similar confirmation parameters exist on other
sensitive tools. Browser click/hotkey and general shell capabilities also need
effect-aware policy, not only a dedicated submit-tool guard.

Replace model-owned confirmation with a server-issued, expiring approval tied to
the exact action, arguments, run and user decision. Consume approvals once, reject
changed arguments, scope filesystem/process permissions, and keep untrusted web
or document content from granting authority. Existing warnings are useful but are
not a security boundary. Do not remove safeguards to make the agent appear more
capable.

## Desktop readiness defects

- **Handshake marked complete too early:** `frontend/src/app/page.tsx:180` sets
  `seededRef=true` before credentials and data seeding succeed. Bridge failures
  return null/false (`agentBridge.ts:53`), but the caller ignores those results.
  The flag is not reset on reconnect. A restarted backend can lose in-memory BYOK
  credentials without the existing window resending them. Backend `.env` keys may
  mask this condition. Require an acknowledged handshake for each backend instance.
- **Process existence is not readiness:** `frontend/src-tauri/src/backend.rs:105`
  accepts any TCP listener on port 8000. The watchdog also accepts a living child
  without an API readiness probe. A hung server or unrelated listener is not a
  healthy JARVIS runtime.
- **Crash-loop counter resets on spawn:** `backend.rs:283` resets the failure
  counter as soon as Python spawns, even if it immediately exits. This contradicts
  the intended five-failure policy described in the earlier shared notes. Reset
  only after sustained verified health.
- **Startup exceptions are hard to recover:** Python stdout/stderr are discarded
  (`backend.rs:195`), while backend logging uses the console (`backend/main.py:37`)
  and the Tauri log plugin is debug-only (`lib.rs:29`). Capture bounded, redacted
  startup diagnostics on D: and show an actionable readiness error.

The local health endpoint refused connections at audit time and no matching
desktop/backend processes were found. This is only a current snapshot, not proof
of why the earlier desktop attempt failed. Python automation modules and Chromium
exist; their interactive readiness was not exercised. The browser runtime still
resolves under C:, and nothing was moved or installed during this diagnosis.

## Architectural ceilings, separate from bugs

| Current behavior | Why it limits sustained agent work |
| --- | --- |
| Chat owns the execution generator; 240-second typed deadline (`api/chat.py:77`), disconnect abandons it | No independent job to reconnect to, inspect or resume |
| Voice wraps model/tools and speech completion in 75 seconds (`api/realtime.py:133`, `:742`) | A longer task needs a background run, not a longer period of spoken silence |
| Global chat history, no session ID in `ChatRequest`; last 40 rows loaded (`db/schema.sql:159`, `agent.py:306`) | Tool rows consume the window; separate tasks can mix history; no durable task-specific checkpoint or per-session execution queue |
| Ordinary final text ends the loop (`agent.py:803`) | No runtime requirement to demonstrate that the requested outcome was verified |
| All 56 enabled schemas offered together (`agent.py:704`) | No task-scoped discovery/budgeting; impact on quality/latency needs measurement, not assumption |
| Reasoning routing is English-pattern matching to `low` or provider default (`agent.py:457`) | Not a tested complexity-aware execution policy; more capable model selection still needs task evaluations |
| Scheduler fires reminder/schedule/task announcements (`services/scheduler.py`) | This is not scheduled arbitrary agent work with retries and durable run state |
| Browser launches isolated Chromium (`tools_browser.py:94`) | Cannot use existing signed-in user tabs; browser restart loses that session |
| Some UI/browser handlers lack tool registrations | UI scrolling/expand-collapse/window actions, browser tab operations and uploads cannot be requested through their intended structured tools |
| Synchronous Windows operations inside async handlers | Slow inspection/typing can block the event loop; this risk was not timed here |

Durable memories and an action log already exist. They should be retained, not
misrepresented as absent. They do not substitute for job checkpoints, process
ownership, session serialization, verified completion, or user-bound approvals.

## What to borrow from OpenClaw

OpenClaw documents separate run IDs, per-session queues, lifecycle events, context
assembly and model/tool execution in its [agent loop](https://docs.openclaw.ai/concepts/agent-loop).
It also documents [sub-agents](https://docs.openclaw.ai/tools/subagents) and
[scheduled agent work](https://docs.openclaw.ai/automation/cron-jobs).
Its [browser tooling](https://docs.openclaw.ai/browser) describes managed and
existing-session workflows with inspectable page state.

These are useful engineering patterns, not evidence that OpenClaw always succeeds
or that arbitrary side effects can safely be replayed after crashes. No head-to-head
performance comparison was run. Replacing the system prompt or adding a more
expensive model cannot repair JARVIS's tool identity and lifecycle defects.

## Recommended implementation order and acceptance gates

1. **Make current execution trustworthy.** Fix call identity, receipt ordering,
   typed failures, cancellation cleanup, finalization, readiness and reconnect.
   Require offline multi-round/interruption tests and isolated desktop smoke tests.
2. **Enforce authority outside the model.** Bound actions to runs and explicit
   user approvals. Test altered arguments, replayed approvals and injected web text
   without touching real user files, purchases or messages.
3. **Introduce a durable job runtime.** Store runs, steps, events, artifacts,
   approvals, checkpoints and process handles. Serialize each session; support
   reconnect, cancel, inspect and deliberate resume. Voice/chat submit work to the
   same runtime. Preserve desktop/Android data ownership and half-duplex defaults.
4. **Close the action/verification loop.** Plan, observe, act, verify, repair,
   checkpoint. Use adapters with explicit postconditions and bounded recovery.
   Add persistent browser profiles or user-authorized existing-session attachment;
   register and test the missing structured capabilities.
5. **Add controlled expansion.** Task-scoped skills/tool discovery, approved
   integrations, bounded parallel specialists, scheduled jobs and resource/cost
   budgets. Android needs its own capability design; desktop shell access is not
   an Android automation solution.
6. **Measure the actual goal.** Use the same isolated tasks and hardware for JARVIS
   and any baseline: browser research with sources, draft-document creation,
   multi-app workflows, interrupted-run recovery, scheduled follow-up, permission
   rejection and Telugu/English code-switching. Score verified task completion,
   false-success rate, recovery, unauthorized actions, latency and cost. Do not
   declare "better than OpenClaw" from tool count or a few demonstrations.

JARVIS's potential differentiator is reliable Telugu/English voice, personal
context and transparent cross-device work—not unlimited unattended access.

## Validation record

- Existing `tests/reasoning_routing_test.py`: 20 checks passed.
- Existing `tests/gemini_provider_test.py`: 18 checks passed, entirely offline.
- Main audit probes: reproduced Gemini ID collision/replay corruption, false-success
  browser query, missing parent-cancellation cleanup, and model-controlled approval
  bypass using mocked execution only. A second main-agent check of the actual
  `run_turn` function with mocked dependencies confirmed one executed action, two
  persisted calls and zero persisted receipts after closing at the result yield.
- Parallel read-only audit: reproduced interrupted receipt loss and the eighth-round
  finalization gap with in-memory fixtures; reviewed desktop startup/handshake paths.
- No package installs, native builds, real UI interactions, database mutations or
  live LLM benchmarks. Existing passing tests do not cover the newly found defects.
- Remaining: implementation and corresponding regression tests, installed-build
  verification, and a user-approved end-to-end capability benchmark.
