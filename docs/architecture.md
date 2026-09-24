# JARVIS 3 architecture and low-latency migration

Voice review: 2026-09-07. App architecture updated: 2026-09-10. Source of truth:
the files named in the root README.
Release 3.0.0 marks the systematic-memory boundary across the backend, web UI,
Windows shell and Android package.
Reference: user-supplied `low_latency_realtime_voice_agent_architecture.pdf`
(five pages). Its embedded build prompt is a proposal, not permission to replace
features, enable full-duplex by default, or change the user's data model.

## Assessment

The design fits JARVIS incrementally. FastAPI, React, a persistent WebSocket,
provider protocols, incremental LLM output and tool-driven events already exist.
Replacing the app with a separate framework would duplicate its working agent,
permissions, memories and platform bridges. The implemented change isolates
transport/scheduling work around those existing boundaries.

| Area | Before this change | Implemented / retained |
| --- | --- | --- |
| Client transport | Persistent WebSocket carrying base64 WAV segments | Retained; optional PCM output negotiation added |
| Recognition | REST recognition after a segment closes; receive loop blocked | Same model/transcripts; bounded input worker frees controls |
| Turn detector | 700 ms segment pause plus timers restarted on transcription | Timers now use elapsed silence and cancel on fresh speech |
| LLM | Incremental text for voice; non-incremental typed completion | Retained |
| TTS | Complete WAV per phrase | Incremental HTTP PCM for capable clients; WAV fallback |
| Delivery | Finished audio polled only on new agent text/final flush | Independent ordered sender |
| Backpressure | Up to eight phrase tasks; no played-audio credits | Two active synthesis jobs, eight packets/job, 20 unacknowledged packets |
| Playback | Async decodes could finish out of order or after stop | Serialized decode, cancellation generation, audio-clock scheduling |
| Half-duplex | Empty audio queue could appear to finish a reply | Requires producer completion plus drained playback |
| Cancellation | Server generation guard mostly on audio | Turn-scoped generation filtering and decoder/timer cleanup |
| Metrics | Server logs with incomplete latency boundary labels | Bounded per-stage summaries plus client playback measurement |
| Tools/data/panels | Shared agent and platform-dependent stores | No tool execution, schema, sync, or panel-layout rewrite |

Voice normally keeps incremental LLM delivery. If the provider connection fails
before emitting any text, reasoning or tool call, the provider discards that
connection and retries the turn through the non-streaming completion path used by
typed chat. A stream that has emitted anything is never replayed, because doing so
could duplicate speech or tool execution.

Recognition has its own deadline before the agent starts: two short HTTP
attempts inside 20 seconds, a provider-independent 22-second worker deadline,
and a 27-second client watchdog. A failed input emits an `error` event with
`input_failed: true`; the client interrupts the input worker and clears its
silence timer, pending playback and waiting state. Partial transcripts from a
failed utterance cannot become a command. A `progress` event with stage
`recognizing` identifies the pre-answer wait in the HUD. These limits are failure
ceilings, not additional delays on successful turns.

The recognition repair passed 15 isolated backend voice-pipeline tests and a
client recovery test. The Android APK was built, installed and launched. A speech
fixture passed through its real voice WebSocket to a transcript in 1.10 seconds;
the separate synthesis endpoint returned a WAV in 0.79 seconds. Physical microphone
capture, caption placement and speaker playback still require a user voice turn.

## Runtime and ownership boundaries

The browser UI and both Tauri shells share React components. Native builds export
static Next assets. Windows starts a repository Python process; Android runs the
same backend through embedded Chaquopy with a private writable DB path. Android's
backend code is staged from `backend/app` during its build; edit the source there,
not the generated Python copy under the Android tree.

The agent owns model context, persisted dialogue and tool execution. Speech owns
transport and audible output. A playback acknowledgment releases transport credit;
it is not an instruction to mutate a task or rewrite conversational memory.

Desktop data is SQLite-authoritative. Android data is IndexedDB-authoritative,
with serialized seed/drain around SQLite tools. Tasks, schedules, memories, ideas
and note pages replicate through pending rows and tombstones. The scheduler,
announcements and native Sentinel are separate paths.

## Responsive page layout

The `/mobile/` route is the phone app and the Android launch route. It lives in
`components/phone/` with a route-scoped stylesheet (`app/mobile/phone.css`, all
rules under `.ph`) and is a separate presentation, not a restyle of the desktop
components. Details, design and verification: `docs/mobile-app.md`.

- Data and lifecycle stay in `useCommandCenter`, shared with `/`: store
  ownership, startup retries, key handoff, agent seeding/draining, notification
  plans and mutations. The phone app mounts one controller and runs the one
  client sync engine (`useAutoSync`).
- Conversation, voice and settings logic are hooks shared by the desktop
  components and the phone screens: `useChatSession` (history, streaming,
  dictation, clear), `useVoiceSession` (the VoiceSession state machine, surface
  release timing, language/voice following; `reactiveLevel: false` exposes the
  microphone level through `levelRef` without a re-render per audio frame) and
  `useSettingsModel` (drafts, dirty tracking, Save & restart, SLDT pairing,
  location, erase). `Chat`, `VoiceMode` and `SettingsPanel` keep their desktop
  rendering and no longer carry a mobile presentation branch.
- Phone record sheets build drafts through `lib/recordDrafts.ts`, pure functions
  with the desktop editors' validation, then call the unchanged `records` API.
