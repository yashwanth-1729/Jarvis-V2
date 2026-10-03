# HOLO gateway

The public edition's server. The phone never holds a provider key: its
on-device backend points `API_BASE` at this gateway instead of OpenRouter and
sends the user's **Supabase access token** as the bearer token. For every AI
call the gateway:

1. verifies the user;
2. checks the plan allows the feature;
3. reserves Aura;
4. forwards to OpenRouter with the server's own key;
5. settles the real cost and writes a usage row.

The plan behind it is [`docs/public-edition.md`](../docs/public-edition.md).

## Layout

| Path | What it does |
| --- | --- |
| `app/main.py` | App factory, CORS, error handlers, startup (DB, upstream pool, stale-hold sweep) |
| `app/proxy.py` | `/api/v1/chat/completions`, `/audio/transcriptions`, `/audio/speech`, `/key` |
| `app/accounts.py` | Accounts, monthly reset, plan expiry, reserve and settle, the ledger |
| `app/metering.py` | Price table, allow-list, usage to milli-Aura, WAV duration, Telugu detection |
| `app/auth.py` | Supabase JWT verification (HS256 secret and JWKS) |
| `app/plans.py` | The five plans, features, rate and daily limits |
| `app/account_routes.py` | `/v1/me`, `/v1/trial/lockin`, `/v1/admin/grant`, `/healthz` |
| `app/billing.py`, `app/play.py` | Play notifications; the purchase-verifier interface and its fake |
| `app/limits.py` | Rate limiter and body-size limit |
| `app/db.py` | Tables (SQLAlchemy core), SQLite or Postgres |
| `tests/` | Offline test suites |

## Run locally (Windows)

The gateway has its own venv; it never touches `backend/.venv`. On this
machine plain `python` is the Windows Store stub, so use `py -3.13`.

```powershell
cd D:\Jarvis-2.0\gateway
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env      # then fill in OPENROUTER_API_KEY and the Supabase values
.venv\Scripts\python.exe -m uvicorn app.main:create_app --factory --port 8080
```

`DATABASE_URL` defaults to a SQLite file, `gateway.db`, in this folder.
Tables are created at startup. Check it with `GET http://127.0.0.1:8080/healthz`.

## Tests

The tests are script-style, like the backend's. Each prints PASS/FAIL lines
and exits non-zero on a failure. They are **offline**:

- OpenRouter is an `httpx.MockTransport`;
- any Supabase/JWKS call fails the test unless the test serves a mock;
- Google Play is `FakePlayVerifier`;
- tokens are HS256 test tokens;
- each test gets SQLite in a fresh temp directory.

No provider credit is spent and no real record is touched.

```powershell
.venv\Scripts\python.exe tests\run_all.py        # all six suites
.venv\Scripts\python.exe tests\chat_test.py      # or one suite
```

| Suite | Covers |
| --- | --- |
| `auth_test.py` | Missing, expired, wrong-audience, bad-signature, `alg: none` and anonymous tokens; auto-created account; ES256 through a mock JWKS (cache, issuer, unknown kid) |
| `chat_test.py` | SSE pass-through byte-for-byte and in order; **no buffering** (the upstream pauses until the gateway has relayed chunk 1); settle from the final usage; non-streamed; allow-list → 400; upstream 400/401/402/unreachable; stream dropped midway → reserve; upstream cost wins when higher; web plugin dropped; `max_tokens` clamp; body limit |
| `aura_test.py` | 402 shape; plan bucket before top-up; overrun; monthly reset (with ledger rows); catch-up after a long absence; daily cap; concurrent holds; stale-hold sweep |
| `voice_test.py` | Voice blocked on Spawn, allowed on Side Quest; Telugu (language field, header, Telugu script) blocked below Main Character; TTS `language` stripped; per-second and per-character metering for all four audio models |
| `account_test.py` | `/v1/me` shape; Lock-in trial (3 days, once, gates `X-Holo-Feature: lockin`); admin grant auth, plans, top-up, refund and time-limited grants; rate limit; health; `/api/v1/key` |
| `billing_test.py` | Push-token auth; purchase → plan; redelivery dedupe; cancel; a stale token cannot downgrade; expiry → Spawn; unknown product; forged token; unlinked purchase; verifier outage → 503, then the retry is processed; top-up credited once per token |

To run the same suites against Postgres, set
`GATEWAY_TEST_DATABASE_URL=postgresql+asyncpg://…/holo_test`. **Every gateway
table in that database is dropped before each test**, so the database name
must contain `test`.

