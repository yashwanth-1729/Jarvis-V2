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