- Every phone layer (pushed screens, sheets, chat, voice) owns one same-URL
  history entry via `components/phone/lib/backStack.ts`, so Android's back button
  (Tauri's default `WebView.goBack()`) closes the top layer. UI closes rewind the
  entry; registration follows framer's `useIsPresent`.
- Finishing a task waits 4.2 s behind an Undo toast before calling
  `handleToggleTask(id, "COMPLETED")`; hiding the page commits it immediately.
- `SpeechQueue.outputLevel()` reads a passive `AnalyserNode` that each playback
  source feeds in addition to its unchanged destination connection;
  `VoiceSession.outputLevel()` exposes it for the phone's WebGL orb.
- Android `MainActivity` attaches `JarvisHapticsBridge` (`window.JarvisHaptics`),
  which maps UI feedback kinds to `performHapticFeedback`.
- New frontend dependencies, phone route only: framer-motion, vaul, sonner,
  @number-flow/react, @phosphor-icons/react, canvas-confetti.
- Tool surfaces remain disabled in voice mode here, as on the desktop route.

`tests/phone-fixture.mjs` is a loopback-only, in-memory API fixture for UI
checks, never a production data store. The route's self-hosted fonts (Unbounded,
Onest, Silkscreen) are included by the existing native static-export workflow.

Below 1,024 CSS pixels the shared UI uses the mobile bottom navigation and card
layout. `Dashboard` owns one vertical scroll container; its header and brief do
not shrink to accommodate long lists. Schedule section filters remain sticky,
and the weekly list selects one day on mobile while rendering all days on desktop.
Task metadata changes layout at the same breakpoint as the cards. The September 7
workspace redesign adds a deterministic focus presentation, client-side task
search and a wide-screen focus/list layout. The September 9 Notes workspace
renders one selected page at a time: long-term memory, temporary memory, Other,
or a custom permanent page. All pages are renameable; default pages cannot be
removed, while removing a custom page moves its entries to Other. All CRUD
operations still pass through the existing records API and platform ownership.

`RecordEditor` limits itself to the dynamic viewport height, with a scrolling
field area between the fixed header and actions. Field specs can declare
`visibleWhen` for kind-dependent schedule fields; hidden values remain in the
draft. Existing record mutation and deletion confirmation callbacks are retained.
The mobile typography rules are scoped to ordinary pages and dialogs, keeping
voice HUD sizing and tool surface protocols independent of the board redesign.
`uiMotion.ts` wraps deliberate navigation with optional native View Transitions;
unsupported browsers get CSS entrances. It skips superseded transitions and
respects reduced motion. `useListMotion` applies bounded Web Animations to existing
record displacements and cancels animations during cleanup or motion preference
changes. Record editors retain their closing visual briefly after logical close;
closing controls are hidden from accessibility and cannot receive pointer input.
These animations do not schedule agent calls, hold voice events, or alter sync.

## Record lifecycle and synchronization

Phone edits commit to IndexedDB immediately and enter a pending UID set. Manual
sync publishes that set and pulls the remote mirror; a visibility-close attempt
is best effort because Android may terminate the WebView before it completes.
Rows use last-write-wins comparison by `updated_at`. Deletes are records too:
each tombstone stores table, UID and deletion time and defeats any row at or
before that time. A newer deliberate edit clears the older tombstone and may
recreate the record.

The embedded Android SQLite database is only an agent working copy. Bridge work
is serialized. Before reseeding, the client drains tool changes; accepted agent
rows remain pending for remote publication, but must be strictly newer than the
IndexedDB row and its tombstone. This prevents a snapshot left from an earlier
app run from reviving a deletion or replacing a newer hand edit.

COLLEGE and ROUTINE schedule rows are weekly templates. BLOCK/SESSION rows have
concrete start and end date-times and sort by their next actual occurrence.
When a Block overlaps ROUTINE, the rendered routine interval is trimmed around
the Block; the recurring template remains intact for future weeks. A Block is
atomically deleted and tombstoned after its end. Temporary memories use the same
expiry rule. Their content row is removed; the content-free tombstone remains as
sync metadata so an offline copy cannot restore it. Existing chat transcript is
a separate store and is not scrubbed by memory expiry.

The Supabase mirror adds `memories.expires_at`, `ideas.page_uid` and the
`note_pages` table. Legacy PRIVATE memory categories migrate to LONG_TERM; the
current app exposes no public/private category control.

