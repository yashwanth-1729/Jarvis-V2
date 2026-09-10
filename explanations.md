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

1. **Memory search returns unrelated memories.** At `memory.py:283` the
   SequenceMatcher term gives character-level credit ("nothing" vs "meeting"),
   which clears the 0.15 guard. Importance and confidence then add about 0.81,
   so the 0.62 floor never filters. Result: `search_memory` never says "nothing
   found", and `context.py` injects up to 8 unrelated memories every turn as
   "RELEVANT MEMORY". Fix: require real token/phrase overlap before the fuzzy
   term counts, and compare the floor against the pre-boost score. This fails
   the smoke_test check "no results handled cleanly".
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