## Configure

Everything comes from the environment or `gateway/.env`; see
[`.env.example`](.env.example) for every key. The main ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | (none) | The server's key. Without it, the AI endpoints answer 503. |
| `SUPABASE_URL` | (none) | Enables JWKS (`/auth/v1/.well-known/jwks.json`, cached) and the `iss` check |
| `SUPABASE_JWT_SECRET` | (none) | Enables HS256 tokens. At least one of these two is required. |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | Required `aud` |
| `DATABASE_URL` | SQLite file | `postgresql+asyncpg://…` in production (`postgres://` is accepted) |
| `AURA_INR` / `USD_INR` | `0.10` / `88` | 1 Aura = ₹0.10 of provider cost |
| `ALLOWED_MODELS` | every priced model | Comma list |
| `MODEL_PRICES` | built in | JSON, merged per model |
| `PLAN_OVERRIDES` | none | JSON per plan: `monthly_aura`, `rpm`, `daily_cap_aura`, `name`, `price_inr` |
| `RESERVE_AURA_CHAT` / `_STT` / `_TTS` | `1.0` / `0.1` / `0.1` | Minimum balance to forward a request |
| `ADMIN_TOKEN` / `PLAY_PUSH_TOKEN` | empty, which disables the endpoint | Shared secrets |
| `PLAY_PRODUCT_PLANS` / `PLAY_TOPUP_PRODUCTS` | `holo_side_quest`… / `holo_aura_150: 150` | Play product ids |
| `CORS_ORIGINS` | the three Tauri origins | The app's WebView origins |

### Default price table (USD)

| Model | Endpoint | Rate | Source |
| --- | --- | --- | --- |
| `openai/gpt-6-luna` | chat | $0.10 in, $0.01 cached in, $0.50 out per 1M tokens | OpenRouter list price |
| `x-ai/grok-stt-1.0` | STT | $0.00003 per second, at least 1 s | Measured a median of $0.0000277 per 1.5–4 s utterance. The rate is set above both that and the "~$0.10/hour" in the backend config. |
| `openai/gpt-transcribe` | STT | $0.0001 per second, at least 1 s | gpt-4o-transcribe's list price, as a placeholder. Not measured. |
| `hexgrad/kokoro-82m` | TTS | $2.4 per 1M characters | Measured: median call $0.000025 |
| `x-ai/grok-voice-tts-1.0` | TTS | $57 per 1M characters | Measured: median call $0.000375. It speaks Telugu and Hindi. |

## Deploy (one Mumbai VM)

```bash
cd gateway
cp .env.example .env   # OPENROUTER_API_KEY, SUPABASE_*, POSTGRES_PASSWORD,
                       # GATEWAY_DOMAIN, ADMIN_TOKEN, PLAY_PUSH_TOKEN
docker compose up -d --build
docker compose logs -f gateway
```

`docker-compose.yml` runs three services:

- **Postgres 17**, with no published port;
- **the gateway**, one uvicorn worker on `127.0.0.1:8080`, non-root, with a health check;
- **Caddy** for TLS on 80/443. It fetches the certificate for `GATEWAY_DOMAIN` itself and flushes every chunk, so SSE and audio stream through.

Point the domain's A record at the VM first.

**Google Play notifications:**

1. Create a Pub/Sub topic and grant `google-play-developer-notifications@system.gserviceaccount.com` the Publisher role.
2. Set the topic in Play Console under Monetization setup.
3. Add a **push** subscription to `https://<domain>/v1/billing/play?token=<PLAY_PUSH_TOKEN>`.

Play verification itself is a TODO (see below). Until it exists the endpoint
answers 503, so Pub/Sub keeps the notifications and retries them.

**Supabase:** use the public edition's own project. The gateway accepts both
its legacy HS256 secret and its asymmetric signing keys.

## API contract for the app

**Base URL:** `https://<gateway>/api/v1`, in place of `https://openrouter.ai/api/v1`.
Only the host and path prefix change. Payloads and responses are OpenRouter's.

**Headers on every call:**

```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
X-Holo-Language: te            (optional; the language for the Telugu gate)
X-Holo-Feature: lockin         (optional; the gateway checks the plan has it)
```

