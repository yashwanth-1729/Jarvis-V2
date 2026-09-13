# SLDT -- server-independent encrypted data synchronization

Status: **usable, end to end, from the app's own Settings screen.** Stage
6. Stages 1-5 built the engine, persistence, both network paths (proxied
and direct), a proxy, verified all of it live against the real GitHub API,
and built (but never wired up) a `Remote` adapter for the paid frontend --
see "What the live round trip found" below for the real bugs a live round
trip surfaced that no mock caught. Stage 6 is the activation: a "Sync
backend" section in the paid app's own Settings panel lets a user actually
choose SLDT over Supabase, generate or pair a dataset, and configure
either write path -- verified in a real browser, including a live (fake
credential, deliberately) network call surfacing its error cleanly through
the existing sync-status UI with no crash. See
[`jarvis-oss/README.md`](../README.md) for the project-level overview this
now supports, and "The settings UI" below for what was built and verified.

## What this is

SLDT lets two or more devices share encrypted application state (tasks,
notes, memory records) through objects stored on a publicly readable,
"dumb" object store -- in this proof of concept, a GitHub repository via
its Contents API -- without running a database or session server. The
store never sees plaintext, never holds a standing secret, and doesn't know
it's a sync backend: it only serves bytes by path and supports
compare-and-swap on write.

This is the open-source counterpart to the paid app's Supabase-backed
mirror (`backend/app/services/sync.py`, `frontend/src/lib/syncClient.ts`):
same job -- reconcile per-device local state across devices -- different
trust model. It does not replace or modify the paid app's Supabase path;
it is a separate implementation for the open-source variant living under
`jarvis-oss/`.

## Why TypeScript, and why here

The paid app's real sync engine already lives in the frontend
(`frontend/src/lib/syncClient.ts`, ported from a Python original that was
deliberately retired -- see that file's header comment), and both the
Tauri desktop build and the Android build run the same webview frontend.
A TypeScript library slots into that exact integration point on both
platforms with zero native code. It is intentionally decoupled from
`frontend/` for now (own `package.json`, own tests, no shared imports) so
the core protocol can be validated in isolation before anything wires
into it.

## Two ways to reach GitHub -- pick by trust model, not by preference

`githubClient.ts` exports two factory functions. Both return a plain
`Store`, so `SldtClient` (and everything above it) never knows or cares
which one it's holding -- the choice is made once, where the app decides
which environment its own code is running in.

- **`createGitHubStore({..., proxyBaseUrl})`** -- reads go straight to
  GitHub's public Contents API with no credential; writes go through the
  stateless proxy in `../proxy/`, which is the one place the GitHub PAT
  lives. Use this when the code holding the `Store` could be read by
  someone other than the person it belongs to -- concretely, **a web
  build**: a page served to arbitrary visitors cannot hold a write-capable
  secret without handing it to every one of them.
- **`createDirectGitHubStore({..., token})`** -- reads and writes both go
  straight to GitHub's Contents API, authenticated with a token the caller
  already holds. No proxy involved at all. Use this when the code is
  already running somewhere only its owner can read -- **desktop or
  Android**: this is your own app on your own device holding your own
  credential, the same trust level the paid app already gives the
  Supabase service key on desktop (`backend/.env`, no proxy in front of
  it; only Android's *bundled backend* blanks that key, specifically
  because an APK can be extracted and reverse-engineered, unlike a local
  desktop install or a value the user enters into their own running app's
  settings).

Neither option is "more correct" -- they answer different questions about
where the code runs. Picking the proxy path for desktop/Android would just
be an unnecessary moving part (a server to deploy and keep running) for a
threat model that doesn't apply there. See `githubClient.ts`'s own module
doc for the same reasoning in code, and `tests/githubClient.test.ts` for
both paths' request shapes verified with `fetch` mocked (no live network
needed to keep this covered -- the direct-write request shape itself was
also independently confirmed live during stage 4's `curl` debugging of the
proxy, which sends an identical authenticated `PUT`).

## Layout

