# SLDT -- server-independent encrypted data synchronization

Status: **core sync engine, no UI wiring yet.** This is stage 1 of the
JARVIS open-source variant's sync layer -- a standalone, dependency-light
TypeScript library, unit-tested end-to-end, not yet connected to any
frontend, desktop app, or Android build.

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

## What's explicitly deferred (not this stage)

- **The stateless write proxy.** `GitHubStore` in `store.ts` is written
  against the real GitHub Contents API request/response shape, but the
  `request` function it calls is supplied by the caller -- no proxy
  server exists yet, and no live GitHub calls are made anywhere in this
  package or its tests (no credits, no network, matches this project's
  cost-sensitive testing convention).
- **Any UI or app wiring.** No desktop, Android, or frontend integration.
  No settings screen for pairing a device, entering a recovery code, or
  configuring the store.
- **BYOK for LLM/STT/TTS providers.** A separate piece of the
  open-source variant, not part of the sync layer.
- **Persistence of `SyncState`/local object sets.** By design: `sync.ts`
  takes the local object map and last-synced revision as plain
  in-memory arguments and hands back updated versions. Where a host app
  persists them (IndexedDB, SQLite, a file) is entirely its own
  decision -- this mirrors how `localdb.ts` owns persistence on the paid
  side while `syncClient.ts` only owns reconciliation.

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
npm test          # runs every tests/*.test.ts in sequence
npm run typecheck  # tsc --noEmit
```

## Maintenance and latest changes

- 2026-09-13: Initial scaffold. Core protocol (identity/KDF, crypto,
  manifest, conflict resolution, sync engine, in-memory + GitHub-shaped
  store) implemented and covered by `tests/*.test.ts`. No UI, proxy, or
  app wiring yet.
