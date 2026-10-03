"""Supabase token verification and first-sight account creation.

HS256 test tokens for the shared-secret path; a locally generated EC key
served through a mock JWKS endpoint for the asymmetric path. Offline.

    .venv/Scripts/python.exe tests/auth_test.py
"""

from __future__ import annotations

import json
import time

from _support import SECRET, Harness, auth, check, run

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from app.db import accounts, ledger


async def test_missing_and_bad_tokens() -> None:
    async with Harness() as h:
        r = await h.client.get("/v1/me")
        check("no Authorization header -> 401 missing_token",
              r.status_code == 401 and r.json()["error"]["code"] == "missing_token", r.text)
        check("401 carries WWW-Authenticate: Bearer", r.headers.get("www-authenticate") == "Bearer")
        check("error shape has code, status and message",
              set(r.json()["error"]) >= {"code", "status", "message"}, r.json())

        r = await h.client.get("/v1/me", headers={"Authorization": "Basic abc"})
        check("non-Bearer scheme -> 401 missing_token",
              r.status_code == 401 and r.json()["error"]["code"] == "missing_token", r.text)

        r = await h.client.get("/v1/me", headers=auth(exp_in=-3600))
        check("expired token -> 401 token_expired",
              r.status_code == 401 and r.json()["error"]["code"] == "token_expired", r.text)

        r = await h.client.get("/v1/me", headers=auth(aud="anon"))
        check("wrong audience -> 401 invalid_token",
              r.status_code == 401 and r.json()["error"]["code"] == "invalid_token", r.text)

        r = await h.client.get("/v1/me", headers=auth(secret="some-other-secret-0123456789abcdef"))
        check("bad signature -> 401 invalid_token",
              r.status_code == 401 and r.json()["error"]["code"] == "invalid_token", r.text)

        no_sub = jwt.encode({"aud": "authenticated", "exp": int(time.time()) + 600}, SECRET,
                            algorithm="HS256")
        r = await h.client.get("/v1/me", headers={"Authorization": f"Bearer {no_sub}"})
        check("token without sub -> 401", r.status_code == 401, r.text)

        unsigned = jwt.encode({"sub": "x", "aud": "authenticated",
                               "exp": int(time.time()) + 600}, None, algorithm="none")
        r = await h.client.get("/v1/me", headers={"Authorization": f"Bearer {unsigned}"})
        check("alg none -> 401", r.status_code == 401, r.text)

        r = await h.client.get("/v1/me", headers={"Authorization": "Bearer not.a.jwt"})
        check("garbage token -> 401 invalid_token",
              r.status_code == 401 and r.json()["error"]["code"] == "invalid_token", r.text)

        r = await h.client.get("/v1/me", headers=auth(is_anonymous=True))
        check("anonymous Supabase session -> 403 anonymous_not_allowed",
              r.status_code == 403 and r.json()["error"]["code"] == "anonymous_not_allowed", r.text)

        check("no account rows were created by refused requests",
              await h.rows(accounts) == [], await h.rows(accounts))


async def test_valid_token_creates_account() -> None:
    async with Harness() as h:
        r = await h.client.get("/v1/me", headers=auth("user-new", email="a@example.test"))
        check("valid token -> 200", r.status_code == 200, r.text)
        rows = await h.rows(accounts, user_id="user-new")
        check("account auto-created on first sight", len(rows) == 1, rows)
        row = rows[0]
        check("new account is on spawn", row["plan"] == "spawn", row)
        check("spawn grants 50 Aura (50,000 milli)", row["plan_milli"] == 50_000, row)
        check("top-up bucket starts empty", row["topup_milli"] == 0, row)
        check("email kept from the token", row["email"] == "a@example.test", row)
        me = r.json()
        check("period runs one calendar month", me["period"]["start"].startswith("2026-10-03")
              and me["period"]["end"].startswith("2026-11-03"), me["period"])
        grants = await h.rows(ledger, user_id="user-new")
        check("one grant ledger row of +50,000",
              len(grants) == 1 and grants[0]["kind"] == "grant"
              and grants[0]["plan_delta_milli"] == 50_000
              and grants[0]["plan_after_milli"] == 50_000, grants)

        await h.client.get("/v1/me", headers=auth("user-new"))
        check("second request reuses the account (no second grant)",
              len(await h.rows(ledger, user_id="user-new")) == 1)


async def test_jwks_asymmetric_keys() -> None:
    private = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private.public_key()))
    jwk.update({"kid": "key-1", "alg": "ES256", "use": "sig"})
    fetches: list[str] = []

    def serve_jwks(request: httpx.Request) -> httpx.Response:
        fetches.append(str(request.url))
        return httpx.Response(200, json={"keys": [jwk]})

    url = "https://project.supabase.test"

    def es256(sub: str = "user-es", *, kid: str = "key-1", iss: str = f"{url}/auth/v1") -> str:
        payload = {"sub": sub, "aud": "authenticated", "iss": iss,
                   "exp": int(time.time()) + 600, "role": "authenticated"}
        return jwt.encode(payload, private, algorithm="ES256", headers={"kid": kid})

    async with Harness(auth_handler=serve_jwks, supabase_url=url) as h:
        r = await h.client.get("/v1/me", headers={"Authorization": f"Bearer {es256()}"})
        check("ES256 token verified through JWKS -> 200", r.status_code == 200, r.text)
        check("JWKS fetched from <SUPABASE_URL>/auth/v1/.well-known/jwks.json",
              fetches == [f"{url}/auth/v1/.well-known/jwks.json"], fetches)
        await h.client.get("/v1/me", headers={"Authorization": f"Bearer {es256()}"})
        check("keys are cached (no second fetch)", len(fetches) == 1, fetches)

        r = await h.client.get(
            "/v1/me", headers={"Authorization": f"Bearer {es256(iss='https://evil.test/auth/v1')}"},
        )
        check("wrong issuer -> 401", r.status_code == 401, r.text)
        r = await h.client.get("/v1/me", headers={"Authorization": f"Bearer {es256(kid='nope')}"})
        check("unknown key id -> 401", r.status_code == 401, r.text)
        # HS256 still works alongside JWKS when the secret is set (its iss
        # must match too once SUPABASE_URL is configured).
        r = await h.client.get("/v1/me", headers=auth("user-hs", iss=f"{url}/auth/v1"))
        check("HS256 with matching issuer still accepted", r.status_code == 200, r.text)


if __name__ == "__main__":
    run([test_missing_and_bad_tokens, test_valid_token_creates_account, test_jwks_asymmetric_keys])