| Endpoint | Body | Gate | Metered by |
| --- | --- | --- | --- |
| `POST /api/v1/chat/completions` | OpenRouter chat; `stream` true (SSE) or false | Allow-listed model; `X-Holo-Feature` if sent | `usage` from the body or final SSE chunk (forced on) |
| `POST /api/v1/audio/transcriptions` | `{model, input_audio: {data, format}, language?}` | `voice_en`; `voice_te` if `language` (or the header) is `te`/`te-IN` | Audio seconds: the WAV header, or the provider's `usage.seconds` |
| `POST /api/v1/audio/speech` | `{model, input, voice, response_format, speed, language?}` | `voice_en`; `voice_te` if `language` is `te`, the header says so, or the text is mostly Telugu script. `language` is stripped before forwarding. | Input characters |
| `GET /api/v1/key` | (none) | A valid token | Free. It answers the backend's warm-up ping locally. |
| `GET /v1/me` | (none) | A valid token | Free |
| `POST /v1/trial/lockin` | (none) | Once per account | Free |
| `POST /v1/billing/play` | Pub/Sub push | `PLAY_PUSH_TOKEN` | (none) |
| `POST /v1/admin/grant` | `{user_id, plan?, days?, topup_aura?, refund_aura?, note?}` | `X-Admin-Token` | (none) |
| `GET /healthz` | (none) | (none) | (none) |

### Errors

Every refusal the gateway itself makes has one shape. It matches OpenRouter's
`error.message`, so the backend's existing error parsing shows the text:

```json
{"error": {"code": "insufficient_aura", "status": 402,
           "message": "Not enough Aura: this needs about 1 and you have 0.4. Top up, upgrade or wait for your plan Aura to refill on 03 Nov.",
           "aura_balance": 0.4, "aura_required": 1.0, "plan": "spawn",
           "refills_at": "2026-11-03T06:00:00+00:00", "upgrade_available": true}}
```

| Status | `code` | App action |
| --- | --- | --- |
| 400 | `model_not_allowed` (with an `allowed` list), `invalid_request`, `invalid_json`, `input_too_long` | A bug in the app |
| 401 | `missing_token`, `token_expired`, `invalid_token` | Refresh the Supabase session and retry once, then sign in |
| 402 | `insufficient_aura` | Show the top-up or upgrade sheet |
| 403 | `feature_locked` (`feature`, `required_plan`), `anonymous_not_allowed` | Show the plan lock |
| 409 | `trial_used` (with the `trial` state) | Already used |
| 413 / 415 | `body_too_large` / `unsupported_media_type` | |
| 429 | `rate_limited` (`retry_after`), `daily_cap_reached` (`resets_at`) | Back off. Both send `Retry-After`. |
| 502 | `upstream_auth`, `upstream_unreachable` | Try again |
| 503 | `upstream_out_of_credit`, `gateway_not_configured` | Try again later |

OpenRouter's own refusals (a 400 for a bad payload, a 429, a 5xx) pass through
unchanged in OpenRouter's shape. The exceptions are its 401/403 and 402: those
are about the gateway's account, so they become the 502/503 above. Relayed
as-is, they would look like the user's sign-in or Aura failing.

If OpenRouter's stream breaks mid-answer, the client receives a final SSE event,
`data: {"error": {"code": 502, "message": "..."}}`, which is OpenRouter's own
mid-stream convention. A TTS stream that breaks is cut off instead, so the
download fails.

### `GET /v1/me`

```json
{
  "user_id": "3f0c…", "app": "HOLO",
  "plan": {"id": "side_quest", "name": "Side Quest", "price_inr": 99, "monthly_aura": 250,
           "source": "play", "expires_at": "2026-11-03T06:00:00+00:00"},
  "aura": {"balance": 248.7, "plan": 248.7, "topup": 0.0, "held": 0.0,
           "balance_milli": 248700, "plan_milli": 248700, "topup_milli": 0, "held_milli": 0},
  "features": {"chat": true, "voice_en": true, "lockin": true, "voice_te": false,
               "news": false, "autonomy": false, "early_access": false},
  "period": {"start": "2026-10-03T06:00:00+00:00", "end": "2026-11-03T06:00:00+00:00"},
  "trial": {"lockin": {"available": true, "active": false, "started_at": null, "ends_at": null}},
  "limits": {"requests_per_minute": 60, "daily_cap_aura": 60, "spent_today_aura": 1.3}
}
```

- `balance` is `plan + topup - held`; `held` is Aura reserved by calls still
  in flight. The `*_milli` fields are exact integers (1 Aura = 1000 milli).
