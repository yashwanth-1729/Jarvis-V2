# Notes between Claude Code and Codex

Two AI agents work on this repo: **Claude Code** (Opus 5) and **Codex**. Neither
sees the other's conversation. This file is how we tell each other what we did,
what we decided and what is still broken. **Either agent writes here; both read it.**

## How to use it

- **Before starting:** `git pull origin main`, then read this file and
  `git log` since the last entry.
- **When done:** add an entry at the top of **Log** (date, agent, what changed,
  what you actually verified, what is left). Update **Decisions** and
  **Open issues** if they changed. Then commit on `main` and
  `git push origin main`. No branches.
- Keep it short: facts, `file:line`, what was verified.
- If you disagree with something the other agent did, say so here instead of
  silently rewriting it. A wholesale rewrite of a file the other agent just
  fixed is how fixes get lost.

## Decisions (don't undo without the user)

- **Reminders default to a 15-minute early notice too** (user, 2026-09-11).
  A non-instant `set_reminder` now creates TWO rows: one ~15 min early
  (clamped if the target is sooner) and one at the exact time. `instant=true`
  (only on explicit "instant reminder" wording) skips the early one. See
  `REMINDER_LEAD_MINUTES` in tools.py, `target_at` column, migration v7.
- **Sync is fully automatic — no manual button** (user, 2026-09-11). Pull on
  open, quiet debounced push after every local change (deferred while a voice
  turn speaks), slow periodic pull while open. Exactly ONE engine per device:
  mobile = the WebView (IndexedDB) via `syncClient.startAutoSync`; desktop =
  the backend loop. Backend sync is disabled when `client_owned_data` (mobile).
  The proven storage/identity layer (uid/updated_at/tombstones/LWW) was KEPT;
  only the orchestration + UX were rebuilt.
- **Piper wins for English TTS** (user, 2026-09-11), on desktop AND mobile.
  Desktop is shipped. Mobile: run the same voice on-device via **sherpa-onnx**
  (prebuilt arm64 AAR, Kotlin API) — NOT Chaquopy Python (no arm64 onnx wheel).
  Android's built-in TextToSpeech was rejected on quality.
- **No overlap warning for a SESSION inside a ROUTINE** (user, 2026-09-11). The
  session fills the block. Other clashes still warn. See
  `crud.find_schedule_conflicts` / `all_schedule_conflicts`.
- **Commit directly on `main` and push.** No branches (user, 2026-09-11).
- Personal build: Supabase key in the APK is accepted; Android is
  foreground-only. Don't raise these as blockers.
- Tool-driven panels (surfaces) appear only in voice mode, and show only what
  was asked, not whole lists.
- Half-duplex voice: the mic stays muted until JARVIS finishes speaking.
- Schedule has exactly three sections: My routine, College, Blocks.

## Hard-won fixes: check before rewriting these areas

Each of these fixed a real bug the user hit. The 2026-09-11 audit found all of
them intact except the last part of #9.

1. `agent.py`: the user's question must be the **last** message before
   generation. The state block used to come after it, and JARVIS answered the
   *previous* question. Look for `trailing_user`, `settled`,
   `tool_cycle_started`.
2. `agent.py`: `strip_time_opener`, `is_clock_only`,
   `_defuse_clock_only_replies` stop JARVIS reciting the clock every turn.
3. `agent.py`: `dominant_script()` uses presence, not majority, because replies
   code-mix Telugu and English.
4. `prompts.py`: keep prompts short and action-first. Repeated rules get
   *recited* ("salience is contagious"). Adding more time rules made the
   clock problem worse. Cut rules; don't add them.
5. `context.py`: the weekly grid is conditional on `full_schedule`; Clock/Date
   are split fields and not first in the block.
6. `tools.py`: `get_weather` description leads with "works anywhere on earth".
7. `sync.py` / `syncClient.ts`: pushing a tombstone must also delete the row
   upstream, or deleted items come back.
8. `button.tsx`: `expandHitArea` defaults to true (touch targets).
9. `TaskTable.tsx`: title padding and a **sticky toolbar** for touch. The
   rewrite kept the padding but the toolbar is **no longer sticky**.
10. `realtime.py`: `FIRST_CHUNK_MIN_CHARS = 16`, merged ceiling 96,
    `MAX_CHUNK_CHARS = 320` (speech pacing), and `_follow_spoken_language`.

## Open issues (audit of 2026-09-11, commit 3b4f9e3)

Confirmed high:

1. **FIXED (2026-09-11): memory search returned unrelated memories.**
   `memory.py::_score` now separates lexical *relevance* (token/phrase overlap)
   from the ranking boosts (importance/confidence/recency), and gates the
   SequenceMatcher fuzz behind a real shared word / phrase substring / empty
   token set (the last keeps Telugu matching, since the tokenizer drops its
   short clusters). Zero relevance + non-empty query -> not a match. smoke_test
   'no results handled cleanly' passes; full backend suite 22/22 green.
2. **Migration v1 is not atomic** (`migrations.py:53`). The connection is
   autocommit and `apply()` never BEGINs, so a crash mid-rebuild strands every
   schedule in `schedules_old`. Fix: wrap each migration plus its
   `user_version` in `BEGIN IMMEDIATE`/`COMMIT`. v4 and v6 use `executescript`,
   which commits implicitly, so split those into single `execute` calls.
3. **`localstore.py:114`**: seed and drain clear the whole change journal
   without atomicity, so writes made during an overlapping seed/drain are lost.
4. **`announcements.py:49`**: the outbox has no consumer. Queued notifications
   are never read or acked.

Medium, worth doing:

- `memory.py:57` tokenizer splits Telugu at vowel signs, so Telugu queries get
  no token overlap.
- `realtime.py:495`: the 75s turn timeout now counts playback, so long replies
  get cut off.
- `sarvam.py:111` retries chat completions that timed out *after* being sent
  (double billing). `sarvam.py:325` stream fallback closes the shared pool.
- `syncClient.ts:348`: the tombstone push cursor can move into the future and
  stop deletions reaching Supabase.
- `memory.py:447`: inferred-candidate patterns turn ordinary speech ("never
  mind") into memory rows.
- `notification_policy.py:35`: the include list grows forever.
- `NotesWorkspace.tsx:81`: an archived memory vanishes from the UI.
- `TaskTable.tsx:128`: toolbar no longer sticky (fix #9).
- `integration_test` fails on `add_schedule_event` since the overlap change.
  Not investigated yet.

## Environment notes

- Python: `backend/.venv/Scripts/python.exe` (the global Python lacks
  `aiosqlite`). Tests are standalone: run each `backend/tests/*_test.py`.
- Node is not on the Git Bash PATH; use PowerShell. Typecheck from `frontend/`
  with `node node_modules/typescript/bin/tsc --noEmit`.
- Write multi-line edits via a file, not a shell heredoc with backslashes.
  Heredoc escaping has corrupted source here (`\b`, `\0` became control bytes).
- Files mix LF and CRLF. Preserve each file's endings; Python's `write_text` on
  Windows silently writes CRLF.
- Sarvam gives a prefix cache only with `stream=False`. Credits are limited, so
  avoid live-provider tests unless needed.
- Never let tests touch `backend/storage/jarvis_memory.db` (real data).

## Log

### 2026-09-13 · Claude Code · jarvis-oss SLDT stage 3: Remote adapter, not activated
- Continuation of the stage-2 entry directly below -- same feature, same
  session's scope agreement. User asked to (a) build the `SldtClient`
  façade and (b) wire it into `frontend/` as a drop-in `Remote`; explicitly
  declined the alternative (a live GitHub round trip), since that needs a
  real repo + PAT only the user can create.
- Added `jarvis-oss/sldt/src/client.ts` (`SldtClient`): composes
  identity/key derivation, `browserStore.ts` persistence, and the sync
  engine into the API an app actually calls (`upsert`/`delete`/`get`/
  `listByType`/`listAll`/`sync`). `sync()` persists local state even if
  the network cycle throws, so queued edits survive a crash mid-cycle.
- Found the real integration point on the paid side:
  `frontend/src/lib/syncClient.ts` already isolates its network dependency
  behind a `Remote` interface (`fetchRows`/`pushRows`/`fetchTombstones`/
  `pushTombstones`) — `SupabaseRemote` is just one implementation of it.
  So rather than build a parallel façade, the real move was implementing
  that same interface: `frontend/src/lib/sldtRemote.ts` (`SldtRemote`).
- The one real design wrinkle: `syncClient.ts`'s `push()` calls
  `pushRows`/`pushTombstones` once per table expecting each to be an
  independent, cheap network round trip (true for Supabase's REST API).
  SLDT's actual unit of work is one atomic manifest cycle covering every
  pending change at once. Resolved by buffering pushes into the
  `SldtClient` (no network) and running exactly one real `sync()` cycle on
  the first subsequent `fetchRows`/`fetchTombstones` call, reusing that
  result for the rest of the round.
- Real bug caught by `frontend/tests/sldtRemote.test.ts` (not by
  inspection): the cached cycle was only invalidated inside
  `pushRows`/`pushTombstones`, which `push()` skips entirely when nothing
  is locally pending — so a pure "pull, nothing to push" round (the
  common case: periodic background pull, or open-the-app pull) would have
  silently replayed the first round's stale result forever and never
  actually pulled new data from a peer. Fixed by also invalidating in
  `fetchTombstones`, since `pull()`'s own code comment ("Tombstones apply
  *after* rows") establishes it's reliably the last call of a round.
- Getting the frontend import to work at all took two `next.config.mjs`
  changes, found by actually trying to build rather than guessing:
  `experimental.externalDir: true` (Next refuses by default to resolve an
  import that reaches outside the project directory — confirmed by first
  building *without* it and watching it fail exactly that way), and a
  `webpack(config)` hook adding `resolve.extensionAlias: {".js": [".ts",
  ".tsx", ".js"]}` (jarvis-oss/sldt's own files use `.js`-suffixed
  relative imports pointing at `.ts` source, the standard convention for
  a package meant to run under Node's ESM loader / `tsx` without a build
  step — webpack doesn't do that remap on its own). Verified for real:
  temporarily added a throwaway route (`app/sldtprobetest/`) importing the
  adapter, ran `next build`, confirmed the route actually appeared in the
  build's route table (a leading-underscore folder name I tried first
  silently opts out of Next's routing and would have proven nothing),
  then deleted the probe route once the build was clean.
- Verified: `frontend/tests/sldtRemote.test.ts` (13 assertions, 0 network
  calls) exercises the adapter through the real `syncOnce(remote)` path
  against real `localdb.ts` rows (fake-indexeddb), with a raw SLDT peer
  (bare `sync.ts` primitives, no IndexedDB) standing in for a second
  device — push, pull, and delete confirmed in both directions. Existing
  `frontend/tests/sync.test.ts` (43 assertions), `npm run typecheck`, and
  `npm run build` all still pass/succeed unchanged after these edits.
  `jarvis-oss/sldt`'s own suite (`npm test`, now 73 assertions across 7
  files including `client.test.ts`) and `jarvis-oss/proxy`'s (15
  assertions) still pass.
- Updated `README.md`, `docs/architecture.md`, and
  `jarvis-oss/sldt/README.md`; nothing under `backend/` or `native/`
  touched, and `frontend/`'s only changes are the two additive
  `next.config.mjs` entries plus two new files
  (`src/lib/sldtRemote.ts`, `tests/sldtRemote.test.ts`) that nothing else
  imports.
- **Left for next:** no settings UI exists anywhere for a user to actually
  choose SLDT over Supabase (a real product decision — build-time flag vs.
  runtime toggle — deliberately not made here); the proxy is still not
  deployed and no code has made a real call to api.github.com; BYOK for
  LLM/STT/TTS is untouched.

### 2026-09-13 · Claude Code · jarvis-oss SLDT stage 2: persistence + write proxy
- Continuation of the stage-1 entry directly below this one -- same user,
  same feature, same session's scope agreement (staged build, no UI yet).
- Added `jarvis-oss/sldt/src/browserStore.ts`: IndexedDB persistence for the
  sync engine's `LocalObjectSet` and `SyncState`, plus non-secret identity
  (`datasetId`, `deviceId`) -- deliberately never the account `secret`,
  matching the SLDT design's "re-derive, never persist" rule. Follows
  `frontend/src/lib/localdb.ts`'s exact transaction idiom (resolve on
  `transaction.oncomplete`, not the individual request, to avoid the classic
  IndexedDB bug where a write looks committed but the transaction later
  aborts).
- Added `jarvis-oss/sldt/src/githubClient.ts`: wires the `Store` abstraction
  from stage 1 to reality. Reads hit GitHub's public Contents API directly
  (no credential needed for a public repo); writes route through a new
  proxy. Deliberately does *not* send `repo`/`branch` in the write request body
  -- the proxy is single-tenant with its own fixed target, so a compromised
  client can't redirect writes to a different repo the credential reaches.
- Built `jarvis-oss/proxy/`: the one stateless server-side component the
  SLDT design calls for. `POST /write` only; holds the GitHub PAT from an
  env var; rejects any request body that isn't exactly
  `{path, content, sha, message}` (`handler.ts::validateShape`); restricts
  writes to a configured path prefix and rejects `..` traversal even inside
  it; logs only field shapes and content byte length, never values; passes
  through a GitHub 409/422 CAS conflict as a bare status code rather than
  echoing GitHub's raw error text. Plain `node:http` entrypoint
  (`server.ts`) around a framework-agnostic `handler.ts` so it's portable to
  a serverless function later without touching the logic.
- Verified: `npm test` in both `jarvis-oss/sldt/` (18 new assertions across
  `browserStore.test.ts`, run under `fake-indexeddb`) and `jarvis-oss/proxy/`
  (15 assertions in `handler.test.ts`, GitHub's API mocked with a fake
  `fetch`) -- all passing, zero live network calls, zero credits spent.
  `npx tsc --noEmit` clean in both packages.
- **Not done, stated in both READMEs:** the proxy has not been deployed
  anywhere and nothing in this repo has made a real request to
  api.github.com yet -- that's the next verification step before any device
  relies on this path. Still no `SldtClient` façade composing
  persistence+network+sync into the one call an app would actually make,
  and still no desktop/Android/frontend UI wiring or BYOK work.

### 2026-09-13 · Claude Code · jarvis-oss scaffold: SLDT sync core (stage 1)
- User is building an open-source edition of JARVIS (desktop + Android) that
  swaps the paid app's Supabase mirror for **SLDT** (server-independent
  encrypted sync over a publicly addressable object store -- GitHub Contents
  API in this stage) plus BYOK for LLM/STT/TTS. Agreed scope with the user:
  new tree at `jarvis-oss/` in this same repo (not a separate repo, not a
  runtime flag inside the existing app), built in stages -- this entry is
  stage 1 only: the sync engine as a standalone, tested library, no UI.
