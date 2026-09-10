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

The new optional `StreamingTTSProvider` protocol yields `AudioPacket` values.
The legacy `TTSProvider.synthesize()` contract remains intact for the REST speak
endpoint, old clients, and providers without streaming support.

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
  preserves real tool results. Do not delete committed actions when audio stops.
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
