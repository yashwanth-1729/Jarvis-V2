# JARVIS open-source variant

An open-source edition of JARVIS's desktop and Android apps, sharing the
same UI (`frontend/`) as the paid version but replacing its Supabase-backed
sync with **SLDT** — encrypted, server-independent sync over a GitHub repo
you own — and (eventually) letting you bring your own LLM/STT/TTS API keys
instead of a bundled provider.

## Status

**Usable today, from Settings.** Open Settings → Sync backend → **SLDT
(GitHub)**. From there you can:

- Create a brand-new dataset (you'll get a recovery code — save it, it's
  the only way back in) or pair with one an existing device already made.
- Point it at a GitHub repo you own.
- Choose how this device writes to it: **Direct** (this device holds its
  own GitHub token — the right choice for desktop and Android, since it's
  your own app on your own device, the same trust level this app already
  gives a Supabase key here) or **Through a proxy** (for a hosted web
  build, where a page served to arbitrary visitors can't safely hold that
  token — see `proxy/README.md`).

The paid app's Supabase path is completely untouched and remains the
default — SLDT is opt-in per device.

## What's here

- **[`sldt/`](sldt/README.md)** — the sync engine itself: identity and key
  derivation, per-object encryption, a signed and tamper/replay-checked
  manifest, deterministic conflict resolution, IndexedDB persistence, and
  the client façade (`SldtClient`) everything above it is built on. Fully
  unit-tested, and separately verified with a real, live round trip
  against the actual GitHub API (see that README's "What the live round
  trip found" for the real bugs that surfaced along the way).
- **[`proxy/`](proxy/README.md)** — the one server-side component SLDT's
  design calls for, needed only for a web build: a small stateless service
  that holds a write-capable GitHub token so a browser page never has to.
  Not needed for desktop or Android.

## What's not built yet

- **BYOK for LLM/STT/TTS providers.** The other half of "open-source
  variant" — bring your own API keys instead of a bundled provider. Not
  started.
- **A hosted deployment of the proxy.** It exists and is tested, including
  live against the real GitHub API, but hasn't been deployed anywhere
  persistent — only needed once a web build exists.
- **Android/desktop-specific packaging.** The Settings UI and sync engine
  run in the same shared frontend all platforms already use, but the SLDT
  path specifically has only been exercised in the web dev build and a
  Node-based live-network test so far, not yet built into a signed
  desktop/Android release.

## Security notes worth knowing before you use this

- **There is no password reset.** The recovery code
  (`SLDT:<datasetId>:<secret>`) *is* the account. If you lose it, that
  dataset's data is unrecoverable by design — nothing about this protocol
  can help you if you lose it.
- **The recovery code's secret half is never written to disk.** Each
  device holds it only for the current app session (until you close the
  app, not just reload the page) and asks you to re-enter it after that.
  This is deliberate, not a bug — see `sldt/README.md`'s threat model
  notes for why.
- **This is single-user, multi-device sync**, not a multi-user
  collaboration tool. Two people editing the same record concurrently will
  have one edit silently overwrite the other (latest revision wins) — it
  is not a CRDT.
- **The GitHub repo you point this at should be one you're comfortable
  being technically public** (even if nobody but you knows it exists):
  everything in it is encrypted ciphertext, but repo names, commit
  timing, and rough object sizes are visible to whoever can see the repo.

## For contributors

Each subproject is a standalone TypeScript package with its own
`package.json`, tests, and README — see `sldt/README.md` and
`proxy/README.md` for how to run their test suites (all pure `npx tsx`,
no framework, no network calls except the explicitly-labeled live test in
`sldt/live-tests/`). Nothing here is wired into `backend/` or `native/`;
the only touch points into the shared paid-app frontend are
`frontend/src/lib/sldtRemote.ts`, `frontend/src/lib/sldtConfig.ts`, the
"Sync backend" section of `frontend/src/components/SettingsPanel.tsx`,
and two additive entries in `frontend/next.config.mjs` needed to resolve
this package's imports.