```
sldt/
  src/
    identity.ts    datasetId/secret, recovery code, Argon2id KDF (hash-wasm), key domain separation
    crypto.ts       AES-256-GCM via Web Crypto, fixed-bucket padding, SHA-256, HMAC-SHA-256
    canonicalJson.ts  deterministic (key-sorted) JSON for anything that gets signed
    objects.ts      the per-object encrypted envelope, and its integrity hash
    manifest.ts     the signed, versioned index: sign/verify, replay/rollback detection
    conflict.ts     deterministic conflict resolution (revision, then deviceId -- never wall-clock)
    store.ts        the CAS storage abstraction: `Store` interface, `InMemoryStore`, `GitHubStore`
    sync.ts         the sync algorithm tying all of the above together
    errors.ts       distinct failure types (tamper, replay, corruption, wrong key, CAS conflict)
    browserStore.ts  IndexedDB persistence for the local object set, sync cursor, and non-secret identity
    githubClient.ts  wires `GitHubStore` to reality: proxied (createGitHubStore) or direct-write (createDirectGitHubStore) -- see "Two ways to reach GitHub" above
    client.ts        SldtClient: the one façade an app calls -- identity+persistence+engine composed
  tests/            no framework -- manual check() harness, run with `npx tsx tests/<name>.test.ts`,
                    matching the convention already used by frontend/tests/*.test.ts

frontend/src/lib/sldtRemote.ts   the paid app's own Remote interface, backed by SldtClient
frontend/tests/sldtRemote.test.ts  proves it against real localdb.ts rows + a raw SLDT peer
```

## What's implemented and tested

- Argon2id key derivation from a `datasetId` + `secret` identity, split
  into a domain-separated AES key and HMAC key.
- Per-object AES-256-GCM encryption with fixed-size padding buckets.
- A signed (HMAC), versioned manifest with hash-chaining to the previous
  manifest and replay/rollback rejection.
- A sync algorithm: pull remote changes, resolve conflicts against
  pending local edits deterministically, push local changes, CAS-update
  the manifest with bounded retry on a lost race.
- Tombstone deletes -- entries are never erased from manifest history, so
  a device that comes back online after a delete can't resurrect it.
- Corrupted or tampered objects are rejected without crashing the sync
  cycle; a bad manifest signature or a rollback attempt is a hard stop.

`tests/sync.test.ts` exercises all of the above end-to-end against an
`InMemoryStore` with several simulated devices sharing one identity.

- **IndexedDB persistence** (`browserStore.ts`) for the local object set,
  the sync cursor (`SyncState`), and non-secret identity (`datasetId`,
  `deviceId`) -- never the account `secret`. Runs unchanged in a browser
  tab, Tauri's webview, or an Android webview; tested under
  `fake-indexeddb` (`tests/browserStore.test.ts`), the same technique
  `frontend/tests/sync.test.ts` uses for `localdb.ts`.
- **Real network wiring** (`githubClient.ts`): `createGitHubStore()` reads
  directly from GitHub's public Contents API (no credential needed for a
  public repo) and routes writes through the proxy in
  [`jarvis-oss/proxy/`](../proxy/README.md). No live network calls are made
  anywhere in this package's tests -- this is source-level wiring, not yet
  exercised against the real GitHub API.
- **The stateless write proxy itself** now exists at `jarvis-oss/proxy/`:
  a single `POST /write` endpoint that holds the GitHub PAT, rejects any
  request body that isn't exactly `{path, content, sha, message}`,
  restricts writes to a configured path prefix, and never logs a value
  (only field names and byte lengths). See its own README for the full
  threat-model writeup, configuration, and what it deliberately does not
  guard against (no built-in caller authentication or rate limiting).