- Chose TypeScript over Python for the engine after reading
  `backend/app/services/sync.py`: that file explains the *paid* app's real
  sync engine was retired from Python and now lives entirely in
  `frontend/src/lib/syncClient.ts`, because Tauri desktop and the Android
  build share the same webview frontend. SLDT slots into that same
  integration point on both platforms with no native code, so it follows
  that precedent instead of reinventing it in Python.
- Built `jarvis-oss/sldt/src/`: `identity.ts` (Argon2id via `hash-wasm`,
  domain-separated encryption/auth keys, `SLDT:<datasetId>:<secret>` recovery
  code), `crypto.ts` (AES-256-GCM via Web Crypto, fixed-bucket padding,
  SHA-256/HMAC), `canonicalJson.ts` (key-sorted JSON for signing),
  `objects.ts` (per-object encrypted envelope), `manifest.ts` (signed,
  hash-chained, revision-checked manifest), `conflict.ts`
  (revision-then-deviceId tiebreak, never wall-clock), `store.ts` (`Store`
  CAS interface, `InMemoryStore`, and a `GitHubStore` shaped for the real
  Contents API but fed its request function by the caller -- no live network
  code exists yet), `sync.ts` (the pull/resolve/push/CAS-retry algorithm).
- Two real bugs found and fixed while writing `tests/sync.test.ts` (worth
  flagging since they're the kind that "look done" until traced by hand):
  (1) a conflict winner that keeps its own revision number is invisible to a
  revision-only "did anything change" check, so a losing device's next sync
  would silently keep stale content forever -- fixed by tracking a
  `knownHash` per object and comparing hashes, not just revisions
  (`sync.ts`); (2) the per-object CAS write used a hardcoded `null` expected
  version, which broke on every second edit to the same object once the
  object already existed remotely -- fixed by threading the store's real
  version token (`storeVersion`) through pull/push. Also fixed integrity
  hashing: it was computed by parsing the envelope back to JSON first, so a
  genuinely corrupted/bit-rotted object crashed the whole sync with a
  `SyntaxError` instead of being reported as `CorruptObject` -- hash is now
  over the raw stored bytes, no parsing on that path.
- Verified: `npm test` in `jarvis-oss/sldt/` -- 5 files, 51 assertions, 0
  failures, no network calls and no provider credits spent. Covers: first
  device publish, cross-device pull, concurrent-edit conflict resolution and
  convergence, tombstone delete propagation (including a late-joining third
  device not resurrecting the delete), wrong-key rejection (`TamperDetected`),
  and corrupted-ciphertext detection. `npx tsc --noEmit` is clean. This is
  source-level verification only -- nothing has been run against a live
  GitHub repo, and no proxy/UI/app exists yet to verify on-device.
- Updated `README.md` (top pointer + Maintenance entry) and
  `docs/architecture.md` (note in "Record lifecycle and synchronization")
  per this repo's documentation rule. Nothing under `backend/`, `frontend/`,
  or `native/` was touched -- the paid app's Supabase path is unaffected.
- **Left for the next stage** (not started): the stateless write proxy;
  wiring `sync.ts` into an actual frontend/IndexedDB persistence layer for
  `SyncState` and the local object set; any desktop/Android UI (pairing,
  recovery code entry, store configuration); BYOK settings for LLM/STT/TTS
  providers. See `jarvis-oss/sldt/README.md` for the full deferred list.

### 2026-09-13 · Claude Code · Desktop backend watchdog -- survives a mid-session crash
- User's desktop app showed "Backend unreachable"; the window had been open
  since before an unrelated session killed the backend process for testing.
  `backend.rs` already auto-starts the backend on launch (`spawn`, committed
  in the 2026-09-11 checkpoint) -- confirmed this still works by running the
  actual release `app.exe` directly and watching it spawn its own backend.
  The real gap: `spawn` only ever runs once, at launch, so a backend that
  dies *after* the window opens had no way back without closing and
  reopening the app.
- Fix: `backend::watch()` -- a background thread started alongside the
  initial spawn, checking every 3s (`WATCHDOG_INTERVAL`) whether the tracked
  child is still alive (`Child::try_wait()`). If not, and nothing else has
  taken port 8000 (same `already_running()` check the initial launch uses,
  so a developer's own `run.ps1 --reload` is never fought), it restarts the
  backend. Gives up after 5 consecutive failed restarts
  (`WATCHDOG_MAX_CONSECUTIVE_FAILURES`) so a backend broken in a way
  restarting can't fix degrades to the existing error banner instead of
  spinning forever; a restart has to stay up 10s (`WATCHDOG_HEALTHY_AFTER`)
  before it resets that counter, so a start-then-immediately-die loop still
  counts toward giving up rather than looking like 5 unrelated one-offs.
  `Backend` gained a `shutting_down` `AtomicBool`, set *before* `stop()`
  kills the child, so the watchdog doesn't see its own intentional kill as a
  crash and "helpfully" resurrect the backend the user is closing.
- Checked the frontend before touching it: `page.tsx:263`'s existing
  self-scheduling retry (1.5s/2.5s/4s/8s/15s backoff on a miss, settling to
  a 60s poll) already re-fetches on its own with no error-state special
  case, so it picks up a watchdog-restarted backend automatically. No
  frontend change was needed -- almost added a redundant polling effect
  before actually reading this file closely enough to see it already existed.
- Verified against the real release binary, not just `cargo check`: built
  `--release`, launched it, confirmed auto-start (fresh PID bound to 8000);
  force-killed that backend PID directly and watched a new one bind the port
  within seconds without the window itself restarting, then confirmed
  `/api/health` on the new process; separately confirmed a graceful window
  close (`Process.CloseMainWindow()`, i.e. what a real close-button click
  sends -- not `Stop-Process -Force`, which bypasses Tauri's own event
  handlers entirely and is not a valid test of this) stops the backend
  cleanly with no orphan.
- **Left open, out of scope for this pass:** a *hard* kill of the whole app
  process (Task Manager "End Task", a crash, forced shutdown) still orphans
  the backend -- confirmed this by testing it first, wrongly, as if it were
  the graceful-close case, before realizing `Stop-Process -Force` on the
  parent doesn't run any of the app's own shutdown code and Windows does not
  kill children with their parent absent a Job Object. Fixable with a
  Windows Job Object tying the child's lifetime to the parent's at the OS
  level if this turns out to matter in practice; not done here since it
  wasn't what was reported and is a bigger change than the actual ask.

### 2026-09-13 · Claude Code · On-device Piper gap, round 2 -- pool concurrency reversed, chunk size fixed
- User reported the "parts... parts" gap again after the 2026-09-12 fix
  below (line ~962) had reduced it. **I did not see that entry until after
  landing my own fix** -- found it only while writing this one. Read it now;
  it changes how the pool-size finding here should be understood, noted below.
- Measured live with real on-device timestamps (`Log.i` in `JarvisTts.kt`,
  tag `JarvisTts`, read via `adb logcat`; desktop's Chaquopy-embedded backend
  logs came along for free under `python.stdout`/`python.stderr`). Confirmed
  by direct measurement, not inference: a chunk's own synthesis time, not the
  LLM or the chunker, is what stalls -- e.g. a 114-char chunk queued at
  t=1.6s wasn't ready until t=8.6s, well after the opener's ~1.8s of audio
  had already finished playing.
- Fix 1: `NATIVE_TTS_MAX_CHUNK_CHARS=96` in `realtime.py`, used instead of
  the Sarvam-tuned `MAX_CHUNK_CHARS=320` whenever a session negotiates
  `english_tts=client`. On-device sherpa-onnx costs ~40-70ms/char; a 320-char
  chunk cannot possibly finish inside the ~1-2s of audio the chunk ahead of
  it buys. Threaded through `_split_sentences`'s new `max_chars` param and
  `_bound`'s existing `limit` param -- both already took the cap as an
  argument, `handle_turn` just always passed the module constant before.
- Fix 2: `JarvisTts.kt`'s `POOL_SIZE` dropped 3 -> 1. **This reverses the
  2026-09-12 entry's own concurrency fix** -- see that entry for why 3 was
  chosen. On-device A/B this session: a 114-char chunk synthesized at
  61ms/char under 3-way concurrency vs 50ms/char alone; a 54-char chunk at
  69ms/char concurrent vs 36ms/char alone. Reasoning for reversing it:
  `speechQueue.ts`'s `this.chain` plays chunks in strict arrival order
  regardless of which finishes synthesizing first (confirmed directly: a
  chunk ready 2.85s before the one ahead of it in the queue still couldn't
  play until that one ended) -- so a later chunk synthesizing concurrently
  is never heard any sooner, it only contends with the CPU budget of
  whichever chunk is actually gating playback. This may be why the prior
  entry's own last A/B (2-slot/3-thread vs 3-slot/2-thread) already showed
  higher variance for 3 slots on the same test, and why it flagged the pool
  size as possibly not settled.
- **Caveat I did not control for and should have, given the prior entry's
  explicit warning:** thermal throttling. That entry measured 99.6C on 4 of
  8 cores after sustained back-to-back on-device synthesis and called out
  run-to-run variance as a likely symptom. My A/B was two separate
  build-install-test round trips (pool=3, then pool=1) with real gaps
  between them (waiting on the user), not a tight back-to-back loop, and the
  solo-vs-concurrent contrast happened *within* one single turn each time
  (opener alone, then two chunks together, ~10s apart) rather than across a
  long hot-device session -- but I never checked device temperature
  (`adb shell dumpsys thermalservice` or `/sys/class/thermal/thermal_zone*/temp`
  would have). If POOL_SIZE=1 doesn't hold up on retest, thermal state
  across the two test sessions is the first thing to rule out before
  re-litigating the concurrency question.
- Also fixed, in the diagnostic tooling only (not shipped): a throwaway
  script treated `{"type":"turn"}` (sent when a turn *starts*) as the
  completion signal instead of `{"type":"turn_end"}`, reporting zero audio
  for every turn until corrected.
- Checks: full backend suite green; two pre-existing failures
  (`latency_test.py` -- flaky live network; `reminder_lead_test.py` -- a
  date-sensitive edge case, tripped by the real clock crossing into
  2026-09-13 mid-session) reproduced in isolation and confirmed unrelated.
  3 new offline checks in `voice_pipeline_test.py` pin
  `NATIVE_TTS_MAX_CHUNK_CHARS` and the new `max_chars`/`limit` parameters.
  Built and installed to the device with both changes together.
  **Not yet done: on-device confirmation of the combined fix against a real
  reproduction** -- the user stepped away mid-session; this is the next
  thing to check when they're back, and worth watching for exactly the
  "still ~10% has some gap" pattern the prior entry left open, in case the
  remaining cause is a third thing neither entry has found yet.

### 2026-09-12 · Claude Code · Gemini for English chat, Sarvam as its own fallback
- User: for English replies, use Gemini as the LLM (STT stays Sarvam, TTS
  stays Piper), fall back to Sarvam if Gemini fails; non-English keeps
  Sarvam's whole stack; when Gemini is in use and a search is needed, prefer
  its own `google_search` grounding, falling back to the existing
  `web_search` tool if that fails. Provided a Gemini API key via Google AI
  Studio (`GEMINI_API_KEY`, `GEMINI_MODEL` in `.env`).
- **Verified the live API before writing any provider code**, the same
  discipline this project already applies to Sarvam ("probe the live
  endpoint, docs have been wrong before" — here Google's own docs, not
  Sarvam's). Findings that would have been wrong to assume from training
  data or a single doc fetch:
  - `gemini-2.5-flash` 404s for new API keys — Google's own error message
    names `gemini-3.6-flash` as the replacement and points at a whole new
    "Interactions API" the docs half-reference. Model names on this vendor
    churn fast.
  - Every Gemini 3.x model "thinks" by default and that budget comes out of
    the SAME `max_output_tokens` the visible answer does — measured a
    200-token cap returning empty text with the entire budget spent on
    thinking, on THREE different 3.x models. `thinking_budget: 0` (the
    2.5-era way to disable it) is flatly rejected on 3.x; `thinking_level`
    ("low"/"medium"/"high") is accepted but even "low" still burns real
    tokens on 3.5/3.6.
  - Measured latency head-to-head, identical prompt: `gemini-3.5-flash-lite`
    ~1.7s to first token / ~4s total; `gemini-3.6-flash` ~9s / ~13s. Flash-lite
    is the only one of the two worth defaulting to for a voice-adjacent
    assistant, so that is `GEMINI_MODEL`'s default despite Google's own error
    message steering toward 3.6.
  - A function-call response part carries a `thoughtSignature` field that
    Gemini 3.x **requires verbatim** if that exact call is ever replayed in a
    later turn's history — confirmed live: a hand-built multi-turn request
    without it came back a hard 400 ("Function call is missing a
    thought_signature"), not a soft warning as the error text half-implies.
  - `google_search` (built-in grounding) hit a 429 RESOURCE_EXHAUSTED on the
    very first attempt on this fresh key/project — the free tier's grounding
    quota is apparently near zero. Its error text is generic
    ("You exceeded your current quota...") and never mentions "search" —
    important, because it means the fallback trigger can't be
    keyword-matched on the error message; see below.
- **Built `app/providers/gemini.py`**: `GeminiChat` (talks only to Gemini,
  raises this project's normal `ProviderError` subclasses) and
  `EnglishChatProvider` (tries Gemini, falls back to Sarvam on any
  `ProviderError` raised before anything was yielded -- exactly the
  "a request may be replayed only until something has crossed the provider
  boundary" rule this codebase already applies to Sarvam's own voice-model
  override, reused verbatim rather than reinvented). A 60s cooldown after a
  Gemini failure, shorter than Sarvam's own 180s override cooldown since a
  whole-provider outage recovering into normal English answers matters more
  than not re-probing a single dead model variant.
- **thoughtSignature handling**: rather than threading a Gemini-specific
  field through the shared, provider-agnostic message history (used
  identically by Sarvam and persisted to the chat_messages table), kept it
  entirely inside `GeminiChat` as a process-lifetime `id -> {name,
  signature}` cache, populated the moment a call is first issued. Translating
  history TO Gemini's shape: a call with a cached signature is replayed
  exactly; a call `GeminiChat` never issued (Sarvam's history, or an id from
  before this process started) has its structured function-call part
  dropped and only its text kept, and the corresponding tool-result message
  folds into a plain "Result: ..." text turn instead of an orphaned
  `functionResponse`. This trades some structural precision on very old or
  cross-provider history for needing zero changes to the shared data model —
  matches this codebase's own stated provider-isolation goal ("swapping
  vendors is a new module here plus an env var; nothing in the agent, the
  API layer or the UI changes").
- **Fixed a real bug in my own first draft before it shipped**: the first
  version of `stream()` used `client.post()` against the
  `streamGenerateContent` endpoint and buffered every chunk into a list,
  yielding them only after the whole response finished — silently defeating
  the entire point of a streaming call (no first-token latency benefit,
  despite "streaming" being the reason to use this endpoint at all).
  Rewrote to use `client.stream()` properly and yield each `ChatChunk` the
  instant its SSE line arrives, matching `SarvamChat`'s own established
  shape exactly. Caught by re-reading my own diff against Sarvam's pattern,
  not by a test — worth being honest that this session did not catch it via
  automated coverage.
- **Search fallback**: `google_search` is sent on every Gemini call
  alongside this app's own `function_declarations` (Gemini 3+ models support
  combining built-in and custom tools in one request). If that first attempt
  fails and nothing has been emitted yet, retries once with `google_search`
  removed — regardless of the error's wording, per the finding above that
  the real quota error never mentions "search." The model still has its own
  `web_search`/`fetch_url` function tools in the retried request, so it can
  reach for those instead. Confirmed this is not hypothetical: it fired on
  every single live test in this session, because this account's grounding
  quota is already exhausted.
- **Wired into `agent.py`**: English routing reuses this file's own existing
  rule ("the text console stays in English") — `language is None` (always
  true for typed chat) or a code starting with "en" selects
  `get_english_chat_provider()`; anything else keeps
  `get_chat_provider()` (Sarvam), completely untouched by this change.
- Verified live through the REAL agent loop, not just raw HTTP probes:
  (1) a plain English question answered correctly via Gemini
  (`provider: gemini`, `gemini-3.5-flash-lite`); (2) an English request
  needing a tool call (`add_task`) correctly called the tool, received its
  result, and continued to a natural follow-up reply — proving the full
  multi-turn round trip including thoughtSignature persistence actually
  works, not just a single-shot call; (3) deliberately broke Gemini (a
  nonexistent model name) and confirmed the SAME turn completed correctly
  via Sarvam instead, with the expected cooldown log line; (4) confirmed via
  live INFO-level logs that the search-grounding retry fires and recovers
  automatically on a real 429, mid-turn, invisibly to the model and the
  user; (5) confirmed a non-English turn (`language="te-IN"`) reports
  `provider: sarvam` and never touches Gemini at all.
- Added `tests/gemini_provider_test.py` (18 offline checks, no credits
  spent): tool-declaration translation, HTTP-status-to-ProviderError mapping
  for 401/404/429/5xx, the full `_to_contents` translation matrix (system
  extraction; a recognised call replayed with its signature; an
  unrecognised call's structured part dropped while its text and result
  survive as plain text), and the Sarvam fallback plus its cooldown, against
  a stubbed transport mirroring `model_failover_test.py`'s own established
  pattern.
- Checks: `gemini_provider_test.py` 18/18; full backend suite re-run; five
  live end-to-end scenarios above.
- **Not done**: no equivalent "Gemini for X" option exists for non-English
  languages — this was explicitly scoped to English only, per the request.
  `GEMINI_CHAT_TIMEOUT` (30s) has not been tuned against a genuinely slow
  Gemini response in practice, only against the measured-fast lite-tier
  model; if a future model swap regresses latency, this is the first knob
  to check.

### 2026-09-12 · Claude Code · A real "Reminders" section, view/edit/add/delete, both platforms
- User: add a separate section to view/edit/add/delete reminders on both
  desktop and mobile. Investigated before building: `POST`/`GET`/`DELETE
  /api/reminders` already existed in `announcements.py`, explicitly
  commented "the UI, not the agent" -- built at some point for a UI that
  was never actually made. Only `PATCH` (edit) was missing, and no
  frontend page anywhere called any of these routes.
- **Architecture check before writing any UI code**: confirmed reminders
  are deliberately NOT one of the five synced record types
  (`SYNCED_TABLES` in `localdb.ts` = tasks/schedules/memories/ideas/
  note_pages) -- each device fires its own alarms off its own local
  backend, matching the README's own note that "reminders and
  announcement delivery have separate storage paths." This meant the new
  UI needed none of the `RecordsMode`/local-vs-backend branching every
  other editable record goes through (`records.ts`'s big comment about
  "two authoritative stores") -- a single, platform-agnostic REST call
  path, simpler than every other record type in the app.
- **Placement decided without asking**: this codebase's own documented UX
  guideline caps mobile bottom nav at 5 items, already fully used
  (Tasks/Schedule/Voice/Notes/Chat). Rather than violate that or ask the
  user to pick, found that `ScheduleBoard.tsx` is a SINGLE component
  rendered on both desktop and mobile (`product.css` handles the
  responsive split, not separate implementations) with an existing
  segmented control (My routine / College / Blocks). Added "Reminders" as
  a fourth segment there -- a genuinely separate section, visible
  identically on both platforms the instant this shipped, with no nav
  changes, no mobile-specific work, and no deviation from the 5-item
  guideline.
- Backend: `crud.update_reminder(id, text=, due_at=)` (editing the time
  un-fires the row and clears `target_at` -- a manual edit turns a
  possibly-early-notice row back into a plain exact-time reminder, so the
  old target can't misquote "in N minutes" against a time that is no
  longer what changed). `ReminderUpdate` schema. `PATCH /api/reminders/
  {id}`, validated exactly like `POST` (rejects unparseable text, rejects
  a time already in the past).
- Frontend: `Reminder` type; `fetchReminders()` in `api.ts` (no
  `RecordsMode` — see above); `createReminder`/`updateReminder`/
  `deleteReminder` in `records.ts`, same reasoning. `ScheduleBoard.tsx`:
  `Editing` became a discriminated union (`{kind:"event"|"reminder",
  record}`) instead of a bare `ScheduleEvent | "new"`, since the same
  modal now edits two different record shapes; a new `ReminderList`
  (flat, soonest-first, using the existing `formatDateTime`/
  `relativeLabel` helpers `ScheduleTimeline` already uses for one-off
  sessions) plus `REMINDER_FIELDS` for the shared `RecordEditor`. Reminders
  are fetched once on mount (not lazily on first opening that segment) so
  the segmented control's count is never a placeholder zero.
- **Real bug caught by actually testing the built UI, not just
  typechecking**: after building the feature, edit and delete worked but
  every `PATCH` came back "Method Not Allowed" in the live browser check.
  Root cause: the desktop app instance being tested was still the process
  from BEFORE the backend edit landed -- Python code, so needs a restart
  to pick up new routes, and this one hadn't had one. Not a bug in the
  code at all; restarted the running app and re-tested clean. Recorded
  here because it is exactly the kind of thing "I typechecked it" would
  have missed -- only driving the real running app through create → edit
  → delete in the browser caught it.
- Verified live in the browser end to end, not just via curl: opened
  Schedule, clicked the new "Reminders" segment (count starts at 0, empty
  state with a bell icon and a usage hint), created "Water the office
  plants" for the next day (appeared immediately, correct relative "in
  1d" label, segment count updated to 1), edited its text in place
  (updated instantly), deleted it with the same confirm-inside-the-editor
  flow every other record type uses (back to the empty state, count back
  to 0).
- Checks: 12 new dedicated checks in `smoke_test.py`'s HTTP-routes section
  covering the full `POST`/`GET`/`PATCH`/`DELETE` cycle including both
  validation paths (past-time rejected on create AND on update) and both
  404 paths (update/delete a nonexistent id) -- all pass. Full backend
  suite re-run clean. Frontend: `tsc --noEmit` clean, `next build`
  (production) compiles with only the two pre-existing, already-documented
  hook-dependency warnings. No new frontend test file added -- this
  codebase has no existing precedent for component-level UI tests (its
  frontend tests cover speech/sync/endpointing logic, not rendered
  components), so live browser verification stood in for that instead of
  inventing a new test harness for one feature.
- **Not yet built on the packaged Android app** -- this ships automatically
  to Android on the next `npm run android:install` (backend-only + shared
  `ScheduleBoard.tsx`, no native Kotlin changes needed), but has not been
  installed/confirmed on the physical device this pass.

### 2026-09-12 · Claude Code · Bulk delete for schedule entries and memories/ideas
- User: "why is it still saying i can[']t delete the schedule entrys? it
  should have ability to do anything... delete every task, or delete
  certain block for whole week, or find certain block timing or change the
  certain timing... whether they are tasks or memory or schedules or
  whatever." Investigated rather than assumed the model was simply being
  timid -- audited the actual tool registry.
- **Confirmed a real, structural gap, not a prompting issue**: tasks had
  `bulk_delete_tasks` (scope/matching/created_on filters, two-step
  count-verified confirm) since an earlier session. Schedule and
  memory/idea had NOTHING equivalent -- only `update_schedule_event`/
  `delete_record`, both single-row. A recurring COLLEGE/ROUTINE block is
  stored as one row PER WEEKDAY it repeats on, so "delete my Study block
  for the whole week" was, structurally, N separate confirmations the
  model had no way to collapse into one -- it wasn't refusing out of
  caution, the capability genuinely did not exist.
- Added `bulk_delete_schedule` (`app/llm/tools.py` + new
  `crud.delete_schedules_where(kind, matching, day_of_week)`, replacing the
  never-called `delete_schedules_by_kind`) and `bulk_delete_notes`
  (`app/llm/tools.py` + new `crud.delete_memories_where(matching,
  category)` / `crud.delete_ideas_where(matching, status)`). Both reuse
  `bulk_delete_tasks`'s exact two-step shape verbatim: an unconfirmed call
  resolves and describes the real matching set (with an exact count) and
  changes nothing; a confirmed call must also pass `expect_count`, and a
  mismatch is refused outright -- the same fix that closed a real prior
  incident where a model-relayed count ("3") didn't match the tool's real
  scope ("19") and the wrong number of tasks went. `bulk_delete_schedule`
  filters compose freely (kind, name substring, weekday), so "clear my
  Fridays," "wipe every ROUTINE entry," and "delete this block for the
  whole week" are each exactly one call. `bulk_delete_notes` takes a
  required `record_type` (memory or idea, separate tables with different
  filters -- category for memory, status for idea) and the model is told
  to call it twice for "forget everything about X" if the user means both.
- **Found and fixed the other half of the problem while at it**: the
  system prompt's own deletion section (both the typed `SYSTEM_PROMPT` and
  `VOICE_SYSTEM_PROMPT`) named ONLY `bulk_delete_tasks` as the worked
  example for "deleting many things is one question, not one per record."
  Even after building the new tools, the model had no textual signal that
  an equivalent existed for schedule/notes -- exactly the kind of gap that
  produces a confident, wrong "I can't do that" instead of silence. Updated
  both prompt sections to name all three bulk tools explicitly, and added a
  second worked voice example ("clear my Study block for the whole week" ->
  "that's five sessions, Monday through Friday...").
- Verified with a live offline test against an isolated fixture DB before
  writing anything into the test suite: seeded a "Study block" ROUTINE
  entry across 5 weekdays, called `bulk_delete_schedule` unconfirmed
  (correctly listed all 5, deleted nothing), confirmed with the wrong count
  (refused, nothing deleted), then confirmed with the right count (deleted
  exactly those 5, left an unrelated "Java Lab" COLLEGE entry untouched).
  Same pattern for `bulk_delete_notes` against ideas (3 "Hackathon"-titled
  ideas deleted, unrelated idea survives) and memories (1 GOAL-category
  memory deleted, PREFERENCE-category memory survives; a wrong
  `expect_count` against 2 real matches correctly refused and left both).
- Added dedicated test blocks to `smoke_test.py` for both tools (mirroring
  `bulk_delete_tasks`'s own existing block exactly): confirmation gating,
  missing/wrong `expect_count` refusal, correct deletion count, unrelated
  fixture rows surviving, unknown kind/category/status rejected. Bumped the
  pinned `"N core tools registered"` assertion twice (19 -> 20 -> 21, one
  per new core tool) per its own comment's instruction to do so
  deliberately when a core tool is added. Added probe entries for both new
  tools to the general "every tool has a probe" wiring-coverage section.
- Checks: `smoke_test.py` full pass including all new checks individually
  confirmed via targeted output inspection (not just the aggregate "ALL
  CHECKS PASSED"); full backend suite re-run clean afterward.

### 2026-09-12 · Claude Code · Desktop's own credentials handoff was silently disabling voice on every launch
- User set a new SARVAM_API_KEY and asked why voice mode had no way to edit
  the schedule anymore. Root-caused rather than assumed: `/api/health`'s
  `api_key_configured` flipped between `true` (right after a fresh restart)
  and `false` (moments later, consistently) on the SAME process with the
  SAME `.env` -- not a config-loading bug (proved via a temporary debug
  probe written directly into `config.py`/`main.py`: `settings.sarvam_api_key`
  held the correct 36-char key, in the identical object, in the identical
  process, at the exact moment `/api/health` was reporting it as absent
  seconds later).
- **Actual cause**: `app/api/localstore.py`'s `POST /api/local/credentials`
  -- built when only Android was ever `jarvis_client_owned_data` (a packaged
  APK ships no real `.env`, so the client hands the backend its own stored
  key on every connect) -- unconditionally does
  `settings.sarvam_api_key = <whatever the client sent>`. Today's earlier
  change ([switch desktop to mobile's sync architecture]) made
  `jarvis_client_owned_data` true for DESKTOP too, which activated a
  frontend code path (`sendProviderKey()` in `agentBridge.ts`, called from
  `page.tsx`'s first-contact handshake, gated on exactly that flag) that
  desktop had never triggered before. Desktop's browser `localStorage` has
  never needed to hold a Sarvam key -- it always came from `backend/.env` --
  so it sends an EMPTY key, and the backend obediently overwrote its own
  correct, freshly-loaded key with blank, disabling voice
  (`has_api_key` -> false) within seconds of every single app launch, with
  no error surfaced anywhere. This is the same class of bug as the
  `jarvis_client_owned_data` vs `jarvis_android` overload fixed earlier
  today for `system_tools_enabled`/`scheduler_enabled` -- just a second,
  separate spot the same flag-overload reached that wasn't audited at the
  time.
- **Fix** (`localstore.py`, backend-only): `POST /api/local/credentials` now
  treats an EMPTY incoming key as a no-op when `not settings.jarvis_android
  and settings.has_api_key` -- i.e. "this browser has never stored one" is
  no longer indistinguishable from "the user wants it cleared," except on
  Android, where it still means exactly what it always has (blank input =
  clear, unchanged). A desktop user typing a real key into Settings'
  "Provider key" field still works exactly as before and takes priority --
  only a genuinely blank value is now ignored, and only when a working key
  is already active.
- Verified live end-to-end, twice, not just via the API: killed and
  relaunched the installed desktop app from a clean process state, waited
  well past the frontend's startup handshake window (12s), and confirmed
  `api_key_configured: true` and `voice/config`'s `enabled: true` held
  stable both times (previously it flipped to `false` within seconds, every
  time, reproducibly). Then opened the actual dev-server frontend in a
  browser and confirmed the "Talk to JARVIS / Start talking" voice launcher
  -- entirely ABSENT before the fix (that `enabled` flag is exactly what
  gates its rendering) -- now appears, and that opening voice mode renders
  its full HUD (mute/half-duplex controls, exit button) correctly.
- **Did not touch the schedule-editing UI itself** -- it was never broken.
  Traced `ScheduleSurface.tsx`'s `onEdit` -> `SurfaceLayer.tsx`'s
  `setEditing` -> the shared `RecordEditor` -> `updateEvent()` chain end to
  end and confirmed it was already fully wired for voice mode specifically
  (`SurfaceHost` at `placement="voice"` uses `z-[60]`, above VoiceMode's own
  `z-50` HUD; `RecordEditor` itself is `z-[100]`, above both). Also verified
  the backend tool this whole path calls, `update_schedule_event`, offline
  against an isolated fixture DB: matched an entry by name + weekday and
  applied a time change correctly (`"Updated #1 'Java Lab' [COLLEGE] Monday
  3:00 PM - 4:30 PM."`) -- the tool-calling path was never the problem
  either. The entire user-visible symptom ("no option to edit from voice")
  was fully explained by voice mode being disabled outright, with nothing
  in the UI to signal why.
- While investigating, also found and cleaned up 4 leftover test-fixture
  rows still sitting in the live Supabase project from the 2026-09-11
  test-pollution incident (3 "probe"-titled schedule ROUTINE entries, 1
  "probe"-titled idea) that the user had noticed as unexplained "random
  blocks" in their schedule/routines. Deleted properly -- inserted a
  matching `sync_tombstones` row for each before deleting, so a stale local
  copy on mobile cannot resurrect them on its next sync -- rather than a
  bare `DELETE`. User asked that this become standard practice going
  forward: clean up test/probe data in the same session it's found or
  created, rather than leaving it flagged for later. Saved as a memory
  (`clean-up-test-fixtures`) so future sessions do this by default.
- Checks: offline import check on the edited module; live restart-and-hold
  verification above (twice); offline `update_schedule_event` tool check;
  browser confirmation of the voice launcher appearing and the HUD
  rendering. Not yet re-verified against the packaged Android build (the
  Android carve-out in this fix is the untouched, previously-correct path,
  but a real on-device check would still be the honest way to confirm
  nothing there regressed).

### 2026-09-12 · Claude Code · Root-caused and fixed segment_test.py's flakiness
- User asked to investigate why `segment_test.py` had failed intermittently
  during this session's test runs (it was previously chalked up in an
  earlier session's notes to "the account ran out of credit during
  testing" -- true then, but not the whole story, as this investigation
  found).
- Reproduced by actually running it standalone rather than trusting the
  full-suite log: hit `PermissionError: ... jarvis_segment_test.db ...
  being used by another process` on the very first line. Traced the lock
  to two live `python.exe tests/segment_test.py` processes
  (`Get-CimInstance Win32_Process`) that had been running, unkilled, for
  ~40+ minutes since an earlier background full-suite run -- confirming a
  process from that EARLIER run was still stuck, not freshly hung.
- **Root cause**: `run_cases()`'s two websocket loops used
  `while time.time() < deadline: frame = socket.receive_json()`. Starlette's
  `WebSocketTestSession.receive_json()` is a plain blocking call with no
  timeout parameter of its own (confirmed via `inspect.signature` --
  it does not accept one) -- it blocks on an anyio memory-stream handoff to
  the app's own websocket handler. The `deadline` variable only gets
  re-checked BETWEEN calls; if the SINGLE call currently in flight never
  returns (a live-provider stall, or anything that stops the handler from
  ever sending another frame), the surrounding `while` loop's timeout is
  worthless -- confirmed exactly this shape live, not assumed from reading
  the code.
- Also root-caused why one hung run poisons every run after it: the file
  lock on the shared `jarvis_segment_test.db` from a stuck process
  survives until that process is killed, so any later invocation
  (including a perfectly healthy new run) fails at its very first line,
  before doing anything -- this is very likely why the same file used to
  show up as "flaky": one real hang early in a session, from a live-API
  stall, could make every subsequent run in that session fail identically
  for a completely different, secondary reason.
- **Fix** (test file only, no app code touched): added `_receive()` -- runs
  `socket.receive_json()` in a one-worker `ThreadPoolExecutor` and calls
  `future.result(timeout=...)`, so a hung call actually times out instead
  of blocking the surrounding loop forever. Both while-loops now pass
  `min(30, deadline - time.time())` per call instead of relying on the
  deadline alone, and treat a timeout as a clean, specific check failure
  ("server kept responding (no single frame hung)") rather than hanging.
  Also hardened the startup: unlinking a locked leftover temp db now falls
  back to a pid-suffixed path for this run instead of crashing before the
  test even starts, so one still-stuck process can no longer cascade-fail
  every run after it.
- **The underlying thread cannot be cancelled** -- a blocking socket read
  has no cooperative cancellation point -- so a timed-out `_receive()`
  leaves its worker thread blocked forever, same as before, just now
  isolated to one throwaway thread instead of the whole test. Since that
  thread is non-daemon, letting the process exit normally would have hung
  it anyway (the exact behavior just diagnosed). Fixed by calling
  `os._exit(code)` in `if __name__ == "__main__":` instead of a plain
  `raise SystemExit`, after flushing stdout -- deliberate use of a hard
  exit, same reasoning `tools_system.py`'s `_kill_tree` already documents
  for an unresponsive process: "the fallback still stops us waiting on it
  forever."
- Verified, not assumed: killed the two ~40-minute-old stuck processes,
  confirmed clean via `tasklist`, then ran the fixed file twice back to
  back -- both times all 5 checks passed AND the process count returned to
  baseline within 2 seconds of exit (no orphan), confirmed via `tasklist`
  after each run.
- Full backend suite re-run clean after the fix: **26/26 pass**, including
  `segment_test.py` itself and, notably, `reminder_lead_test.py` -- the one
  failure this session had been treating as pre-existing and unrelated.
  With the stuck processes and locked temp-db state gone, it now passes too;
  worth noting in case it resurfaces; it may have been a second symptom of
  the same resource contention rather than a genuine, separate bug.

### 2026-09-12 · Claude Code · Confirm-then-act gate on close_app/browser_submit
- Follow-up to the computer-control work below: user asked to build the
  permission-confirmation UI the `risk` field was added for (this session's
  own "recommended next step").
- Chose NOT to build a new UI component. Found the codebase already has the
  exact right shape, twice: `delete_record` and `tools_system.py`'s
  `run_command` both use a two-step "first call describes and does nothing,
  second call with `confirmed=true` acts" pattern -- no popup, no new
  frontend, the confirmation is just an ordinary assistant message the user
  answers in the same chat/voice turn. Reused it rather than inventing a
  second mechanism.
- Scoped the gate to exactly the two tools tagged `risk="high"`:
  `close_app` (kills a process -- unsaved work in it is gone instantly, no
  save prompt of its own) and `browser_submit` (the moment a form actually
  posts/searches/logs in/purchases -- squarely the "submitting a form",
  "sending a message" category this app's own top-level safety rules already
  require explicit permission for). Deliberately did NOT gate any
  `medium`-risk tool (click, type, navigate, toggle, hotkeys, clipboard
  writes, launch_app) -- `run_command`'s own confirmation list is a short,
  specific set of destructive patterns, not "every command", and a personal
  assistant that stops to confirm every ordinary click/type would not
  actually be usable. If a specific medium action turns out to need this in
  practice, the mechanism already generalizes; not preemptively applied
  everywhere.
- `tools_os_control.py`: added `CloseAppInput.confirmed: bool = False`; split
  `_close_app`'s target-resolution logic out into a new
  `resolve_close_targets()` (find what would be closed, without closing it)
  and `describe_close_targets()` (render the same way the real close
  reports), so the confirmation preview and the real close necessarily see
  identically resolved targets -- no risk of the preview describing one set
  of processes and the real action hitting a different one.
- `tools_browser.py`: added `BrowserSubmitInput(ElementRefInput)` with its
  own `confirmed` field (kept separate from the shared `ElementRefInput`
  click/get_text/type/etc. reuse, so the new field doesn't leak into tools
  that don't need it); added `describe_element()`, a thin public wrapper
  around the existing private `_resolve()` lookup, for the same
  "resolve-without-acting" reason -- and because it raises the same
  `ReferenceNotFoundError`/`StaleReferenceError` `_resolve` always has, an
  invalid element reference is refused with the normal clean error before
  the model is ever told to ask for confirmation on it.
- `tools.py`: `_handle_close_app` and a new dedicated `_handle_browser_submit`
  (replacing the generic `_computer_action(browser_submit)` one-liner, since
  this one needs branching logic the generic adapter can't express) both gate
  on `payload.confirmed` first. Both `ToolSpec.description`s and
  `input_schema`s updated so the model is told the two-step contract
  up front, not left to infer it from a runtime message alone.
- Verified this is not just "looks right" -- ran it: an unconfirmed
  `close_app` against a real running process (this venv's own python.exe)
  returned `CONFIRMATION REQUIRED` and left it running; the identical call
  with `confirmed=true` against a disposable spawned process (`ping -t`)
  actually terminated it (`"Closed: PING.EXE (pid ...)"`); an unconfirmed
  `close_app`/`browser_submit` with no valid target (nonexistent process
  name, a made-up `[eN]` reference) returned a plain error, not a
  confirmation prompt -- confirming the "refuse invalid targets before
  offering to confirm" ordering actually holds and doesn't ask the user to
  confirm something that could never have happened anyway.
- Checks: the offline `execute_tool` script above; `smoke_test.py`,
  `system_tools_test.py`, and `computer_control_test.py` re-run clean
  (100/100, 24/24, all pass) after the change; full backend suite re-run
  with no new failures beyond the pre-existing `reminder_lead_test.py`.
- Updated `docs/computer-control.md`'s risk-categorization section (now
  documents the actual gate, not just the field that used to sit unused) and
  its known-limitations/future-extension-points sections accordingly.
- **Not built, still open**: a visible in-UI confirmation card. The gate
  currently produces plain chat/voice text, matching `delete_record`/
  `run_command`'s existing convention exactly -- reasonable to leave as-is
  unless it proves insufficient in practice.

### 2026-09-12 · Claude Code · Agentic computer control (UI Automation, browser, OS-level)
- User: implement structured computer control for JARVIS -- Windows UI/
  accessibility control, browser DOM control, native OS automation -- as a
  full production-quality feature, not a proof of concept, with an explicit
  "do not ask me questions, make the engineering decisions yourself" mandate.
  Inspected the existing `tools.py`/`tools_system.py` architecture first
  (`ToolSpec`/`ToolOutcome`/`execute_tool` dispatch, lazy heavy-dep imports so
  Android/Chaquopy never pays for desktop-only deps, `capability="system"`
  gated by `settings.system_tools_enabled`) and built on it rather than
  inventing a parallel system.
- **New modules** (`backend/app/llm/`): `tools_automation_common.py` (shared
  `ElementRegistry` -- generation-stamped `[e1.3]` references, replacing
  screenshots/coordinates with structured lookups that go stale automatically
  when re-inspected rather than resolving against a moved table);
  `tools_ui_automation.py` (pywinauto/Windows UI Automation: list/focus
  windows, inspect, find, click, set/get text, press key, toggle, select,
  scroll, expand/collapse, window actions); `tools_browser.py`
  (Playwright/Chromium: open, navigate, inspect, find, click, type, submit,
  get text, current URL, title); `tools_os_control.py` (psutil/pywin32:
  list/close processes, launch apps, open paths, send hotkeys, clipboard
  get/set). New deps in `requirements.txt`: `pywinauto`, `pywin32`, `psutil`,
  `playwright` (+ `playwright install chromium`, ~300MB, done in this venv).
  27 of ~45 written functions registered as `ToolSpec`s in `tools.py` --
  deliberately not all of them, matching the project's own documented
  "salience contagion"/prompt-bloat lesson and the `GetDashboardSummaryInput`
  precedent; unregistered functions (`ui_scroll`, `ui_expand_collapse`,
  `ui_window_action`, multi-tab browser mgmt, file upload) exist and work,
  just aren't in the model's tool list yet. Added `risk: low|medium|high` to
  `ToolSpec` for a future permission gate -- structure only, no enforcement
  UI built (out of scope per the task, and the user's own standing "optimize
  for working now, not production hardening" instruction).
- **Real bugs found via live testing, not assumed correct from reading code**:
  (1) `pywinauto`'s `UIAWrapper` (from `.children()`) has no `.exists()`
  method -- only `WindowSpecification` does; fixed the liveness check in
  `_resolve()` to use `.is_visible()`, verified it correctly returns `False`
  after a real window close. (2) `type_keys()`'s default `pause=0.01`
  corrupted text on modern Windows 11 Notepad's "Document" control (which has
  no `set_edit_text`) -- found via a direct byte-for-byte comparison test;
  fixed at `pause=0.03`, and `ui_set_text` now reads back what it wrote and
  fails loudly if it doesn't match, rather than trusting the write succeeded.
  (3) The original `ElementRegistry.get()` misclassified never-issued
  references as stale due to string-prefix parsing; fixed with a persistent
  `_ever_issued` set that survives table resets, so "never existed" and
  "existed, but superseded" get correctly different error messages -- this
  distinction was explicitly requested (model should know whether to give up
  vs. re-inspect). (4) Playwright 1.62.0 (the installed version) has removed
  `page.accessibility.snapshot()` -- confirmed via `AttributeError`, not
  assumed from training data; switched to `locator.aria_snapshot()` (a
  YAML-like text format) with a new regex line-parser (`_ARIA_LINE`) since
  it's text, not a traversable dict. (5) A clipboard `try/finally:
  CloseClipboard()` executed even when the preceding `OpenClipboard()` itself
  had raised, producing a misleading masking error ("Thread does not have a
  clipboard open") instead of the real cause -- found via
  `smoke_test.py`'s "no handler raised" probe; fixed with
  `_open_clipboard_with_retry()` (5 attempts, 0.05s apart -- clipboard
  contention from other processes is routine and brief on Windows) called
  BEFORE the try/finally, so close only ever runs after a confirmed open.
- **Data-safety check performed before trusting `close_app`'s test coverage**:
  `computer_control_test.py`'s Notepad scenario launches Notepad, types into
  it, then calls `close_app(name_contains="notepad", all_matches=True)`. A
  pre-existing, genuinely unsaved "*students.txt - Notepad" window (real user
  data, not created by the test) kept appearing in `ui_list_windows` output
  during test runs and would have matched that same close call. Verified,
  rather than assumed, that this was safe: `Stop-Process`-killed the process
  and relaunched Notepad -- Windows 11's modern Notepad has its own local
  session-restore/autosave independent of process lifetime, and the
  "*students.txt" tab came back intact. No data was destroyed by testing,
  but flagging this for whoever runs this test suite next: it does forcibly
  terminate every Notepad-titled window it finds, and relies on Notepad's own
  recovery feature as the safety net, not on the test itself being gentle.
- **`computer_control_test.py` (new, 24 checks)**: TEST 1/4 (launch Notepad
  via the OS tool, not a UI click -> inspect -> find the editor -> set text ->
  read back exactly what was typed -> close), TEST 5 (a never-issued
  reference raises `ReferenceNotFoundError` with an actionable message; a
  reference superseded by a later inspection raises `StaleReferenceError`),
  TEST 3 (list windows -> focus Calculator -> inspect its real structure),
  TEST 2 (open a real browser session -> navigate to example.com -> inspect
  the accessibility tree -> find a link -> read its text -> click it ->
  verify the URL actually changed). All 24 pass when no other window with an
  ambiguous matching title (e.g. another "Notepad") is already open on the
  machine.
- **Found and diagnosed, not chased further, a real environment limitation**:
  with a pre-existing "*students.txt - Notepad" window open, `ui_inspect`'s
  substring window-title match landed on that window instead of the freshly
  launched blank one, and `ui_set_text` failed with `SendInput() inserted
  only 0 out of 2 keyboard events`. Root cause: Windows blocks a background/
  non-foreground process from injecting keystrokes via `SendInput` into a
  window that isn't the true OS foreground window -- confirmed reproducible
  (failed identically on a second run with the same ambiguous window
  present) and confirmed NOT a code defect (passed cleanly, 24/24, once no
  ambiguous same-titled window was open, i.e. the target window could
  actually receive focus). This is a genuine platform constraint on any
  SendInput-based automation running from an automated/background shell, not
  something `ui_set_text`'s own logic can work around -- `ui_focus_window`
  should generally precede text entry for this reason. Documented in
  `docs/computer-control.md` as a known limitation rather than silently
  retried away.
- Wrote `docs/computer-control.md` (concise, per the task's own "not huge
  unnecessary documentation" instruction): why three modules instead of one,
  the reference-registry mechanism, risk categorization, exactly which 27
  functions are registered as tools and which ~18 exist but aren't, how the
  model picks a tool (description-driven, same as every other JARVIS tool,
  no separate router), example tool calls, and the limitations above.
- Checks: full backend suite green except `computer_control_test.py`
  (environmental, see above -- passes cleanly with a clean window state) and
  `reminder_lead_test.py` (pre-existing, unrelated -- confirmed in an earlier
  session via `git stash`, not re-litigated here).
  `smoke_test.py` extended with wiring probes for `list_processes`,
  `ui_list_windows`, `clipboard_get`, plus a documented
  `_NOT_SAFE_TO_PROBE` exclusion list for the remaining new tools (disruptive
  side effects, or requiring a live element reference the smoke test can't
  manufacture safely). Backend-only change; the Tauri desktop app spawns this
  same backend from source (confirmed earlier this session, see the sync-
  architecture entry below), so no rebuild should be required, but a live
  desktop-build confirmation was not separately performed this pass.
- **Not built, out of scope for this pass, listed here so it isn't
  rediscovered as new work**: the permission-confirmation UI the `risk`
  field exists for; a macOS/Linux OS-control backend; wiring the remaining
  ~18 unregistered functions into the tool list when a real use case needs
  them.

### 2026-09-12 · Claude Code · Desktop switched to mobile's sync architecture; backend engine removed
- User: desktop sync 'seems past one', asked to remove it fully and adopt
  mobile's approach instead. Before touching anything, surfaced a real risk
  to the user rather than guessing: `jarvis_client_owned_data` was also
  standing in for 'is this Android' in `system_tools_enabled` and
  `scheduler_enabled` -- flipping it for desktop would have silently
  disabled desktop's shell/file/web tools and its reminder scheduler. User
  chose the full switch anyway, decoupling done properly first.
- Added `jarvis_android` (config.py), set only by Android's own
  `jarvis_server.py` entry point. Rekeyed `system_tools_enabled`,
  `scheduler_enabled`, and `memory.py`'s `refresh_markdown_vault` early-
  return onto it instead of `jarvis_client_owned_data`. Verified via two
  fixed tests (`scheduler_test.py`, `system_tools_test.py` -- both
  previously simulated 'mobile' via the OLD flag alone and started failing
  the instant it stopped disabling things on desktop; updated both to
  assert the new, correct behavior: client-owned-data desktop keeps tools
  and scheduler, `jarvis_android=true` still turns them off).
- `main.py`'s lifespan already had the exact right conditional
  (`if client_owned_data: log and skip; else: start the engine`) -- setting
  `JARVIS_CLIENT_OWNED_DATA=true` in `backend/.env` was the ENTIRE
  activation step for the architecture switch itself. Removed the dead
  branch that used to start `sync.run_forever()`.
- `app/services/sync.py`: was a 482-line, carefully-built two-way engine
  (documented conflict resolution, tombstones, watermark semantics --
  genuinely good code, not what was actually broken). Trimmed to just
  `SYNC_COLUMNS`, the one piece `app/api/localstore.py`'s seed/drain bridge
  still needs. Deleted `tests/sync_test.py` (482 lines, tested the removed
  engine specifically) and confirmed no other file referenced the removed
  symbols (`grep` for `SupabaseAdapter`/`StorageAdapter`/`run_forever`/etc
  across app/ and tests/, clean).
- New `GET /api/local/sync-bootstrap` (localstore.py, gated by the existing
  `_require_client_owned()`): hands the frontend the Supabase URL/service
  key already sitting in `backend/.env` on this same machine, once, only
  when the client's own localStorage is still empty (never overwrites a
  value the user changed later). Android's bundled backend has these blank
  by design, so it returns nothing there and mobile's existing manual
  Settings entry is untouched -- confirmed this is the correct behavior,
  not a new one, by checking `jarvis_server.py` never sets them.
- Frontend: `syncClient.ts` gained `bootstrapSupabaseConfig()` (fetch-once,
  seed localStorage, fall through silently if the backend has nothing or
  isn't up yet); `useSync.ts`'s init effect now awaits it before deciding
  whether to start `startAutoSync` -- restructured from a sync effect to an
  async IIFE inside the effect since a React effect callback itself cannot
  be async, with the `alive` guard preserved.
- **Root-caused a false negative during verification**: manually starting a
  test backend and hitting `/api/health` initially showed
  `client_owned_data: false` and the new endpoint 404'd, even after the
  `.env`/code edits were saved. Diagnosed rather than assumed correct: found
  port 8000 was held by an ORPHANED Python subprocess (PID from `C:\Program
  Files\Python313\python.exe`) left over from launching the Tauri desktop
  app earlier that session and never cleaned up when its window closed --
  confirms the desktop app spawns its own backend as a child process from
  the SAME source tree (not a frozen/bundled copy, unlike Android's
  Chaquopy build) and does not reliably kill it on window close. Killed it,
  restarted a clean instance, then both checks passed.
- **Verified live, full round trip**: with a clean backend + a fresh dev-
  server frontend tab (empty IndexedDB, no localStorage), watched
  `localStorage` get auto-seeded with the real Supabase URL/key, the sync
  banner go idle -> 'Syncing...' -> gone with a 'Connected' status dot, and
  the Schedule view populate with the SAME real data
  (Monday, 16 plans, 3x 'probe' at 9:00 AM, 'Jarvis V4 update session',
  'Study block', 45 overlaps) the user's own desktop screenshot showed
  earlier this session -- a genuine pull from the real Supabase project via
  the client-side engine, not a mock.
- Checks: backend suite 24/24 (after fixing the two tests above). Frontend
  typecheck clean, all 5 frontend test files passing. Rebuilt the desktop
  Tauri app with this AND the two-pane shell change together (the shell
  change's own build had gone stale once these edits landed on top of it)
  and installed it.
- Left over from the OLD engine, deliberately not touched this pass:
  `jarvis_sync_enabled`/`jarvis_sync_interval`/`sync_configured` in
  config.py are now fully unused dead settings (nothing reads them any
  more), and several test files still defensively set
  `JARVIS_SYNC_ENABLED=false` (now a harmless no-op). Left alone rather than
  touching a dozen+ files for a purely cosmetic cleanup with no behavior
  change -- a reasonable target for a coordinated cleanup pass later, not
  urgent.

### 2026-09-12 · Claude Code · Desktop UI redesign, pass 1 (Rail nav + transition glitch)
- User: desktop UI 'sucks', 'some buttons are not even responsive', busy,
  typography too small. Asked to install a design-taste skill from
  github.com/Leonxlnx/taste-skill and use it, taking mobile as inspiration.
- Installed `taste-skill` and `redesign-skill` SKILL.md files into the
  personal skills directory (same place `ui-ux-pro-max` already lives).
  Invoked `redesign-skill` for this task -- it's the audit-first, 'improve
  what's there, don't rewrite' one, correct fit for an existing app rather
  than a greenfield landing page.
- Scanned before touching anything (per the skill's own sequence): the
  design tokens in globals.css ('Deep Field' palette) and the component
  system in product.css are actually carefully built, not generic AI slop
  -- documented contrast ratios, real hover/press/focus states, reduced-
  motion handling throughout. The complaint's real causes turned out to be
  two specific, findable things, not a wholesale redo.
- **Root-caused 'buttons not responsive' by actually running the app**, not
  just reading code (`preview_start` + Browser pane, 1440x900). First
  click-test attempt (click+screenshot with no wait) looked like a real
  bug -- clicks appearing to land one step late with garbled overlapping
  content. Redid it with explicit waits and direct DOM queries
  (`document.querySelector('h1').textContent`) after each click: the
  click handler and React state update are correct and immediate every
  time. What's real: `transitionUi()` (uiMotion.ts) uses the View
  Transitions API, and the old/new page pseudo-elements faded
  SIMULTANEOUSLY for ~180ms by default. Board/Schedule/Vault are
  structurally unrelated layouts (stats row + task list vs. weekday picker
  vs. card grid) captured as full-bleed snapshots at the same screen
  position, so that 180ms window showed two different pages' headings and
  banners visibly double-exposed -- which reads as broken to a user even
  though the underlying state was already correct.
- Fix: sequential handoff instead of a crossfade --
  `::view-transition-old(workspace)` now finishes (120ms) before
  `::view-transition-new(workspace)` starts (120ms animation-delay, 220ms
  duration). Same total duration (~340ms vs previous ~280-460ms depending
  how you count the overlap), no more simultaneous double-exposure.
  Verified the CSS rule actually loaded via a direct stylesheet query, not
  just by editing the file (Next dev/Fast Refresh can lag).
- **Rail redesign**: was icon-only, 76px wide, hover-tooltip is the only
  label. `MobileNav.tsx` already labels every destination and says why in
  its own comment: 'icon-only navigation is consistently the worst-
  performing pattern for discoverability.' Brought that same reasoning to
  desktop, which has width to spare: `--rail-w` 76px ->
  `clamp(196px, 15vw, 236px)`, rebuilt as labelled rows (icon + 'Task
  Board' / 'Schedule' / 'Notes & Ideas' / 'Settings', a visible 'JARVIS'
  wordmark at top, status label at bottom instead of an unlabeled dot).
  New CSS: `.rail-item`/`.rail-label`/`.rail-count` in product.css.
- Raised the smallest, least-legible text in the SHARED design system (used
  by both platforms): 9-10px eyebrows/meta labels
  (`.page-kicker`, `.focus-card-top` label, `.priority-pill`, `.note-type`,
  `.note-card-meta`, `.connection-indicator`, `.brand-wordmark > span`) ->
  11px (10px for the wordmark subtitle). Verified live at 375x812 that
  mobile is unaffected/still correct -- these rules are shared, not
  desktop-only.
- Investigated but did NOT find a real bug in: `Button`'s `expandHitArea`
  (`::before` expanded invisible hit-box, on by default, never opted out
  anywhere in the codebase per a full grep) -- flagged as a real geometric
  risk in dense button clusters (the code's own comment warns about it),
  but no component currently packs `Button`s close enough to actually
  overlap; Rail's nav buttons turned out to be plain `<button>`s, not the
  shared `Button` component, so they were never at risk. Left as a
  documented non-finding rather than 'fixed' -- worth a second look if a
  future pass adds a dense button toolbar.
- Checks: TypeScript typecheck clean. Live-verified in the Browser pane:
  1440x900 (Rail navigation, all three views settle correctly, verified via
  DOM queries not just screenshots) and 375x812 (mobile, confirmed
  unaffected). No console or build errors. Not yet built for the Tauri
  desktop bundle -- this was verified against the Next.js dev server,
  which is what the shipped desktop app also renders, but the actual
  Tauri window has not been launched this pass.
- **Deliberately scoped -- this is pass 1 of the user's own 'one by one'.**
  Chat.tsx, TaskTable.tsx, ScheduleBoard.tsx, NotesWorkspace.tsx and their
  product.css rules were audited (read in full) but not changed this pass:
  they still use the original visual language (small-caps eyebrows, dense
  metric rows, icon-only micro-controls in places). The app is now
  visually inconsistent between the upgraded Rail/shell and the
  not-yet-touched workspace panes, until a follow-up pass reaches them.
  Reasonable next targets, in rough priority order: (1) TaskTable/
  ScheduleBoard/Notes typography and density pass using the same taste-
  skill criteria, (2) entrance/stagger motion on list items per taste-
  skill's guidance (currently only `card-arrive`/`page-arrive`, no
  staggering), (3) the `expandHitArea` overlap risk noted above if any new
  dense button cluster gets added, (4) an actual Tauri desktop build to
  confirm parity with the dev-server verification done here.

### 2026-09-12 · Claude Code · Deterministic JARVIS_IDENTITY_INTENT, ahead of the LLM
- New `app/services/identity.py`: a regex classifier (`detect_special_intent`)
  for 'who/what are you', 'introduce yourself', 'who made/built/created
  you/jarvis', 'what is jarvis', 'what kind of assistant are you' -- matched
  even mid-sentence (`re.search`, not `match`). Deliberately keyword/pattern
  matching over an embedding classifier, same reasoning `surfaces.py`
  documents for panel intent: runs on every turn on the latency path, so it
  has to be free, and a missed match costs nothing (the model can already
  answer 'who are you' itself) while a false match is the only real risk --
  every pattern is anchored to 'you'/'jarvis' as the object and excludes the
  given false-positive shapes ('who are you calling/talking about', 'what
  are you doing/working on/thinking about') via negative lookahead.
- `JARVIS_IDENTITY_INTRODUCTION` -> named `JARVIS_INTRODUCTION` in code
  (matches the file's own naming: `identity.py` module, so
  `identity.JARVIS_INTRODUCTION` reads cleanly) -- one triple-quoted
  constant, verbatim from the spec, the only place this text exists.
- Wired into `agent.run_turn`, positioned AFTER
  `memory_service.capture_inferred_candidate(user_text)` and BEFORE
  `surfaces.detect`/`get_chat_provider`/history load: this ordering is load-
  bearing, not arbitrary -- 'My name is Rahul, who are you?' must still
  teach JARVIS the name via the existing memory-candidate path even though
  the question itself short-circuits before the model ever sees it. On a
  match: yields one `text` event with the canonical string, persists it to
  `chat_messages` via the same `_assistant_message`/`append_chat_message`
  path a normal reply uses (so history/follow-ups work identically), yields
  a `done` event with `stop_reason: 'stop'` (matters for `chat.py`'s SSE
  wrapper -- without an explicit `done`, its own fallback sends
  `stop_reason: 'error'`, which is the wrong signal for a successful
  canned answer), then returns -- skipping `surfaces.detect`, history load,
  the provider call, and the whole tool loop entirely.
- Applies uniformly to typed chat (`chat.py`), voice (`realtime.py`), and
  the sentinel daemon endpoint (`sentinel.py`) -- all three only ever
  consume `run_turn`'s `text`/`done`/`error` events, confirmed by reading
  all three call sites before writing the change, so no caller-side code
  needed touching. Voice mode's existing sentence-chunking/TTS pipeline
  (`_first_chunk`/`_split_sentences` in `realtime.py`) runs on the canonical
  text exactly as it would on live LLM output -- the intro's line breaks
  double as its own sentence boundaries via the existing `
+` split rule,
  so it is spoken with the same short-line pacing it was written in, with no
  special-casing needed in the TTS path.
- **Audio pre-cache: investigated, not implemented.** Would only help
  desktop Piper -- Android's on-device voice is entirely client-side (see
  the streaming-Piper entry above), unreachable from a server-side cache --
  and would need the introduction's audio pre-split at the SAME chunk
  boundaries the streaming pipeline computes live, or delivered as one
  blob (re-introducing the whole-phrase-before-any-audio latency the
  streaming-Piper fix just removed same day). Does not cleanly fit the
  current architecture per the task's own condition; not built. The
  latency goal that mattered (skip the LLM round trip) is already met.
- Modularity: `identity.py`'s `SpecialIntent(name, matches, response)` +
  `_INTENTS` tuple is set up so a future canned intent (capabilities,
  creator/founder info, privacy, help, demo) is one more tuple entry --
  `run_turn` only ever asks 'does anything match', nothing else changes.
- Tests: `identity_intent_test.py` (89 checks, offline, pure regex --
  every MUST/MUST-NOT example from the spec verbatim, plus embedded-in-
  sentence, case-insensitivity, and empty/None-input edges) and
  `identity_turn_test.py` (9 checks, offline, throwaway DB, chat provider
  replaced with one that raises AssertionError if called at all -- proves
  the bypass is real, not just that the regex matches; also proves an
  ordinary turn is completely unaffected). Both pass. Full backend suite:
  all green except `reminder_lead_test`'s past-instant-reminder case, which
  fails identically with this change stashed out (`git stash` + rerun,
  confirmed before assuming it was mine) -- pre-existing, unrelated, not
  touched.
- Backend-only change (no frontend/Android files touched); rebuilt and
  installed on the Android device since Chaquopy bundles Python source at
  build time. Not yet confirmed by voice on the device.

### 2026-09-12 · Claude Code · On-device Piper 'parts parts' -- investigated and fixed
- User report: English voice on Android played a short opener then a long
  silent gap, then rushed through the rest -- worse on medium/long replies,
  fine on short ones. Suspected wrong: not an LLM-chunking issue -- proven by
  measuring the phone's native Piper pipeline directly via CDP, independent
  of the LLM/server entirely.
- Root cause #1 (fixed): `SherpaTts.synthesize` built a whole phrase's audio
  in one call before any of it could be delivered. Measured on-device: a
  short opener (1.9s audio) followed by a 190-char phrase left 4.1-4.3s of
  dead air waiting for the second phrase to finish building.
- Root cause #2 (fixed): even after switching to per-sentence streaming
  (`maxNumSentences=1` + `generateWithCallback`), phrases were still
  processed by ONE worker, so phrase N+1 could not start building until
  phrase N's entire text was done -- left ~1.1s of dead air at the same
  boundary. Moved to a 3-slot thread pool (2 inference threads per job, up
  to 6 of 8 cores) so phrases build concurrently. Verified this is safe
  before shipping it: fetched the sherpa-onnx v1.13.8 VITS source --
  `Generate()` only reads model state, never writes it -- and ONNX Runtime
  documents `Session::Run` as safe for concurrent calls on one session.
  Cut the gap to 0-0.6s across repeated on-device runs (down from 4.1-4.3s).
- Also fixed while in this code: the old per-request synth timeout (12s)
  counted time spent QUEUED behind other phrases, not just synthesis time,
  so a phrase late in a long reply could time out before its turn even
  started, silently dropping it and truncating the reply. Replaced with a
  stall detector (`nativeTts.ts` `STALL_MS=20000`) that only fires if the
  native worker produces nothing at all for 20s, and a synthesis failure now
  costs only that one phrase (caption still shown) instead of aborting the
  rest of the spoken reply.
- **Incident during this work, self-caused, worth flagging for whoever reads
  this next:** while measuring gaps live via CDP against the user's actual
  running phone, one of my probe scripts overwrote
  `window.__jarvisTtsChunk`/`__jarvisTtsDone`/`__jarvisTtsError` -- the SAME
  global hooks `nativeTts.ts`'s `installHooks()` wires up for the real app --
  and didn't restore them. `installHooks()` guards on a module-level
  `hooksInstalled` flag and never re-runs, so once those globals are
  clobbered from outside, the running page has no way to get them back: every
  English phrase after that point built audio successfully on-device but had
  nowhere to deliver it, so the user heard nothing. User reported "voice is
  not coming from it" mid-session; root-caused via Runtime.exceptionThrown
  in the CDP log (`Cannot read properties of undefined (reading 'pieces')`
  inside my OWN leftover test hook, firing on the real app's request id),
  fixed by restarting the app (resets the JS context). **Lesson: never leave
  global delivery hooks overwritten on a device the user may be actively
  using -- always save/restore them (see `measure_piper_stream.py`'s
  pattern), or better, don't probe a live user session at all when a
  standalone check would do.**
- Separately noticed and NOT caused by this work: the device hit 99.6C on 4
  of 8 cores (thermal throttled to ~55-66% of max clock) after many back-to-
  back on-device synthesis measurement runs. This likely explains some of the
  run-to-run variance in the later gap measurements (0s in one run, 1-2s in
  another with an identical config) and may have contributed to the audio
  going quiet, on top of the hook-clobbering bug above. Let the device cool
  before doing further heavy on-device TTS benchmarking.
- **User-confirmed on the real device**, after the concurrency fix and the
  app restart that cleared the clobbered hooks: "almost 90% of times now
  jarvis is continuously speaking." Pushed to main at the user's request
  without chasing the remaining ~10% further this session.
- **Left open, not investigated:** the remaining ~10% of turns that still
  have some gap. Candidates worth checking first, in rough priority order:
  (a) whether it correlates with reply length (a reply with 4+ phrases still
  queues once all 3 pool slots are busy -- not measured), (b) thermal state
  after sustained real use (see above -- not isolated from the fix itself
  yet), (c) whether the 3-pool-slot config is actually optimal or was chosen
  under confounded (thermal-affected) measurements -- the last on-device A/B
  before the incident showed HIGHER variance for 3 slots/2 threads than for
  2 slots/3 threads on the same medium-reply test, which may or may not
  survive re-measurement on a cool device.

### 2026-09-11 · Claude Code · Voice stuck in 'Working on it': upstream outage + failover
- User report: after the transcript, voice mode never produced a reply.
  Cause is upstream, not the reasoning-effort changes: `sarvam-105b-conversations`
  (still listed by /v1/models) timed out on every request -- streaming and not,
  with and without tools -- while `sarvam-105b` answered the same prompt in
  ~1.2s. The old pre-output fallback retried the SAME model, so turns hung.
- Fix in `providers/sarvam.py`: override model gets 12s + 1 attempt, then fails
  over to the configured model and is bypassed for 180s (`_resolve_model`,
  `_mark_override_down`). Also fixed: the old fallback dropped `reasoning_effort`.
  Live: first turn ~14s, later 0.6-0.8s. STT measured unaffected.
- Note: `backend/.env` pins `SARVAM_REASONING_EFFORT=low`, so the earlier
  config-default change to `""` only affects Android (no .env there).
- `segment_test` hung in 3 of 4 runs with this change (passed once, in 8s) and
  passed the one run without it. A faulthandler stack dump of the last hang
  showed STT returning `402 No credits available`: the session sets `halted`,
  `end_turn` never sends `turn`, and the test's `receive_json()` has no
  timeout, so it blocks forever. The earlier hangs had STT 200s; their cause is
  undetermined because credits ran out mid-investigation. The failover itself
  is covered offline by `model_failover_test.py`.
- **Sarvam credits are exhausted** (402 on chat and STT, 2026-09-11 ~21:33).
  Repeated full-suite runs this session (several test files hit live Sarvam)
  were a large part of that. No chat/STT/Sarvam TTS works until it is topped up.
- Update after the user topped up: the conversations model answers again
  (0.62s non-stream, first stream line 0.42s). The earlier timeouts were most
  likely the balance running low -- that model hung while sarvam-105b still
  returned 200, then both returned 402. Treat a conversations-model timeout as
  a possible credit problem first.
- Left: confirm by voice on-device; consider switching back only if the
  conversations model recovers (the cooldown re-probes it every 180s).

### 2026-09-11 · Claude Code · STT realtime WebSocket: measured, not built
- User asked to implement Sarvam's realtime STT WebSocket (the PDF's #1 lever)
  after the reasoning-effort work. Before writing any integration code,
  probed the LIVE endpoint (project's own standing lesson: Sarvam docs have
  been wrong before) -- and they were wrong again: the fetched docs said
  `saaras:v4-realtime` is a valid model; the live endpoint rejects it with
  `invalid_model`, accepting only `saaras:v3-realtime` and plain `saaras:v4`.
  Full protocol otherwise confirmed working end-to-end with a real
  Piper-synthesized clip: session.begin -> vad.speech_start -> transcript.
  partial (repeated) -> vad.speech_end -> more partials -> transcript.final
  (exact correct text) -> session.end.
- Then MEASURED rather than assumed whether switching would actually help
  JARVIS's real architecture (`compare_stt_latency.py`, 3 clips, live API):
  REST /speech-to-text (current path) settles to ~0.38-0.39s once warm;
  realtime WS manual-endpointed micro-utterances over a persistent
  connection measured ~0.42-0.48s -- SLOWER, not faster, for this pattern.
  Confirmed `get_stt_provider()` is `@lru_cache`d (process-lifetime
  singleton), so the one slow first call (1.05s, cold TLS/connection) is a
  one-time cost per backend process start, not something a real conversation
  repeatedly pays.
- **Why realtime WS doesn't help here**: its real advantage (transcription
  overlapping with speech, so text is nearly ready the instant the user
  stops) requires the CLIENT to stream raw PCM continuously while the mic is
  open. JARVIS's client instead captures a complete pause-delimited WAV
  segment locally (its own tuned VAD/two-tier listening/stop-word system)
  and sends it once finished -- `on_segment()`'s docstring already explains
  this was deliberately designed to take transcription 'off the critical
  path... by the time they stop, everything but the last segment is already
  text.' Realtime WS on an already-fully-captured clip gets none of the
  streaming benefit and pays its own overhead instead.
- **Not implemented.** A real win would need rebuilding the CLIENT to stream
  continuous raw PCM instead of discrete WAV segments, replacing JARVIS's
  own VAD/stop-word detection with Sarvam's server-side VAD (or running both
  and reconciling) -- a major rewrite of the input pipeline risking the
  half-duplex/stop-word/language-follow behaviors this project has already
  spent real effort tuning, for a benefit the measurements above don't
  support for the current architecture. Told the user directly rather than
  building it anyway or silently skipping it.

### 2026-09-11 · Claude Code · Audited against an external 'low-latency voice
  pipeline' architecture PDF the user sent
- Cross-checked every recommendation against the real code before changing
  anything. Most of the pipeline already matches it: persistent per-session
  WS, streaming LLM, a deterministic sentence chunker with first-chunk bias
  (MAX_CHUNK_CHARS=320 vs the PDF's suggested 120-200 -- kept ours, it was
  deliberately raised earlier this session after smaller chunks cut mid-
  sentence and sounded broken), Piper loaded once at startup via the Python/
  Kotlin API (never per-utterance CLI) on both platforms, turn/generation-
  based barge-in cancellation, bounded queues (SpeechPipeline semaphore=2),
  streaming PCM (no WAV round-trip on the incremental path), markdown/ID/
  ISO-date stripping before TTS, and P50/P90/P99 + TTFA metrics already
  recorded (voice_metrics.py) and exposed (`GET /api/voice/metrics`).
- Fixed (safe, aligned, tested): `sarvam_reasoning_effort` default was
  `"low"` (inherited from the v2.1.5 baseline, not a deliberate fix) ->
  `""` (disabled), matching Sarvam's documented fastest mode for ordinary
  turns and cutting cost. Added one line to the voice prompt for currency/
  number speakable-form (times were already covered in detail). Full
  backend suite still 22/22.
- **Deliberately NOT implemented** -- flagged to the user, not silently
  skipped:
  - Switching STT to Sarvam's realtime WebSocket (the PDF's #1 lever).
    JARVIS currently does its own client-side VAD/segmentation ("two-tier
    listening protocol") then one REST `/speech-to-text` call per finished
    utterance -- a different, already-tuned architecture, not a bug. Real
    measured STT latency is already ~0.75-0.95s. Replacing it with Sarvam's
    server-side VAD would be a major rewrite of the input pipeline, not a
    clean addition.
  - AEC + never-muted mic for barge-in. The PDF explicitly recommends
    against muting the mic during playback -- this DIRECTLY CONTRADICTS the
    user's own explicit half-duplex decision from earlier this session
    ("we need to mute the mic until jarvis completes its [turn]", see
    Decisions above). Did not touch it.
  - Per-turn reasoning-effort routing (escalate only hard turns). Real
    feature, needs a classifier/heuristic; proposed as a follow-up, not
    built blind.

### 2026-09-11 · Claude Code · INCIDENT: tests leaked into live Supabase
- While running the full backend suite, `segment_test.py` (and, it turned out,
  4 other files) triggered the REAL app lifespan via `TestClient`, which starts
  the real sync loop against whatever's in backend/.env -- the LIVE Supabase
  project -- because none of them set JARVIS_SYNC_ENABLED=false. Each isolates
  its LOCAL SQLite db (a temp file) but that doesn't stop sync from pulling
  real remote data into it and pushing/deleting based on the test's own churn.
- Exposed files (confirmed via `grep -l 'TestClient(' tests/*.py`, cross-
  checked for JARVIS_SYNC_ENABLED): integration_test.py, latency_test.py,
  records_test.py, segment_test.py, smoke_test.py. bulk_delete_test.py and
  others don't use TestClient -- not exposed.
- Observed live: real DELETE calls to Supabase tasks/schedules/memories/ideas
  during a segment_test.py run (confirmed via its own log output).
- **Fixed**: added `os.environ["JARVIS_SYNC_ENABLED"] = "false"` right after
  each file's JARVIS_DB_PATH line (same isolation pattern the safe tests
  already use for the scheduler). Verified: re-ran all 5 -- zero Supabase
  mentions in their output now, all still pass.
- **Data-loss assessment** (queried the live project directly with the
  service key from backend/.env): oldest memories trace to 2026-08-13, oldest
  schedules to 2026-08-14, with plausible real titles (college routine,
  'Renew the domain' tasks aside). Row counts (tasks 38, schedules 81,
  memories 29) are HIGHER than earlier-in-day snapshots, consistent with
  continued real growth, not loss. No evidence of real-data destruction, but
  this is not a substitute for a real backup -- told the user directly.
- **Confirmed test-pollution rows now sit in the live project** (fixture
  titles: 'Renew the domain'/'Renew the domain name', 'Read the Anthropic
  docs', 'wiring probe', 'probe', 'probe-that-does-not-exist', 'tombstone
  probe', 'File the tax return' in tasks; more ambiguous ones in schedules/
  memories, e.g. 'Dentist', 'Meeting preference' -- NOT deleted without the
  user's go-ahead, since some titles are plausible enough to be real.
- **Do not run the backend test suite on this machine without this fix in
  place.** Any NEW test file that uses TestClient/imports main MUST set
  JARVIS_SYNC_ENABLED=false, or it inherits this exact exposure.

### 2026-09-11 · Claude Code · Fixed live sync PGRST102 crash (mobile)
- User hit 'sync failed 400 ... sync_tombstones' live on-device. Traced via
  CDP over adb (forwarded the WebView devtools socket, replayed the exact
  failing request): PostgREST `PGRST102 'All object keys must match'`.
- Root cause: `applyRemoteTombstone` stored a PULLED tombstone verbatim,
  including Supabase's server-assigned `synced_at`; a LOCALLY-created
  tombstone never has that field. `listTombstones()` returns both shapes
  from the same store, and an unprojected push mixing them gets the WHOLE
  batch rejected -- and since the watermark only advances on success, every
  later round fails identically forever. `pushRows` was already guarded
  against this exact case (see its `project()` comment); `pushTombstones`
  never got the same fix. Desktop/Python is naturally immune -- its SQL
  SELECT for tombstones names exactly 3 columns, structurally.
- Fix (frontend only): `localdb.ts` adds `projectTombstone()`; applied at
  write time in `applyRemoteTombstone` (keeps local storage clean) AND at
  push time in `syncClient.ts::pushTombstones` (defense in depth, matches
  `pushRows`'s existing pattern exactly).
- On-device confirmed: dumped the real IndexedDB tombstone store via CDP --
  31 pending tombstones stuck since the watermark froze at 2026-09-09
  09:39:30. Replayed the exact real payload against the live Supabase
  project and reproduced PGRST102 verbatim before the fix.
- Checked the ~80 much-older (August) tombstones below that watermark, which
  can never be retried by the current watermark design: sampled 4 of their
  target uids against the live `tasks` table -- all already gone. Not a
  ghost-data risk, just harmless local clutter (pre-dates the stuck window).
- Regression test added to `sync.test.ts`: a direct `projectTombstone` unit
  check, plus an integration scenario pushing a mixed pulled+local batch
  through a `FakeRemote` that now enforces the same all-keys-must-match rule
  PostgREST does. Verified the integration check actually catches the
  regression (temporarily reverted the push-time fix, confirmed it still
  passed only because the write-time fix alone already cleans the shape --
  i.e. defense-in-depth working as intended, not a weak test).
- Verified: full sync.test.ts 41/0 (incl. new checks); typecheck clean.
- **Not yet on the phone** -- fix is in source, the installed APK predates
  it. Ships in the next rebuild+install (bundled with the reminder feature
  and mobile Piper below).

### 2026-09-11 · Claude Code · Reminders: default 15-min early notice
- User: 'remind me I have class at 5pm' should notify ~15 min BEFORE, not AT,
  the time -- unless they say 'instant reminder', which fires at the exact
  moment only. Then: normal reminders should fire TWICE (early + exact); only
  instant fires once.
- Design: `_handle_set_reminder` (tools.py) now creates ONE row for an
  instant reminder, TWO for a default one -- an early row (due_at = target -
  REMINDER_LEAD_MINUTES(=15), clamped to now if the target is sooner) with
  `target_at` set to the real target, and an exact row (`target_at` NULL).
  Reuses the existing one-row-one-fire architecture (scheduler, native
  Android alarm sync) unchanged -- no dual-fire logic anywhere.
- Schema: `reminders.target_at` (nullable DATETIME), migration v7
  (`_v7_reminder_lead`, single ALTER TABLE, atomic). `crud.create_reminder`
  takes an optional `target_at`. `ReminderOut` exposes it.
- Fire-time message: `scheduler.py::_reminder_announcement_text` composes
  'In N minutes, at H:MM: <text>' from the ACTUAL due_at/target_at delta (not
  a hardcoded 15), so a clamped lead still speaks the right number.
  `nativeNotifications.ts::reminderAlarmBody` mirrors this exactly for the
  Android native alarm body (the path that actually notifies on mobile).
- Tool description/schema updated so the model knows to set `instant=true`
  only on explicit wording ('instant reminder', 'exactly then').
- Verified: full backend suite 21/22 (the 1 failure, behaviour_test, is a
  pre-existing LIVE Sarvam-quality check about Monday-schedule recitation --
  confirmed unrelated: touches none of prompts.py/agent.py, only reminder
  files). Frontend typecheck clean.
- **Not yet on the phone or exercised end-to-end** -- no dedicated new test
  file was added for the two-row creation logic itself (existing
  reminder_time_test.py only covers `_resolve_reminder_moment`); smoke_test's
  existing set_reminder probe still passes but doesn't check row count or
  target_at. Ships in the next rebuild+install; worth a manual on-device
  check (ask for a reminder, confirm two native alarms appear).

### 2026-09-11 · Claude Code · Fixed memory-search relevance bug
- `memory.py::_score` rewritten: lexical relevance decides a match; importance/
  confidence/recency only rank rows already relevant; fuzzy char-match is a
  tiebreak gated behind a shared word, phrase substring, or empty token set.
- Fixes: search_memory('zzzz-nothing') now returns nothing; unrelated memories
  no longer injected into every turn's state block.
- Telugu preserved (empty-token queries still fuzzy/substring match). The
  tokenizer shattering Telugu into single chars is still the separate medium
  issue (memory.py:57) — recall stays imprecise there, not worse.
- Verified: memory_system_test 15/15, smoke_test ALL PASSED, full backend suite
  22/22.

### 2026-09-11 · Claude Code · Android Piper setup script
- `backend/tools/android/setup_piper.ps1`: one command to fetch the two large
  binaries (gitignored) and place them for the Android build —
  `sherpa-onnx-1.13.8.aar` → app/libs/, and the `vits-piper-en_US-ryan-high`
  bundle (onnx+tokens+espeak-ng-data, the MAX tier) → app/src/main/assets/piper/.
  Idempotent; needs internet + curl + tar (Win10+ built-ins). URLs verified
  against the live GitHub releases (sherpa v1.13.8; tts-models).
- Voice is bundled in APK assets (works offline); the Kotlin engine copies
  assets/piper → filesDir/tts once on first launch. Updated
  docs/android-piper-tts.md to match (setup section + SherpaTts.provision).
- Still pending (needs build machine + phone): apply the doc's Gradle line +
  JarvisTts.kt + MainActivity registration + realtime.ts wiring, then
  `npm run android:install`. The script makes that the only remaining work.

### 2026-09-11 · Claude Code · Sync rebuilt (orchestration + UX)
- User: sync 'keeps loading', wants auto pull-on-open + secret background push,
  no manual button, on both platforms. Rebuilt the orchestration; kept the
  tested data model.
- Root causes found: (a) frontend `fetch` had NO timeout -> a flaky network
  hung the round forever = 'keeps loading'; (b) mobile never auto-pulled (the
  old `useSync` was manual button + on-hide only); (c) on mobile BOTH the
  Chaquopy backend AND the WebView synced to Supabase = two engines racing.
- Fixes:
  - `syncClient.ts`: `timedFetch` (15s AbortController) on every request;
    `pushOnce` (push-only); `startAutoSync` controller — pull on open, debounced
    push (2.5s) on each local change, 45s periodic pull, flush on background,
    round on foreground. Overlap-guarded; never throws.
  - `localdb.ts`: `onLocalChange` emitted from the two write funnels
    (`putRows`/`deleteRow`) so the pusher wakes on every edit. Pull-side merges
    do NOT emit (no push->pull->push loop).
  - `useSync.ts`: `useAutoSync({enabled,onPulled})` replaces the manual hook.
    `SyncBanner.tsx`: passive status only (no buttons); shows while syncing or
    on error, else nothing. `enabled` gates it to client-owned (mobile).
  - `main.py`: backend sync disabled when `client_owned_data`, so mobile has one
    engine (the client). Desktop unchanged (backend loop still syncs on boot +
    interval).
- Verified: frontend typecheck clean; `tests/sync.test.ts` 39/0;
  backend sync_test 39/0, records_test 46/0. smoke_test still fails only on the
  pre-existing memory-search bug (Open issues #1), unrelated to sync.
- Follow-up (low priority): the push defers while `window.__jarvisVoiceActive`
  is true, but VoiceMode does not set that flag yet. Pushes are tiny and async
  so impact is minimal; wire the flag around a turn when convenient.
- Not run on device (mobile not connected). Install when the user connects it.

### 2026-09-11 · Claude Code · Android Piper TTS (started)
- Decision confirmed: max Piper model (`en_US-ryan-high`) on desktop AND mobile.
- Chose the on-device path: **sherpa-onnx** (prebuilt arm64 AAR + Kotlin) runs
  the same ryan-high VITS weights on the phone; Chaquopy can't (no arm64 onnx
  wheel). Android's built-in TTS was rejected on quality after an A/B test.
- Shipped now (typechecks): `frontend/src/lib/nativeTts.ts` — the WebView client
  for a `window.JarvisTts` bridge. Inert unless the bridge exists, so desktop/web
  and un-provisioned Android fall back to Sarvam untouched. Produces PCM16 that
  drops straight into `SpeechQueue.push`.
- **Native half is written but NOT built here** (this session has no Android
  NDK/SDK/device): full drop-in spec in `docs/android-piper-tts.md` — the exact
  Gradle AAR line, `JarvisTts.kt` (sherpa-onnx OfflineTts, real API), the
  MainActivity registration, model/espeak-ng-data provisioning, and the
  realtime.ts/backend wiring (English-on-Android → client synth, text-only from
  server). I did NOT add the Kotlin/Gradle to the tree because the imports won't
  resolve until the AAR is placed — adding them now would break `npm run android`.
- **Next (needs a build machine + phone):** place the AAR + model, apply the doc's
  Kotlin/Gradle/wiring, then run the doc's verification checklist. Codex or a
  build-capable session can execute it directly.

### 2026-09-11 · Claude Code · Local English TTS (Piper)
- English replies are now spoken locally by Piper (`en_US-ryan-high`, the
  high-quality tier — the user asked for the heaviest model). Other languages
  stay on Sarvam. New engine `app/providers/piper.py`; routing in
  `app/services/speech.py::_provider_for`; getter
  `providers.get_english_tts_provider()`. Config: `JARVIS_ENGLISH_TTS`
  (piper|sarvam, default piper), `JARVIS_PIPER_MODEL`, `JARVIS_PIPER_PACE`.
- Warms at startup (main.py). Falls back to Sarvam per-utterance if the model
  or piper-tts is missing, so English never breaks.
- Model files are gitignored (120 MB). **Fetch them** (already on the user's
  desktop; any fresh machine runs this):
  ```bash
  cd backend && mkdir -p models/piper
  BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high
  curl -L -o models/piper/en_US-ryan-high.onnx      "$BASE/en_US-ryan-high.onnx?download=true"
  curl -L -o models/piper/en_US-ryan-high.onnx.json "$BASE/en_US-ryan-high.onnx.json?download=true"
  ```
- Measured on the dev CPU: RTF ~0.5 (5 s of audio in ~2.5 s), so it stays ahead
  of playback when streamed per sentence.
- Verified: `tests/piper_tts_test.py` (13 checks) + full backend suite pass in
  the desktop venv (smoke_test's memory-search check still fails — pre-existing,
  see Open issues). Not built into a desktop release yet; not run on-device.
- **MOBILE IS NOT DONE.** Android runs the backend under Chaquopy on arm64.
  Neither onnxruntime nor Piper's espeak phonemizer has an arm64/Android wheel
  on PyPI (this is why pydantic_core had to be hand-cross-compiled). So
  `pip install piper-tts` fails there and mobile currently falls back to Sarvam
  for English. Getting real Piper on mobile means one of: (a) cross-compile
  onnxruntime + espeak-ng for android arm64 and bundle a prebuilt wheel like
  pydantic_core, (b) use Android's native TextToSpeech via Kotlin (on-device,
  good, but not Piper), or (c) keep Sarvam for English on phone. Waiting on the
  user's choice before doing the heavy native work.

### 2026-09-11 · Claude Code
- Committed everything since v2.1.5 (both agents' work) as `3b4f9e3`.
- Session inside a routine no longer warns. smoke_test now also checks that a
  session over a college class still warns.
- Added `CLAUDE.md` (imports `AGENTS.md`), this file, and a `.gitignore` rule
  for `*.db.bak`.
- Audited Codex's changes. The results are the Open issues above. Backend: 19
  of 21 test files pass (smoke_test memory check, integration_test).
  Frontend typecheck is clean.
- Not started: any of the open-issue fixes.
