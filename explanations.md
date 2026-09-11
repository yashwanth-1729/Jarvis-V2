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
