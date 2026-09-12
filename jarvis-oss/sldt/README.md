# SLDT -- server-independent encrypted data synchronization

Status: **core sync engine plus persistence and network wiring; still no
app UI.** Stage 2 of the JARVIS open-source variant's sync layer. The
protocol (stage 1) now has a real IndexedDB persistence layer and a real
(unit-tested, not-yet-deployed) path to GitHub via
[`jarvis-oss/proxy/`](../proxy/README.md). Nothing here is wired into
`frontend/`, the desktop app, or an Android build yet.

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
  tests/            no framework -- manual check() harness, run with `npx tsx tests/<name>.test.ts`,
                    matching the convention already used by frontend/tests/*.test.ts
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

## What's explicitly deferred (not this stage)

- **Any UI or app wiring.** No desktop, Android, or frontend integration.
  No settings screen for pairing a device, entering a recovery code, or
  configuring the store.
- **BYOK for LLM/STT/TTS providers.** A separate piece of the
  open-source variant, not part of the sync layer.
- **Deploying the proxy, and any live round trip against real GitHub.**
  The proxy runs and is unit-tested locally (GitHub's API mocked); it has
  not been deployed anywhere, and no code in this repo has made a real
  request to api.github.com. That is the next verification step before
  any device relies on this path.
- **A `SldtClient` façade** that ties `browserStore.ts` + `githubClient.ts`
  + `sync.ts` + `identity.ts` together into the one call an app would
  actually make (pair a device, run a sync cycle, handle the result). Each
  piece exists and is tested in isolation; nothing yet composes them for
  an app to call.

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
```

## Maintenance and latest changes

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
