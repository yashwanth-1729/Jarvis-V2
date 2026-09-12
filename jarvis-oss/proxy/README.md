# SLDT write proxy

The one server-side component SLDT needs, per the design doc: browsers can't
safely hold a GitHub PAT, so this tiny stateless service holds it instead and
forwards only an allowlisted write shape to GitHub's Contents API. It never
decrypts anything, never inspects `content` beyond its byte length, and never
logs a value -- only field names/shapes, as an audit trail that the boundary
held.

Reads (`GET`) never go through this proxy -- `jarvis-oss/sldt/src/githubClient.ts`
calls GitHub's Contents API directly for those, since reading a public repo
needs no credential. This service handles `POST /write` only.

## What it guards against

- **A client that could name the destination repo.** It can't: `repo` and
  `branch` are fixed by this service's own environment variables
  (`GITHUB_REPO`, `GITHUB_BRANCH`), never read from the request body. A
  compromised or buggy client cannot redirect writes to a different repo the
  credential happens to reach.
- **A client sending anything beyond the exact allowlisted shape.** The
  request body must be exactly `{path, content, sha, message}` — an extra
  field of any kind is a 400, not silently ignored. This is the safety net
  against a client bug ever sending plaintext or an unexpected field through
  this path (`handler.ts::validateShape`).
- **Writing outside the sync namespace.** Every path must start with
  `SLDT_PATH_PREFIX` (default `sldt/`), and path traversal (`..`) is rejected
  even within that prefix, so this proxy cannot become a generic
  write-anywhere-in-the-repo relay (`handler.ts::isAllowedPath`).
- **Leaking GitHub's raw error responses.** A conflict (409/422) is passed
  through as a status code only, not GitHub's response body — see
  `tests/handler.test.ts`'s check that a conflict body never echoes GitHub's
  message text.

## What it does NOT guard against (by design, stated plainly)

- It does not authenticate the caller. Anyone who can reach this URL and
  guess/derive a valid recovery code's dataset can write ciphertext under
  that dataset's ids (SLDT's own manifest signature is what catches a
  forged/tampered write on the *read* side — see `sldt/src/manifest.ts`).
  Put this behind your own access control (a shared bearer token via
  `SLDT_ALLOWED_ORIGIN` + a reverse proxy, IP allowlisting, a serverless
  platform's built-in auth) if that matters for your deployment.
- It performs no rate limiting. GitHub's own API rate limits are the only
  backstop against abuse today.

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `GITHUB_TOKEN` | yes | -- | A PAT with `contents:write` on the target repo only. Never logged, never returned in any response. |
| `GITHUB_REPO` | yes | -- | `"owner/repo"`, fixed for this deployment. |
| `GITHUB_BRANCH` | no | `main` | Branch every write targets. |
| `SLDT_PATH_PREFIX` | no | `sldt/` | Path namespace this proxy will write to. |
| `SLDT_ALLOWED_ORIGIN` | no | unset (no CORS headers -- same-origin only) | Set to your app's origin if calling this proxy from a browser on a different origin. |
| `PORT` | no | `8787` | Listen port for the standalone server. |

## Running it

```bash
cd jarvis-oss/proxy
npm install
GITHUB_TOKEN=ghp_xxx GITHUB_REPO=youruser/sldt-data npm start
npm test          # handler logic only, GitHub's API mocked out -- no network, no credential needed
npm run typecheck
```

`src/server.ts` is a plain `node:http` server so it has no framework
dependency and stays trivially portable. `src/handler.ts` is the actual
logic and is framework-agnostic on purpose -- adapting it to a serverless
function (a Vercel/Cloudflare/Lambda handler) later is a matter of writing a
new thin entrypoint that calls `handleWrite`, not touching this file.

## Status

Implemented and unit-tested (`tests/handler.test.ts`, GitHub's API mocked).
**Not yet deployed anywhere or exercised against the real GitHub API** — no
live network calls have been made from this code. That's the next
verification step before any device relies on it.