This mirror is specific to the paid app. The open-source variant under
`jarvis-oss/` replaces it with SLDT (`jarvis-oss/sldt/`): a signed, versioned
manifest plus per-object AES-256-GCM envelopes on a publicly addressable
object store (a GitHub repo in this stage) instead of Supabase, with
deterministic revision+deviceId conflict resolution in place of the
`updated_at` comparison above. As of this note the sync engine has IndexedDB
persistence (`jarvis-oss/sldt/src/browserStore.ts`), an `SldtClient` façade
(`jarvis-oss/sldt/src/client.ts`) composing identity/persistence/engine into
one call, and `frontend/src/lib/sldtRemote.ts` implementing this app's own
`Remote` interface (the same one `SupabaseRemote` implements above) against
it -- but no existing file imports that adapter, so it changes nothing
about what ships; proving it could even build required two additive
`next.config.mjs` changes (`experimental.externalDir`, a webpack extension
alias for the sldt package's `.js`-suffixed imports), neither of which
touches resolution of this app's own code.

The network path has now been run for real against api.github.com through
a locally-run instance of the proxy at `jarvis-oss/proxy/` -- push,
cross-device pull, delete, and tombstone propagation all confirmed against
a real repo, not just mocks. That live round trip found two real protocol
bugs (both fixed): a lost manifest-write race during first-ever publish
used to crash instead of retrying, and the retry loop had no backoff and
too small a budget to outlast GitHub's real read-after-write propagation
delay for a brand-new directory tree. It also surfaced something the
protocol genuinely cannot fix: a *stale read* that isn't detectably wrong
(as opposed to a lost *write* race, which is detectable) is invisible to
`sync()` -- catching up requires calling it again after a delay, same as
any deployment's periodic background pull already does. See
`jarvis-oss/sldt/README.md`'s "What the live round trip found" for the
full account. The proxy itself is still not deployed anywhere persistent
(it was run locally for that test and stopped). The proxy is now
understood to be needed only for a web build, though: it exists to keep a
write-capable GitHub PAT out of a browser page served to arbitrary
visitors, a problem desktop and Android don't have -- they're the app's
own binary on its own device holding its own credential, the same trust
level the paid app already gives the Supabase key on desktop
(`backend/.env`, no proxy). `jarvis-oss/sldt/src/githubClient.ts` now
offers `createDirectGitHubStore` for exactly that case: reads and writes
both go straight to GitHub with a caller-held token, no proxy, no server
to deploy. `SldtClient` needed no changes to support it -- it only ever
depends on the generic `Store` interface.

A user can now actually choose SLDT: `SettingsPanel.tsx`'s existing sync
section gained a backend toggle, and `syncClient.ts`'s `startAutoSync`
gained one optional field (`remote`) so a configured device substitutes an
`SldtRemote` for the default `SupabaseRemote` -- every existing caller
that omits it keeps the exact prior Supabase-only behavior. The one new
piece of state this introduces, `frontend/src/lib/sldtConfig.ts`, deliberately
splits where things live: non-secret settings (repo, path prefix, which
write mode, even the GitHub PAT for the direct path) go in `localStorage`,
the same place and trust level the Supabase URL/key already sit at on this
same device; the SLDT recovery code's secret half goes in `sessionStorage`
instead, specifically because the settings panel's own save flow
unconditionally reloads the page and a bare in-memory variable would be
wiped by that same reload, immediately undoing whatever the user just
entered. This was exercised in a real browser (not just compiled): a
generated identity, a saved (fake, deliberately) token, a real reload, and
a real failed network call surfacing through the same error-status UI a
bad Supabase key already uses. Neither this app's boundaries nor its
Supabase path are affected -- Supabase remains the default backend for
every device that hasn't opted into SLDT.

## Systematic memory boundary

The `memories` row remains the durable synced unit, but its content is now a
portable Markdown document. Fixed JSON scalars in YAML-compatible front matter
carry memory role, lifecycle state, confidence, importance, source, validity,
supersession, pinning, evidence, tags and a bounded correction history. Legacy
plain-text rows are valid input and migrate to the same representation without
changing their body. This format avoids coupling deployment to a new Supabase
column set and stays readable outside the application.

Memory roles have distinct behavior. WORKING context expires after eight hours
unless given an explicit deadline. EPISODIC records describe lived events;
low-level tool executions instead use the local 90-day `action_events` ledger.
SEMANTIC records hold stable facts and preferences. PROCEDURAL records hold
standing rules and receive a protected retrieval floor when important or pinned.
PROSPECTIVE memory holds goals without a concrete execution record; dated work
continues to use tasks, schedules and reminders. REFLECTIVE records hold patterns
consolidated from repeated evidence. CANDIDATE records never enter normal prompt
context until approved.

`services/memory.py` ranks locally using temporal filters, phrases, Unicode
tokens, tags, fuzzy concept similarity, role, confidence, importance, recency and
pinning. A maximal-marginal-relevance pass reduces duplicate results. The agent
passes the current user request into this retrieval step and injects at most
eight results, replacing the previous forty-row last-write ordering. Exact
record search remains available for tasks and ideas, and action-oriented queries
can retrieve named tool outcomes. Memory access frequency is kept in a local
side table so reading a memory does not dirty its synced row.

Hybrid learning is conservative. Explicit save requests write ACTIVE records.
High-signal unrequested self-statements become 30-day CANDIDATE records for the
Notes review view. Repetition raises evidence/confidence in place. Same-concept
corrections retain up to eight prior bodies inside the record rather than leaving
contradictory active rows. The Android IndexedDB v4 upgrade writes the same
Markdown envelope and marks migrated rows pending; the embedded SQLite copy
continues to seed and drain the unchanged sync columns. Desktop generates a
gitignored Markdown vault beside the database as a readable projection.

Semantic embeddings can later contribute another rank score. They are not on
the voice hot path: the configured Sarvam surface has no documented embedding
endpoint, and making Supabase pgvector mandatory would make offline recall depend
on network availability. Any embedding worker must therefore remain asynchronous
and optional, with this local retrieval path as the deterministic fallback.

Focused verification used only isolated fixtures. The systematic-memory suite
covered v5 plain-text migration, Markdown round trips, semantic ranking,
procedural pinning, candidate exclusion/review, correction history, named-action
recall, prompt selection and vault generation. It passed 15 checks; the existing
records and backend sync suites passed 46 and 39. Python compilation, TypeScript
and the production native web build passed. A separate frontend sync runner was
blocked before test loading by a host Node `uv_os_get_passwd` ENOMEM. The ARM64
APK was packaged, installed as an update with Android app data preserved and
launched; Android reported versionName `3.0.0` and versionCode `3000000`. This
confirms startup and package contents, while memory quality over real conversations
remains an on-device use check.

Desktop retains the in-process scheduler and announcement queue. Android now has
a separate native delivery boundary: the WebView projects weekly and one-off
schedules, precise task deadlines and backend reminder rows into a compact plan
stored in Android SharedPreferences. AlarmManager sends explicit PendingIntent
broadcasts to `JarvisAlarmReceiver`, so notification delivery does not depend on
the WebView, Python or app process remaining alive. Weekly alarms schedule their
next occurrence after firing; one-offs leave the plan. A restore receiver rebuilds
alarms after reboot, package replacement, clock changes and timezone changes.

Android 13+ notification permission is requested by `MainActivity`; the calendar
and reminder role declares exact-alarm access, with an inexact allow-while-idle
fallback if exact scheduling is unavailable. Recently missed one-offs may fire
after reboot; stale ones remain quiet. Native-fired reminder IDs contain no text
and are reconciled into SQLite on the next launch, preventing a second in-app
announcement. Remote edits become native alarms only after the phone pulls them.

Before projection, a persisted notification policy selects alarms by category and
stable record identity. The default enables deadline tasks only. COLLEGE, ROUTINE,
one-off Blocks and generic reminders have independent switches; a master switch
cancels every projected alarm. Named item allows and mutes override categories,
with mutes winning. Creating an explicit reminder adds only that reminder to the
allow set and re-enables delivery. The WebView caches the last valid policy for
backend-startup gaps. The same policy gates desktop announcement collection, so
voice commands have one meaning across platforms.

Reminder time resolution has a deterministic guard after model interpretation.
`set_reminder` receives both a concrete local ISO datetime and the original time
words. Explicit AM/PM repairs a contradictory model hour. Without a meridiem, a
same-day past hour is advanced by twelve hours only when that produces the next
future occurrence; otherwise the normal past-time refusal remains. This keeps
“5:15” at 16:39 from being misread as 05:15 without silently changing an
explicit “5:15 AM”.

## Typed turns and schedule mutation safety

Typed chat remains SSE over `POST /api/chat`, but both ends now bound silence. The
server wraps the complete multi-tool turn in a 240-second deadline and emits an
explicit terminal event after normal completion, provider failure or timeout. An
8-second heartbeat crosses slow model/tool gaps. The browser cancels a reader that
produces no data for 80 seconds, which now indicates a broken local stream rather
than normal model work. Prompts below 4,000 characters retain non-streaming prefix
caching; larger current user messages use progressive provider output and a
120-second per-request read allowance. If a persisted conversation ends with tool
results and no final assistant message, the next request inserts a neutral closure
before the new user turn; the model cannot resume an abandoned mutation batch as
though it belonged to the new request. Pasted context alone does not authorize
splitting its contents into durable notes.

`update_schedule_event` no longer treats a model-supplied SQLite row ID as enough
authority to mutate a schedule. The request must include a human-readable current
name or course code, and current weekday when weekday matters. An optional ID is
accepted only after it resolves to the same row. Ambiguous matches, identity
mismatches and cross-day moves without source-day evidence fail before mutation.
College block numbers are a domain mapping: Block 1 through 4 means 09:30–11:00,
11:10–12:50, 13:40–15:00 and 15:30–17:30. Parenthesized academic period numbers
do not enter clock parsing.

Android's `MainActivity` explicitly selects dark system-bar styling (light icons)
for the permanently dark canvas, independently of the OS theme. It retains
edge-to-edge insets and the embedded backend lifecycle.

## Voice session protocol

A new client connects to `WS /api/voice/session?audio=pcm16`. Omitting the query
selects legacy phrase-WAV output. `JARVIS_STREAMING_TTS=false` also selects WAV
synthesis without changing the client or provider key.

Client events retained: `segment`, `end_turn`, `utterance`, `text`, `interrupt`,
`language`, `voice`, `ping`. Input work goes through an ordered four-message
queue; control messages bypass recognition. Overflow rejects the utterance with
an error instead of silently dropping words. Cancellation closes its ASR request.

The HUD microphone toggle is client-side session control. Muting disables the
MediaStream audio track. If speech is currently buffered, the client encodes it
and sends one `utterance` event, whose server-side queue transcribes the audio
before ending the turn; this preserves ordering while bypassing the ordinary
silence delay. If a prior segment is already waiting, mute sends its queued
`end_turn`. Unmuting re-enables the same track and session.

Turn events carry `gen`: `turn`, `state`, `delta`, `caption`, `surface`, `tool`,
`refresh`, `audio`, `turn_end`, and turn errors where applicable. Session-wide
preferences/transcripts/handshake states may be unscoped. Old generations cannot
restart audio or reopen panels. Refresh notifications represent real mutations;
clients must not discard them merely because playback was interrupted.

For a tool execution, the backend persists the provider-shaped `tool` receipt
before it emits the matching `tool_result` SSE event. An SSE reader is allowed
to disconnect immediately after seeing an event, so publishing first would leave
an action that happened but no durable record that it happened. This receipt
ordering does not turn an announced-but-never-started call into a completed one;
durable run/step state remains the later agent-runtime upgrade.

Targeted computer queries use the same explicit outcome convention as computer
actions. A missing window/tab, malformed selector, or element search with no
match becomes an error `ToolOutcome`, rather than a successful-looking string
which encourages the model to continue from a target that does not exist.
Broad listings (`ui_list_windows`) remain successful informational results.

Desktop shell commands have an ownership boundary as well: cancellation first
closes a Windows kill-on-close job containing the shell and its descendants,
then uses the existing process-tree fallback and reaps pipe readers. POSIX keeps
its detached process-group kill. Cancellation is re-raised after cleanup, so a
request interruption cannot be mistaken for a completed command result.

The synchronous agent loop has a hard cap on action rounds. If every allowed
round asks for tools, it performs exactly one final provider pass with an empty
tool list and a finalization instruction; no requested action from that pass is
executed or serialized as a dangling call. This gives completed receipts a
user-facing conclusion while preserving the runaway-loop guard. Longer work
belongs to the later durable run/step runtime rather than increasing this cap.

The desktop backend watchdog treats readiness as `GET /api/health` returning
JARVIS's JSON `status: ok`, not merely a listening TCP port. A child process
which does not pass that endpoint within the bounded health window is stopped
and counted as a failed restart; the failure counter resets only after the
health window, not on `Command::spawn`. This prevents a stale listener or
crash-looping import from presenting a false-ready desktop app.

On client-owned-data runtimes, first contact is acknowledged only after the
credentials endpoint responds and the agent working-copy seed responds. A failed
or not-yet-started backend leaves this handshake retryable; it is not marked
complete merely because the browser began a request. The acknowledgement means
transport success, not that any specific optional provider key is configured.

The initial durable-runtime boundary lives in `app.agent_runtime.contracts` and
is intentionally separate from chat history and personal-record schemas. It
currently defines versioned, extra-field-forbidden run requests, discriminated
model proposals and host-issued receipts; it does not yet add a worker, API or
runtime database. This prevents model text from carrying writable approval,
verification or run-status claims before later storage/lease packets exist.

Durable control state uses a separate `jarvis_runtime.db`, never the personal
record database or client seed/drain mirror. Schema version 1 contains runtime
sessions, runs, steps and per-run ordered events with foreign keys and admission,
status and replay indexes. Connections use WAL with `synchronous=FULL`; opening a
newer unsupported schema fails without downgrade or deletion. Tests which replace
`JARVIS_DB_PATH` derive a sibling runtime fixture path unless an explicit
`JARVIS_RUNTIME_DB_PATH` is supplied.

`RuntimeRepository` canonicalizes and hashes each submitted request inside the
control plane. `(session_id, client_request_id)` is idempotent only when that
hash matches; changed content conflicts. Run transitions use an expected-state
predicate and insert the corresponding monotonically ordered event in the same
serialized `BEGIN IMMEDIATE` transaction. Events publish only after this layer
returns from commit; restart fixtures reopen the file and replay the same facts.

Runtime schema upgrades are independently versioned and execute under an
exclusive transaction; a failed migration rolls back both DDL and `user_version`.
Maintenance accepts only a disconnected (quiesced) runtime store. Backup uses
SQLite's backup API, records SHA-256/size/schema, and runs `integrity_check`.
Restore requires the expected manifest checksum, verifies a staged copy, then
atomically replaces the exact runtime file and removes only its stale WAL/SHM
sidecars. These helpers are not an automatic destructive startup behavior.

The first runtime executor is deliberately one-at-a-time and read-only. Its
`readonly-fixture-v1` workflow admits a QUEUED run, creates one READY tool step,
records RUNNING, executes a deterministic observation adapter, verifies a
non-empty result, then atomically reaches COMPLETED. Missing/empty observations
produce FAILED step and run events. Re-invoking a terminal run returns its stored
state without re-executing the adapter. No production tool is connected yet.

Admission (`RuntimeRepository.claim_run`) is what actually enforces single
ownership: it atomically moves a run QUEUED -> RUNNING while incrementing
`owner_generation`, so of any concurrent admission attempts exactly one
succeeds — the rest get `TransitionConflict` and must not retry with a forced
status. Every subsequent run/step write may pass that generation as
`expected_generation`; for steps this additionally requires the parent run to
still be in a specific status (`RUNNING` by default), which is also the entire
cancellation mechanism — `request_cancel` needs no lease of its own and flips
no in-memory flag, it just updates `status`, so the owning worker's own next
fenced write fails on its own the moment it tries to progress. A worker that
loses a write this way (`TransitionConflict`) never forces a different
outcome: `ReadOnlyWorker._reconcile_lost_write` re-reads the run and either
finds it CANCEL_REQUESTED (finalizes CANCELLED, marking any in-flight step
UNCERTAIN with whatever was actually observed rather than dropping or
verifying it) or finds a newer generation already owns it (does nothing
further). `reclaim_stale_run` is the only legal takeover of a RUNNING run,
and only once its `lease_expires_at` has passed — an active lease refuses
takeover for any worker id. `ReadOnlyWorker.recover_stale_runs` is the
startup reconciliation pass implementing the playbook's recovery matrix for
this specific fixture-only worker: a step with no committed result is safe to
re-run here because the adapter is read-only and deterministic (this
justification does not transfer to a future adapter with an external,
non-idempotent effect), while a step already VERIFIED before a crash only
needs the run's own COMPLETED transition replayed, never the adapter itself.
Thirteen fault-injection checks (`agent_runtime_lease_test.py`) cover
competing admission, stale-generation writes, expired-vs-active lease
reclaim, restart recovery, and both cancellation timings. Not built yet: an
OS-level single-instance process lock (playbook 10.3) — there is no real
background worker process for one to guard until a later packet adds a
scheduler, so it would be untestable today; the generation fence above is
what this packet actually proves.

Schema v3 adds `agent_approvals`, a separate durable record for a human decision
about one host-built effect. It deliberately distinguishes three questions:
`LocalAuthenticator` establishes a local caller's principal from an expiring,
memory-only pairing token; `ApprovalService` verifies that principal owns the
run's session; then it records a human grant or denial for the canonical effect.
The effect hash covers operation ID, tool and version, effect class, scope,
target, content hash and preconditions—not merely a tool name or model claim.
Only `EXTERNAL_COMMIT`, `DESTRUCTIVE`, and `PRIVILEGE_CHANGE` enter this hard
gate today. Dispatch atomically checks the principal, run, exact request hash,
grant and expiry, then marks the approval `CONSUMED`; replay is therefore
rejected. A changed request is marked `INVALIDATED` and must obtain a new
approval. No model field such as `confirmed=true` carries authority because the
strict decision contract permits only an authenticated human `grant` or `deny`.
This remains a control-plane boundary only: no HTTP endpoint or UI consumes it
yet, and no write-capable adapter is connected.

Schema v4 adds the internal managed-process boundary. Each host-issued handle
records its run, operation, owner generation, argv, working directory, bounded
output artifact paths, PID and OS creation identity. A PID alone is never enough
to signal a process: cancellation compares the live process identity and refuses
if it changed. Named resource leases serialize shared package-cache/GPU/profile
style resources before subprocess start. On Windows the service retains the
existing P05 kill-on-close Job Object handle so closing/cancelling a managed
process also ends its owned descendants; `taskkill` remains a fallback and the
direct asyncio child handle is used only after identity validation. This is an
internal fixture service, not an HTTP/model command path or installer adapter.

Schema v5 adds `domain_commands` as the only P16 bridge shape for future runtime
changes to personal data. The runtime records a stable operation ID, destination
owner, target UID/revision, command payload and optional approval reference, then
waits for an owner acknowledgement. Duplicate delivery of the same command is
idempotent; reuse of that operation ID for changed content is rejected. This does
not create a cross-store transaction and does not yet deliver to either backend
SQLite or client IndexedDB—the fixture proves the outbox/ACK semantics only.

P17 exposes a closed-by-default `/api/agent` control surface. Startup opens the
separate runtime DB and initializes a local authenticator, but pairing is disabled
unless `JARVIS_AGENT_PAIRING_SECRET` is intentionally provided. A bearer token
establishes the principal; session creation, run submission, inspection, event
replay and cancellation all verify ownership through `runtime_sessions`. Event
replay is cursor-based and observes committed rows only, so reconnecting cannot
repeat execution. P18 adds a small chat-side status strip with explicit queued,
working, approval/input-needed, completed, failed, cancelled and uncertain
presentations. The currently mounted strip reports the truthful unpaired state;
there is no endpoint/UI path that silently enables the runtime.

P19 introduces `WorkflowRegistry` with exactly one fixture-only reviewed
workflow. `fixture-inspect@v1` accepts only a bounded query, fixes its accepted
tool set to `fixture.observe`, emits host-owned acceptance criteria and allows
no repair loop. The registry refuses unknown workflow/version pairs and extra
fields. It is intentionally not wired to an API submission or model planner;
this establishes the reviewed-workflow boundary before any real task family.

P20 advances the isolated runtime schema to v6 with `evidence_records` and
`verification_records`. Evidence stores an observed timestamp and canonical
content hash; verification records name the criterion, verifier version, result
and the exact supporting evidence. `VerificationService` presently has one
deterministic non-empty-observation verifier. It rejects a model claim that lacks
an observation and records stale evidence rather than treating it as current.
Advisory/human/semantic adapters remain future distinct tiers.

P21 adds an offline capability router only. A candidate is addressed by
provider/model/role and must have sufficient context, supported structured output
when required, an enabled state and a held-out qualification result. Qualification
requires at least the configured completion rate and zero unauthorized actions or
false-success observations. No provider is implicitly substituted if the route is
unavailable; the caller receives an explicit unavailable outcome. Existing Gemini
and Sarvam selection remains authoritative for live chat.

P22 adds a pure task-context builder. Its packet contains explicit durable run,
step and evidence references before optional personal-memory snippets. Snippets
carry provenance and correction references, while deleted snippets are excluded
and duplicate stable IDs compact to one entry. The builder never accesses or
mutates the existing personal-memory store, so it cannot resurrect deleted facts
or substitute a prose summary for operation/approval records.

P23 adds a local `SkillRegistry` with reviewed immutable manifests. Each manifest
has an ID/version/purpose, workflow entry point, declared effect classes, platform
list, component requirements and deterministic content hash. Discovery exposes a
skill only when its required runtime components are ready. A changed hash is
rejected pending review. This is not a plugin marketplace or remote code loader.

P24/P25 add fixture-only automation identity boundaries. Browser observations are
bound to a non-default profile, tab and monotonically increasing generation;
actions must revalidate the exact observation/element and stale targets reject.
Existing-session attachment is deliberately unsupported. The desktop fixture worker
serializes work, requires exact process creation/window identity and honors pause;
it does not call UI Automation or control real windows.

P26 adds a mock account-scoped integration adapter to establish the receipt and
revocation boundary before any external connection. Each operation is idempotent
within one explicit account, rejects cross-account calls and treats remote text as
untrusted content rather than policy. Revocation blocks future calls. It has no
transport, credential or live-account implementation.

P27–P31 add isolated runtime contracts only. Runtime occurrence admission is
idempotent by schedule/occurrence key and remains separate from existing reminder
semantics. Voice acknowledgement preserves language without calling the realtime
pipeline. Device capabilities explicitly keep Android foreground-only and without
desktop control. Child admission is bounded to read-only budget units. Telemetry
retains a bounded redacted buffer, never raw secret-bearing diagnostic text. None
of these contracts starts background work or changes a production platform path.

P32 adds a held-out fixture evaluation harness. Reports include total, supported,
unsupported and expected-outcome matches, grouped by task family. A known-bad
fixture must fail as expected, while unsupported capabilities remain visible rather
than being counted as passes. It is not a live-provider, device or installed-path
benchmark.

P33 adds an explicit `RuntimeReleaseFlags` policy. All unfinished runtime
capabilities default disabled: admission, domain writes, sensitive effects,
background jobs, persistent browser profiles, parallel runs and Android execution.
Disabling admission does not remove read/inspect/cancel access to existing run
facts, which is required for a safe pause or rollback.

An audio message has `seq` (monotonically increasing within its generation),
`text`, and base64 `data`. PCM messages add `format: "pcm16"` and `sample_rate`.
PCM is mono signed little-endian 16-bit; each packet is sample-aligned and normally
100 ms. WAV fallback omits the PCM format fields. Caption text appears only on
the first packet of a phrase, not once per audio fragment.

After a source ends, the client sends `audio_played` with matching `gen` and `seq`.
The server validates membership in the outstanding set, preventing duplicate or
old acknowledgements from inflating credit. Twenty outstanding PCM packets cap
lookahead near two seconds. A disconnected or nonplaying client cannot build an
unbounded audio backlog; normal cancellation and the existing turn deadline end
stalled work. WAV fallback still has whole-phrase latency and buffering.

`turn_end` means generation/delivery is done, not that the speaker has finished.
The local queue owns the audible completion transition. Playback acknowledgments
and controls run while ASR is awaiting network I/O.

## Provider and speech policy

Chat model selection under the cloud stack (`JARVIS_VOICE_STACK=cloud`, all
through OpenRouter): English replies use `OPENROUTER_MODEL`
(`openai/gpt-4.1-nano`); any non-English reply language uses
`OPENROUTER_INDIC_MODEL` (`google/gemini-2.5-flash`), passed as a per-turn
`model=` override in `agent.run_turn`. Empty `OPENROUTER_INDIC_MODEL` puts every
language on `OPENROUTER_MODEL`. The reply register for Telugu and Hindi is
casual code-mixed Tenglish/Hinglish (English everyday words in Latin script,
native grammar in native script), defined by `reply_directive` and
`reply_reminder` in `app/core/languages.py`. Parts of the Piper/Sarvam
description below predate the cloud stack.

The new optional `StreamingTTSProvider` protocol yields `AudioPacket` values.
The legacy `TTSProvider.synthesize()` contract remains intact for the REST speak
endpoint, old clients, and providers without streaming support.

English speech is routed away from Sarvam to a local Piper voice by
`app.services.speech._provider_for`: English resolves to
`get_english_tts_provider()` (an `app.providers.piper.PiperTTS`), every other
language to `get_tts_provider()` (Sarvam) — except Telugu, which resolves to
`get_telugu_tts_provider()` (a second `PiperTTS` instance, parametrized with
the Telugu model/language/fallback hint) when the user has opted in via the
`telugu_tts_engine` preference (`app.db.crud.PREF_TELUGU_TTS_ENGINE`,
default `"sarvam"`); `_provider_for` re-reads that preference on every call,
so a toggle flipped mid-session takes effect on the very next utterance with
no reconnect. Piper is an ONNX model loaded once on a worker thread and warmed
at startup; it implements both the streaming `AudioPacket` protocol and the
legacy WAV `synthesize`. If Piper is not installed or its model is missing,
`_provider_for`'s callers fall back to Sarvam for that utterance — this is
also how an opted-in Telugu session degrades if the Telugu model file is
absent. This Python provider is desktop-only: under Chaquopy on Android arm64
neither onnxruntime nor Piper's phonemizer has a wheel. Both voices reach
Android through a separate route instead — a Kotlin/sherpa-onnx bridge
(`JarvisTts.kt`), not this backend, with its own voice registry keyed the same
way (`en_US-ryan-high`, `te_IN-padmavathi-medium`). There the same
`telugu_tts_engine` preference (checked in `app.api.realtime.VoiceSession`,
not `_provider_for`, since Android's realtime session routes around this
Python provider entirely) decides whether a Telugu turn becomes a
client-synthesized `_ClientPhrase` (`app/api/realtime.py`) or ordinary Sarvam
audio, the same way `client_english_tts` already gated English's. Telugu's Android bridge was added
2026-09-13 and is code-complete but unverified on a device (no Android SDK on
the machine that wrote it); treat it as unproven until built and run once.

`SarvamTTS.stream_speech` uses the existing pooled httpx client with
`POST /text-to-speech/stream`, `output_audio_codec=linear16`, and a sample rate no
higher than 24 kHz. It retains the selected voice, language, pace multiplier and
model-specific expressiveness. `speech.stream` applies the same non-English
number preparation as `speech.speak`.

The reference also proposes persistent provider WebSockets. This implementation
uses streaming HTTP responses over a reused client as an Android-compatible
first step without adding native wheels or an SDK. It is not a persistent TTS
WebSocket and does not remove all per-phrase provider overhead.

Streaming errors before the first emitted packet can fall back to REST WAV.
Authentication/credit errors do not trigger redundant fallback calls. After a
packet has escaped, failure is surfaced without retrying the whole phrase.
Packets are not individually silence-trimmed, which would erase valid pauses
inside speech. Existing conservative trimming still applies to complete WAVs.

Chat has a separate failover for the per-request model override (voice mode's
`sarvam-105b-conversations`). The override gets a 12s timeout and one attempt;
if it produces nothing, `SarvamChat` retries the turn on the configured chat
model and bypasses the override for 180s, so an upstream outage costs one slow
turn rather than a hang on every turn. The configured model keeps the normal
timeout and three-attempt retry, and its failure is surfaced as an error
rather than looped. Per-turn `reasoning_effort` is carried through the failover.

BYOK: `POST /api/local/credentials` (`app/api/localstore.py`) is the one path
a client-owned-data runtime (desktop or Android) uses to hand the backend its
own provider keys instead of relying on `backend/.env`, which a packaged app
never ships with real secrets in. Sarvam's key had this path first; Gemini's
key now travels identically, both mutating the same mutable `Settings`
singleton (`app.core.config.settings`) and both torn down the same way
afterward -- `close_providers()` already iterated every provider getter
(including `get_english_chat_provider`, which resolves to Gemini's
`EnglishChatProvider` when `JARVIS_ENGLISH_LLM=gemini`), so extending BYOK to
Gemini needed no change to teardown, only to the endpoint accepting the key
and the client sending it. Both keys share one carve-out: a blank value from
a first-contact handshake means "nothing to hand over" rather than "erase the
working key" whenever a real key is already active and the runtime isn't
Android (whose sandboxed `.env` never holds a real key to protect) -- this
exact bug shipped once for Sarvam (a fresh desktop launch flipped
`api_key_configured` from true to false within seconds of the frontend's own
first-contact call) before the carve-out existed, and it would have recurred
identically for Gemini without generalizing the same rule to both keys
rather than treating it as Sarvam-specific.

Gemini tool-call replay uses a backend-issued `gemini_call_N` identity for every
observed function call. Gemini's response-local position and optional upstream
call ID are not transcript identities: reusing `call_0` on a later tool round
would overwrite an earlier `thoughtSignature` and replay that earlier call under
the later function name. The backend keeps its own unique ID with each call's
name, arguments and signature; that ID is local to the provider instance, not an
external action idempotency key.

## Remaining parts of the reference

- **Continuous capture and partial ASR:** Still absent. ScriptProcessor captures
  blocks locally and sends completed WAV segments; this is not 10-20 ms transport
  streaming. Sarvam now documents `saaras:v3-realtime` and `saaras:v4-realtime` on
  its realtime recognition endpoint. These are distinct API/model contracts from
  the configured REST `saaras:v4`. Add a capability-gated adapter with final-text
  commitment, stable/unstable transcript handling, proper resampling, and fallback
  before making it the default. Compare Telugu/English/code-mixed recognition
  on actual user speech, especially names, dates, counts and negations.
- **Faster semantic endpointing:** The existing complete/open language heuristic
  remains. The timer arithmetic is corrected, but the thresholds were not reduced
  to 250-500 ms without speech traces. Indic text still relies strongly on ASR
  punctuation. AudioWorklet capture is a future compatibility-tested improvement.
- **Heard-only history:** Playback acks currently control buffering, not DB history.
  Persisted tool cycles and assistant messages retain existing semantics. Safely
  truncating interrupted dialogue needs an explicit receipt/history policy that
  preserves real tool results. Completed tool receipts are now committed before
  their client event, but explicit unstarted/uncertain step state is still a
  future durable-runtime requirement. Do not delete committed actions when audio
  stops.
- **Full-duplex default:** Intentionally not adopted. The user's mic-muting choice
  remains the default. Optional barge-in is retained, with the existing echo/VAD
  limitations; no new echo cancellation model was added.
- **WebRTC:** Not introduced. Current clients speak to their local embedded/server
  backend; adopting a media server/NAT stack needs evidence of transport benefit
  and Android packaging support. WebSocket is an allowed reference alternative.
- **Model routing/history summarization/tool parallelism:** Not changed. These
  can change answer quality, memory and destructive action ordering. The existing
  bounded history and shared tool loop stay intact.
- **Latency dashboard/distributed tracing:** A read-only metrics endpoint exists;
  no new user-facing dashboard or OpenTelemetry/Redis service was introduced.
  Samples reset on process restart and are not global production percentiles.

## Measurements and verification

Offline regressions cover independent audio delivery during stalled agent output,
phrase ordering, bounded buffering, cancellation cleanup, stale generation checks,
flow-control blocking, fragmented PCM samples, safe fallback, slow ASR cancellation,
rejection of partially failed commands, and bounded metric summaries. Frontend
checks cover pending decode cancellation, PCM timing, caption reveal, microphone
hold, playback credits and stop cleanup; existing endpoint heuristic tests remain.

One direct provider request for a short English phrase produced 17 PCM packets at
24 kHz: first packet approximately 1,505 ms, final packet approximately 1,651 ms.
It used the selected `priya` voice and did not invoke the agent, write any records,
or measure recognition/model/end-to-end latency. This is not proof of a speedup
against the previous implementation, and not evidence that 300-800 ms is achieved.

`/api/voice/metrics` labels timing boundaries explicitly. Server commit-to-text and
commit-to-audio exclude recognition. Client speech-end-to-playback includes its
silence timer, recognition, agent/tool work, TTS, transport and playback scheduling.
Typed fallback turns do not submit a speech-end metric. The browser playback
start uses a timer aligned to the AudioContext schedule, not a physical microphone
measurement of the speaker output.

The September 7 ARM64 APK was built and installed as an update on the phone;
startup and the redesigned task board were observed. The subsequent Android-only
status-bar correction compiled and was reinstalled; its on-device visual check
remains pending. Packaged browser fixtures
also checked six widths (320 through 1,280 px), loaded fonts, editor actions at
320 × 500 px, and schedule field visibility without mutating user records.

For the September 9 lifecycle change, isolated backend lifecycle, scheduler,
records and sync suites passed 9, 36, 46 and 39 checks. Frontend schedule policy
and sync suites passed 4 and 39 checks, including stale deletion resurrection
and stale agent-working-copy rejection. TypeScript and the native production web
build passed. The 281 MB arm64 debug APK was installed over the existing app with
data preserved and launched; its startup sample showed schema-v5 seeding and no
Android application crash. Visual behavior remains an on-device user check.

The reminder clock regression adds five deterministic checks, including the
reported 16:39 + bare 5:15 case and explicit AM/PM contradictions. They passed;
the Android package was rebuilt, installed with existing data preserved, and
launched. A real timed reminder remains the device-level acceptance check.

The September 9 conversation investigation used the phone's persisted JARVIS log
and a read-only database snapshot. It identified Sarvam DNS retries followed by a
402 response, guessed schedule IDs and academic period labels interpreted as early
clock times. Eight isolated schedule-mutation regressions and the frontend
TypeScript check passed. The ARM64 APK was rebuilt and installed over the existing
app. The timetable was repaired in the phone's authoritative IndexedDB; after a
force-stop and restart, an on-device validator again found 19 college rows, zero
03:00/05:00/08:00 rows and zero duplicate day/course entries.

The later large-prompt trace contained a 12,529-character user message. It made
three successful `save_idea_or_note` cycles before the final silent provider call
timed out, demonstrating that the UI wait was not a payload rejection. Seven
isolated notification-policy checks, all 36 scheduler checks, Python compilation
and the frontend TypeScript check passed. The first Android wrapper invocation hit
the known Windows symlink fallback and an incorrect Gradle-home environment; the
JDK-21 Gradle packaging run then succeeded. The APK was installed over the existing
app and launched. A live on-device policy read returned enabled deadline tasks with
COLLEGE, ROUTINE, Blocks and generic reminders disabled. A new real large provider
turn remains the user's acceptance check because it consumes provider credits.

On-device listening is a separate acceptance step. Check English and
Telugu voice turns, a slow search, weather, language/voice changes, pause/resume
mid-request, mic behavior between sentences, and optional interruption. Rebuild
both frontend assets and the Android backend before measuring phone results.

## Sources

- User-provided five-page low-latency architecture PDF, reviewed in this task.
- [Android system-bar styling](https://developer.android.com/reference/androidx/activity/SystemBarStyle)
- [Sarvam HTTP streaming TTS guide](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/http-stream)
- [Sarvam streaming TTS API](https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream)
- [Sarvam realtime recognition API](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws)

Provider references checked 2026-09-07. Recheck their schemas before extending the
adapters; comments about past provider performance are historical measurements.