- `features.lockin` is also true while the trial is active.
- `POST /v1/trial/lockin` returns this same body, or 409 `trial_used`.

### Linking Play purchases

When it launches a purchase, the app must call
`BillingFlowParams.Builder.setObfuscatedAccountId(<Supabase user id>)`. Play
notifications carry no user, so the verifier reads the user back from the
purchase.

## How metering works

- **Units:** balances are integer **milli-Aura**.
  `charge = ceil(cost_usd × USD_INR ÷ AURA_INR × 1000)`, rounded up, so a
  charge is never short. At the defaults, $1 = 880,000 milli, and a typical
  measured text turn (~₹0.049) is about 0.5 Aura.
- **Chat cost:** `(prompt − cached − cache_write) × prompt price + cached ×
  cached price + cache_write × cache-write price + completion × completion
  price`. When OpenRouter reports a higher `usage.cost` (a paid plugin, a
  price change), that is charged instead (`CHARGE_UPSTREAM_COST_IF_HIGHER`).
  The usage row keeps both.
- **Reserve, then settle:** before forwarding, the balance must cover the
  reserve; otherwise the gateway returns 402. Audio reserves
  `max(reserve, estimate)`. The reserve is a *hold*: it lowers the available
  balance, so concurrent calls cannot overspend, but it is not a ledger row.
  Settling releases the hold and spends the real cost:
  - a provider error or an unreachable provider costs 0;
  - a stream that ends with no `usage` costs the reserve;
  - TTS costs its characters once the provider has answered 2xx.

  A hold older than `RESERVATION_TTL_SECONDS` (the process died mid-call) is
  charged at its reserve and released, at startup and on the user's next request.
- **Buckets:** spending takes plan Aura first, then top-up. A call that costs
  more than both buckets hold leaves the plan bucket slightly negative. The
  next call then gets 402, and the overdraft is written off at the next reset.
- **Periods:**
  - Plan Aura resets to the allowance at each monthly period end, lazily on the
    next request. Two ledger rows record it: `adjust` (what expired) and `grant`.
  - Top-up Aura persists.
  - A store or time-limited plan drops to Spawn at `expires_at` plus
    `PLAN_EXPIRY_GRACE_MINUTES`. The grace leaves time for the renewal
    notification to arrive.
- **Tables:**
  - `accounts`;
  - `ledger` (append-only: `grant`, `spend`, `topup`, `refund`, `adjust`, with
    each bucket's delta and the balances after it);
  - `usage` (one row per call: tokens, seconds or characters, USD, INR,
    upstream cost, milli-Aura, reserve, status, generation id);
  - `reservations`;
  - `play_events` (Pub/Sub dedupe and audit);
  - `play_topups` (one credit per purchase token);
  - `schema_meta`.

## Limits

- **Per-user rate limit**, in requests per minute: Spawn 30, Side Quest 60,
  Main Character 90, Final Boss 120, God Mode 180. A voice minute is about
  20–25 gateway calls (STT, chat rounds, and one TTS call per sentence).
- **Daily spend cap**, in Aura per IST day: 25 / 60 / 150 / 300 / 1000.
- **Body size:** 8 MiB.
- **Output:** `max_tokens` is clamped to 4096; TTS input to 4000 characters.
- **Web plugin:** OpenRouter's paid web plugin is dropped unless
  `ALLOW_WEB_PLUGIN=true`.
- **Fallback lists:** requests with a `models` fallback list are refused.

## TODOs and known limits

- **Play verification:** `GooglePlayVerifier` is not written. The interface,
  the fake and the exact API calls are documented in `app/play.py`. Voided
  purchases are logged but not yet clawed back.
- **Push auth** uses a shared token in the URL. Pub/Sub's OIDC JWT is better
  and is noted in `app/billing.py`.
- **Rate limiter** is in process memory: correct for the one process this
  deploys. More processes or VMs need Redis behind the same `RateLimiter.hit()`.
  The daily cap and balances are already in the database.
- **STT language** is gated on the declared language. A client that sends
  Telugu audio declared as English is not caught. TTS also checks the script.
- **Play Integrity** checks against free-plan farming are not built.
- **`openai/gpt-transcribe`** is priced from list rates, not measured.
- **Not verified yet:**
  - Postgres/asyncpg (all tests ran on SQLite);
  - the Docker image build and compose deploy;
  - real Supabase tokens, OpenRouter and Google.
