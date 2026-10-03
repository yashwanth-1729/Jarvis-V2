"""/v1/me, the Lock-in trial, admin grants, rate limits and health.

    .venv/Scripts/python.exe tests/account_test.py
"""

from __future__ import annotations

from _support import ADMIN, Harness, auth, chat_body, chat_json, check, run, usage_block

import httpx

from app.db import ledger


async def test_me_shape() -> None:
    async with Harness() as h:
        me = await h.me()
        check("top-level keys",
              set(me) == {"user_id", "app", "plan", "aura", "features", "period", "trial", "limits"},
              sorted(me))
        check("plan block", me["plan"] == {"id": "spawn", "name": "Spawn", "price_inr": 0,
                                           "monthly_aura": 50, "source": "default",
                                           "expires_at": None}, me["plan"])
        check("aura block: balance = plan + topup - held, with exact milli",
              me["aura"] == {"balance": 50.0, "plan": 50.0, "topup": 0.0, "held": 0.0,
                             "balance_milli": 50_000, "plan_milli": 50_000, "topup_milli": 0,
                             "held_milli": 0}, me["aura"])
        check("every feature flag present; spawn has only chat",
              me["features"] == {"chat": True, "voice_en": False, "lockin": False,
                                 "voice_te": False, "news": False, "autonomy": False,
                                 "early_access": False}, me["features"])
        check("trial available, not active", me["trial"]["lockin"] == {
            "available": True, "active": False, "started_at": None, "ends_at": None},
            me["trial"])
        check("limits block", me["limits"] == {"requests_per_minute": 30, "daily_cap_aura": 25,
                                               "spent_today_aura": 0.0}, me["limits"])


async def test_lockin_trial() -> None:
    async with Harness() as h:
        h.upstream.handler = lambda r: httpx.Response(200, json=chat_json("ok", usage_block(10, 10)))
        r = await h.client.post("/v1/trial/lockin", headers=auth())
        me = r.json()
        check("trial start -> 200 with the account body", r.status_code == 200, r.text)
        check("lockin feature on during the trial", me["features"]["lockin"] is True, me["features"])
        check("trial ends 3 days later",
              me["trial"]["lockin"]["active"] is True
              and me["trial"]["lockin"]["ends_at"].startswith("2026-10-06T06:00"), me["trial"])
        check("plan unchanged (still spawn)", me["plan"]["id"] == "spawn")

        r = await h.client.post("/api/v1/chat/completions",
                                headers={**auth(), "X-Holo-Feature": "lockin"},
                                json=chat_body(stream=False))
        check("Lock-in chat allowed during the trial", r.status_code == 200, r.text)

        r = await h.client.post("/v1/trial/lockin", headers=auth())
        check("second trial start -> 409 trial_used",
              r.status_code == 409 and r.json()["error"]["code"] == "trial_used", r.text)

        h.clock.advance(days=3, seconds=1)
        me = await h.me()
        check("trial over after 3 days", me["features"]["lockin"] is False
              and me["trial"]["lockin"]["active"] is False
              and me["trial"]["lockin"]["available"] is False, me["trial"])
        r = await h.client.post("/api/v1/chat/completions",
                                headers={**auth(), "X-Holo-Feature": "lockin"},
                                json=chat_body(stream=False))
        check("Lock-in chat refused after the trial", r.status_code == 403, r.text)
        r = await h.client.post("/v1/trial/lockin", headers=auth())
        check("and it cannot be restarted", r.status_code == 409, r.text)


