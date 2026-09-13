# SLDT -- server-independent encrypted data synchronization

Status: **a tested, importable `Remote` adapter now exists for the paid
frontend -- not activated for any user.** Stage 3 of the JARVIS open-source
variant's sync layer. The engine (stage 1) has persistence and a real
(unit-tested, not-yet-deployed) path to GitHub via
[`jarvis-oss/proxy/`](../proxy/README.md) (stage 2), and now a `SldtClient`
façade composing all of it, plus `frontend/src/lib/sldtRemote.ts` -- an
`SldtClient`-backed implementation of `syncClient.ts`'s own `Remote`
interface. No existing file imports it; the shipping app's behavior,
verified with a real `next build`, is unchanged. Still no settings UI to
actually choose SLDT over Supabase.

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
    githubClient.ts  wires `GitHubStore` to reality: direct reads, proxied writes -- see jarvis-oss/proxy/
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

## What's explicitly deferred (not this stage)

- **Any UI to actually choose SLDT.** No settings screen for pairing a
  device, entering a recovery code, or configuring the GitHub repo/proxy
  URL -- `sldtRemote.ts` exists and works, but nothing in the app offers
  the user a way to construct one and pass it to `syncOnce`/`startAutoSync`
  instead of the default Supabase remote. That's a real product decision
  (a build-time flag? a runtime toggle alongside the Supabase settings?),
  deliberately not made here.
- **BYOK for LLM/STT/TTS providers.** A separate piece of the
  open-source variant, not part of the sync layer.
- **Deploying the proxy, and any live round trip against real GitHub.**
  The proxy runs and is unit-tested locally (GitHub's API mocked); it has
  not been deployed anywhere, and no code in this repo has made a real
  request to api.github.com. That is the next verification step before
  any device relies on this path.
- **Android/desktop-specific wiring.** The frontend adapter runs in
  whatever webview loads `frontend/`, so it should work unchanged on
  Tauri desktop and the Android build once activated -- but that has not
  been exercised on-device, only in the web build.

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
npm run typecheck
npm run build      # proves the app still builds with the adapter present but unimported
```

## Maintenance and latest changes

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