- **`SldtClient`** (`src/client.ts`): the façade an app actually calls.
  `SldtClient.create({identity, store, deviceId?})` derives keys, resumes
  (or starts) this device's persisted state, and generates/persists a
  device id if none is supplied. `.upsert()`/`.delete()`/`.get()`/
  `.listByType()`/`.listAll()` operate on the in-memory local set;
  `.sync()` runs one engine cycle and persists the result either way (even
  on failure, so queued local edits survive a crash mid-cycle).
  `tests/client.test.ts` composes it with real (faked) IndexedDB across
  simulated devices, including a restart that must resume rather than
  start over -- catching a real bug (the IndexedDB connection was cached
  per-module, so a naive "swap the global and reconnect" test setup would
  have silently kept talking to the first device's database).
- **`frontend/src/lib/sldtRemote.ts`**: `SldtRemote implements Remote` (the
  exact interface `frontend/src/lib/syncClient.ts` already uses for
  Supabase), backed by an `SldtClient`. Not imported by any existing file
  -- purely additive, proven with a real `next build` (see Frontend
  integration below) to show the app's shipping behavior is unchanged.
  `frontend/tests/sldtRemote.test.ts` runs it through the actual
  `syncOnce(remote)` call path against real `localdb.ts` rows, with a raw
  SLDT peer (bare `sync.ts` primitives, no IndexedDB) standing in for a
  second device -- push, pull, and delete in both directions. Building
  this adapter surfaced a real bug: caching the sync cycle's result only
  got invalidated inside `pushRows`/`pushTombstones`, which
  `syncClient.ts` skips entirely when nothing is locally pending, so a
  pure "nothing to push, just pull" round would silently replay a stale
  cached result and never actually pull new remote data. Fixed by also
  invalidating at `fetchTombstones` (the documented last call of a pull
  round), not just on push.

## Frontend integration

Two changes were needed in `frontend/` to make the cross-directory import
work at all, both additive and verified with a real `next build`
(temporarily via a throwaway route, since Next only compiles files that
are part of some page's module graph -- removed once the build was
proven, so no route or behavior changes shipped):

- `next.config.mjs`: `experimental.externalDir: true` -- off by default in
  Next, since it's usually a sign of an accidental monorepo path; here
  it's deliberate, and the only thing crossing the project boundary is
  `sldtRemote.ts`'s one import.
- `next.config.mjs`: a `webpack(config)` hook adding
  `resolve.extensionAlias: {".js": [".ts", ".tsx", ".js"]}`. `jarvis-oss/sldt`
  is authored with `.js`-suffixed relative imports pointing at `.ts` files
  (the standard convention for a package meant to run directly under
  Node's ESM loader or `tsx`, which is how its own tests already run) --
  webpack doesn't do that remap by default, so without this alias every
  internal import inside the sldt package fails to resolve the moment
  Next tries to bundle it.

Neither change alters resolution for any of the app's own existing
imports -- both are scoped to resolving paths that already reach outside
`frontend/` or specifically end in `.js`.

## The settings UI

`frontend/src/components/SettingsPanel.tsx`'s existing "sync" section now
has a **Sync backend** toggle: Supabase (default, exactly the prior
behavior) or **SLDT (GitHub)**. Selecting SLDT reveals:

- **Create new dataset** or **Pair** with an existing dataset's recovery
  code -- the code is shown exactly once on generation (there is no way to
  retrieve it again) and the user must dismiss it deliberately, not on a
  timer.
- GitHub repo / branch / path prefix fields.
- A **Direct** vs. **Through a proxy** choice for how this device writes
  (see "Two ways to reach GitHub" above), with the matching field (a
  GitHub token, or a proxy URL) shown underneath.

New supporting module: `frontend/src/lib/sldtConfig.ts`. Persists
everything above in `localStorage` -- the same trust level and mechanism
`syncClient.ts` already uses for the Supabase URL/key -- **except the
recovery code's secret half**, which lives in `sessionStorage` instead
(not a bare in-memory variable, and not `localStorage`): a bare variable
would be wiped by this panel's own existing `save()`, which unconditionally
reloads the page, meaning the very first thing that happened after
generating a new identity would be forgetting it again before sync ever
ran once. `sessionStorage` survives that reload but clears when the
tab/app actually closes -- "re-enter every time you relaunch the app," the
design's intended granularity, not "re-enter every time any setting
changes." `tests/sldtConfig.test.ts` (17 assertions) covers the full
lifecycle against a minimal in-memory storage polyfill (Node has no
`window` of its own).

`startAutoSync`/`AutoSyncOptions` in `syncClient.ts` gained one new,
optional field (`remote`) so a configured device can hand it an
`SldtRemote` instead of letting it default-construct a `SupabaseRemote` --
existing callers that don't pass it are provably unaffected (unchanged
guard, unchanged construction path when omitted). `useSync.ts` picks a
backend at the top of its existing effect based on `sldtConfig`'s stored
choice, with `needsSldtSecret` added to `AutoSyncState` so the UI can
distinguish "not configured" from "configured, but re-enter your recovery
code" -- the latter being the ordinary state right after almost every
reload, not an error.

**Verified in a real browser**, not just typechecked: started the actual
dev server, opened Settings, switched to SLDT, generated a real identity
(a genuine working recovery code appeared), filled in a repo and a
deliberately fake GitHub token, saved (reload survived, all fields and the
session unlock state persisted correctly), and watched the auto-sync
effect make a real request that failed with 401 -- surfaced as a clean
"Sync failed" banner through the exact same status pipeline Supabase
errors already use, no special-casing needed, no crash. Test data was
then cleared from the browser's storage before finishing.

## What the live round trip found

Ran the full chain for real: a throwaway public GitHub repo, a fine-grained
PAT (`Contents: Read and write`, scoped to that one repo), the actual
`jarvis-oss/proxy` server running locally, and `live-tests/githubRoundTrip.ts`
(not part of `npm test` -- makes real network calls, requires the env vars
documented in that file's header). Two devices, sharing one identity and
the one real repo: push, cross-device pull, delete, tombstone pull. All 8
assertions pass now, but getting there surfaced three real issues, none of
them things a mocked test could have caught:

1. **Fine-grained PATs can't create the first commit in a truly empty
   repository** via the Contents API (a documented GitHub limitation,
   confirmed by GitHub's own error: `"Resource not accessible by personal
   access token"` even with `Contents: Read and write` granted). Not a
   library bug -- fixed by seeding the test repo with one file through the
   GitHub web UI before the very first API write. Worth knowing before
   anyone else stands up a fresh repo for this.
2. **A lost manifest-CAS race during first-ever publish wasn't retried --
   it crashed.** `publishFirstManifest`'s own manifest write could lose to
   a manifest that was already there (a genuine two-devices-bootstrap race,
   *or* -- what actually happened live -- a `store.get()` returning a false
   "doesn't exist yet" because GitHub's Contents API read path can lag its
   own write path for a freshly created nested directory tree). The normal
   pull/push path already treated a lost CAS race as "retry the whole
   cycle"; the bootstrap path didn't. Fixed in `sync.ts`: a
   `ConcurrentWriteConflict` from `publishFirstManifest` now triggers the
   same retry. Added a regression test (`tests/sync.test.ts`) simulating
   exactly this stale-read shape against `InMemoryStore` -- no live network
   required to keep it covered.
3. **The retry loop had no backoff, and the default budget was too small
   for a real deployment's first sync.** Five retries with zero delay burn
   through in milliseconds; GitHub's real propagation lag for a brand-new
   nested directory needed several seconds. `syncOnce` now sleeps with
   exponential backoff (250ms&hellip;8s, capped) between attempts, and the
   default retry budget went from 5 to 8 -- this is a one-time cost per
   dataset (every sync after the first only ever touches paths that
   already exist), so it's worth spending real wall-clock time on rather
   than failing outright.
4. **A stale-but-not-missing read is invisible to the protocol, not just
   slow.** Unlike a lost CAS *write*, a manifest *read* that hasn't caught
   up yet doesn't error -- `attemptSync` just sees nothing new and
   completes normally with `pulled: []`. No amount of write-retry backoff
   fixes this, because nothing about that response looks wrong. This is a
   genuine, inherent characteristic of a storage substrate without strict
   read-after-write consistency, not something the protocol can detect or
   patch around. The live test's own mitigation --
   `syncUntilPulled()`, polling `sync()` again after a delay until the
   expected object shows up -- is exactly what any real deployment's
   periodic background pull already does; this just makes that pattern
   explicit instead of asserting on a single sync() call.
5. Also hit GitHub's unauthenticated rate limit (60 requests/hour) partway
   through debugging, purely from repeated manual `curl` checks -- not a
   library issue, just a reminder that iterating against the real API
   burns a real, small budget. The live test script authenticates its own
   reads with the same token used for writes to avoid this during
   development; production `githubClient.ts` is unchanged and still reads
   with no credential at all, matching the design.

## What's explicitly deferred (not this stage)

- **BYOK for LLM/STT/TTS providers.** A separate piece of the
  open-source variant, not part of the sync layer.
- **Deploying the proxy anywhere persistent.** It was run locally for the
  live test above and stopped afterward; there is no hosted, always-on
  deployment yet. Only matters once a web build exists -- desktop/Android
  use the direct path and never need it.
- **On-device verification.** The settings UI and both GitHub paths have
  been verified in the web dev build (a real browser, a real dev server)
  and in Node-based live tests, but not yet inside an actual built/signed
  Tauri desktop app or an installed Android APK. The code path is the same
  shared frontend either way, but "the same code" and "verified there" are
  different claims -- this repo's own documentation conventions ask that
  distinction be kept explicit.

## Threat model notes worth keeping visible

- There is no login and no password reset. The recovery code
  (`SLDT:<datasetId>:<secret>`) *is* the account. Losing it is
  unrecoverable by design.
- The secret must never be persisted to disk/localStorage by a caller;
  re-derive keys each session from a re-entered recovery code.
- This is single-user, multi-device sync. Latest-revision-wins silently
  drops one side's edit under true concurrent multi-user editing -- it is
  not a CRDT and must not be sold as one.
- The store operator still sees access patterns (write timing, rough
  object counts, size buckets even with padding). That's an accepted
  metadata side-channel, not something this design eliminates.
- **The protocol assumes the store's reads eventually catch up to its own
  writes, but not instantly.** Confirmed live against GitHub's Contents
  API: a read can serve stale-but-not-obviously-wrong state for several
  seconds after a write completes elsewhere. A lost CAS *write* race is
  detectable and retried automatically; a stale *read* is not detectable
  by the protocol at all (nothing about the response looks wrong), so
  catching up to a very recent remote change can require calling `sync()`
  again after a short delay rather than expecting one call to always see
  the latest state. Any deployment's periodic background sync already
  covers this in practice.

## Running the tests

```bash
cd jarvis-oss/sldt
npm install
npm test          # runs every tests/*.test.ts in sequence, 0 network calls
npm run typecheck  # tsc --noEmit

cd ../proxy
npm install
npm test          # handler logic only, GitHub's API mocked -- 0 network calls
npm run typecheck

cd ../../frontend
npx tsx tests/sldtRemote.test.ts   # SldtRemote through the real syncOnce() path, 0 network calls
npx tsx tests/sldtConfig.test.ts   # settings + session-secret lifecycle, 0 network calls
npm run typecheck
npm run build      # the real production build, with the Settings UI's SLDT section included
```

**Live test (real network, not part of the above):** requires your own
throwaway public GitHub repo (seeded with one commit -- see "What the live
round trip found" above) and a fine-grained PAT with `Contents: Read and
write`. See the header of `jarvis-oss/sldt/live-tests/githubRoundTrip.ts`
for the exact env vars and how to run the proxy locally first.

## Maintenance and latest changes

- 2026-09-13: Stage 6. SLDT is now reachable from the app itself: a "Sync
  backend" section in `frontend/src/components/SettingsPanel.tsx` (create
  or pair a dataset, pick a GitHub repo/branch/path prefix, choose direct
  vs. proxied writes), backed by a new `frontend/src/lib/sldtConfig.ts`
  (localStorage for everything non-secret, `sessionStorage` -- not a bare
  variable, not `localStorage` -- for the recovery code's secret half, so
  the settings panel's own reload-on-save doesn't immediately erase what
  the user just entered). `syncClient.ts` gained one optional field
  (`AutoSyncOptions.remote`) so a configured device can substitute an
  `SldtRemote` for the default `SupabaseRemote`; existing callers are
  unaffected. `useSync.ts` picks the backend from `sldtConfig` and exposes
  `needsSldtSecret` so the UI can tell "not configured" apart from "just
  needs its recovery code re-entered," which is the ordinary state after
  most reloads, not an error. Added `tests/sldtConfig.test.ts` (17
  assertions). Verified in a real browser (dev server, not just tsc):
  generated a genuine identity, filled in a repo and a deliberately fake
  token, saved through a real reload (everything persisted correctly,
  including the session-unlock state), and watched a real 401 from the
  live network call surface as a clean error banner through the exact
  pipeline Supabase errors already use -- no crash, no special-casing.
  Added a top-level `jarvis-oss/README.md` project overview, since this is
  headed for a public release. Full suite still green after this stage:
  `jarvis-oss/sldt` 92 assertions/8 files, `jarvis-oss/proxy` 15, and
  `frontend`'s `sync.test.ts` (43, untouched), `sldtRemote.test.ts` (13),
  `sldtConfig.test.ts` (17, new) all passing; `npm run build` succeeds.
- 2026-09-13: Stage 5. Added `createDirectGitHubStore` (`githubClient.ts`):
  reads and writes both go straight to GitHub's Contents API with a
  caller-held token, no proxy involved. Prompted by a direct question
  about whether the proxy is actually needed for desktop/Android -- it
  isn't; the proxy solves a browser-specific problem (a page served to
  arbitrary visitors can't hold a write secret), and desktop/Android are
  the app's own binary on its own device holding its own credential, the
  same trust level the paid app already gives the Supabase key on desktop.
  `SldtClient` needed zero changes -- it already only ever depended on the
  `Store` interface, so which network path a caller picks is entirely
  their own choice at construction time. Added `tests/githubClient.test.ts`
  (new -- this file had no unit coverage before, only the stage-4 live
  round trip), 16 assertions with `fetch` mocked, covering both paths'
  exact request shapes: unauthenticated proxied reads, the proxy's
  allowlisted write body, authenticated direct reads/writes, sha omitted
  on a brand-new object vs. included on an update, and a 409 surfacing as
  `ConcurrentWriteConflict`. Full suite now 92 assertions across 8 files,
  all still green; `npx tsc --noEmit` clean.
- 2026-09-13: Stage 4. Ran the full chain live: a real throwaway GitHub
  repo, a real fine-grained PAT, the actual proxy running locally, two
  simulated devices, no mocks. `live-tests/githubRoundTrip.ts` (not part of
  `npm test`) now passes all 8 assertions -- push, cross-device pull,
  delete, tombstone pull. Getting there fixed two real protocol bugs
  (`sync.ts`): `publishFirstManifest` losing its manifest CAS race used to
  crash instead of retrying like the normal path already does, and the
  retry loop had no backoff at all, with too small a budget for a real
  deployment's first sync against a store with any read-after-write lag.
  Added a regression test (`tests/sync.test.ts`, now 16 assertions)
  covering the crash scenario without needing live network. Also
  discovered and documented a *stale read* failure mode (distinct from a
  lost write race) that the protocol genuinely cannot detect -- see "What
  the live round trip found" above -- and adjusted the live test to poll
  like a real deployment's periodic sync would, rather than asserting a
  single `sync()` call always sees the latest state. `npm test` still
  green after the fixes across all packages (sldt: 76 assertions across 7
  files, proxy: 15, frontend's `sldtRemote.test.ts`: 13; the paid app's own
  pre-existing `sync.test.ts`, 43 assertions, untouched and still passing).
  Full diagnostic trail (empty-repo API limitation, a fine-grained
  PAT permission that needed re-saving, GitHub's unauthenticated rate
  limit) is in `explanations.md`'s log for this date.
- 2026-09-13: Stage 3. Added `SldtClient` (`src/client.ts`), composing
  identity/persistence/engine into the API an app calls, plus
  `frontend/src/lib/sldtRemote.ts` -- an unactivated, additive `Remote`
  implementation for the paid app's own `syncClient.ts`. Required two
  additive `next.config.mjs` changes (`experimental.externalDir`, a
  `resolve.extensionAlias` for this package's `.js`-suffixed imports),
  verified with a real `next build` via a temporary probe route (removed
  after proving it, so no route shipped). `npm test`/`npx tsx
  tests/sldtRemote.test.ts` all green (84 total assertions across both
  packages plus the new frontend test); existing frontend build, typecheck,
  and `tests/sync.test.ts` (43 assertions) all still pass unchanged. Found
  and fixed a real bug while building the adapter: a pull-only sync round
  (nothing locally pending) silently reused a stale cached result and never
  pulled new remote data, because cache invalidation only happened on the
  push side, which such a round never touches. No settings UI exists to
  actually choose SLDT yet -- see "What's explicitly deferred" above.
- 2026-09-13: Stage 2. Added `browserStore.ts` (IndexedDB persistence for
  local objects, sync cursor, non-secret identity -- tested under
  `fake-indexeddb`) and `githubClient.ts` (direct-read/proxied-write wiring
  for `GitHubStore`). Added `jarvis-oss/proxy/`, the stateless write proxy
  itself, unit-tested with GitHub's API mocked. No live network calls made
  anywhere; proxy not yet deployed; still no app/UI wiring or `SldtClient`
  façade tying the pieces together.
- 2026-09-13: Initial scaffold. Core protocol (identity/KDF, crypto,
  manifest, conflict resolution, sync engine, in-memory + GitHub-shaped
  store) implemented and covered by `tests/*.test.ts`. No UI, proxy, or
  app wiring yet.