async def test_admin_grant() -> None:
    async with Harness() as h:
        r = await h.client.post("/v1/admin/grant", json={"user_id": "u-a", "plan": "god_mode"})
        check("no admin token -> 401", r.status_code == 401, r.text)
        r = await h.client.post("/v1/admin/grant", headers={"X-Admin-Token": "wrong"},
                                json={"user_id": "u-a", "plan": "god_mode"})
        check("wrong admin token -> 401", r.status_code == 401, r.text)
        check("refused grants changed nothing", await h.rows(ledger) == [])

        r = await h.grant("u-a", plan="side_quest")
        me = r.json()
        check("grant creates the account and sets the plan",
              r.status_code == 200 and me["plan"]["id"] == "side_quest"
              and me["plan"]["source"] == "admin", r.text)
        check("fresh period with the plan's 250 Aura", me["aura"]["plan"] == 250.0, me["aura"])
        check("side_quest unlocks voice_en and lockin, not voice_te",
              me["features"]["voice_en"] and me["features"]["lockin"]
              and not me["features"]["voice_te"], me["features"])

        r = await h.grant("u-a", topup_aura=150, refund_aura=2.5)
        me = r.json()
        check("topup and refund land in the top-up bucket", me["aura"]["topup"] == 152.5, me["aura"])
        kinds = [l["kind"] for l in await h.rows(ledger, user_id="u-a")]
        check("ledger kinds recorded", kinds == ["grant", "adjust", "grant", "topup", "refund"], kinds)

        r = await h.grant("u-a", plan="final_boss", days=7)
        me = r.json()
        check("time-limited grant sets expires_at",
              me["plan"]["expires_at"].startswith("2026-10-10"), me["plan"])
        h.clock.advance(days=7, minutes=61)  # past expiry + the 60-minute grace
        me = await h.me("u-a")
        check("expired admin grant drops back to spawn",
              me["plan"]["id"] == "spawn" and me["aura"]["plan"] == 50.0
              and me["aura"]["topup"] == 152.5, me)

        r = await h.grant("u-a", plan="platinum")
        check("unknown plan -> 400", r.status_code == 400, r.text)
        r = await h.grant("u-a")
        check("empty grant -> 400", r.status_code == 400, r.text)

    async with Harness(admin_token="") as h:
        r = await h.client.post("/v1/admin/grant", headers=ADMIN,
                                json={"user_id": "u-a", "plan": "god_mode"})
        check("no ADMIN_TOKEN configured -> 503 admin_disabled",
              r.status_code == 503 and r.json()["error"]["code"] == "admin_disabled", r.text)


async def test_rate_limit() -> None:
    async with Harness(plan_overrides={"spawn": {"rpm": 3}}) as h:
        codes = [(await h.client.get("/v1/me", headers=auth())).status_code for _ in range(3)]
        check("3 requests within a 3-rpm limit pass", codes == [200, 200, 200], codes)
        r = await h.client.get("/v1/me", headers=auth())
        check("4th request -> 429 rate_limited",
              r.status_code == 429 and r.json()["error"]["code"] == "rate_limited", r.text)
        check("429 has Retry-After", int(r.headers.get("retry-after", "0")) >= 1, r.headers)
        r = await h.client.get("/v1/me", headers=auth("someone-else"))
        check("limits are per user", r.status_code == 200, r.text)
        r = await h.client.get("/api/v1/key", headers=auth())
        check("the warm-up endpoint is not rate limited", r.status_code == 200, r.text)


async def test_health_and_warmup() -> None:
    async with Harness() as h:
        r = await h.client.get("/healthz")
        body = r.json()
        check("/healthz -> 200 ok", r.status_code == 200 and body["ok"] is True, r.text)
        check("/healthz lists the allow-list per endpoint",
              body["models"]["tts"] == ["hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]
              and body["models"]["stt"] == ["openai/gpt-transcribe", "x-ai/grok-stt-1.0"], body)
        r = await h.client.get("/api/v1/key", headers=auth())
        check("GET /api/v1/key answers locally", r.status_code == 200 and "data" in r.json(), r.text)
        check("and costs no upstream call", h.upstream.requests == [])
        r = await h.client.get("/api/v1/key")
        check("/api/v1/key still needs a token", r.status_code == 401, r.text)
        r = await h.client.get("/nope")
        check("unknown route -> 404 in the gateway error shape",
              r.status_code == 404 and r.json()["error"]["code"] == "not_found", r.text)


if __name__ == "__main__":
    run([test_me_shape, test_lockin_trial, test_admin_grant, test_rate_limit,
         test_health_and_warmup])
