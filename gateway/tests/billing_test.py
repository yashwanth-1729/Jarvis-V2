"""Google Play notifications -> plans and top-ups, with the fake verifier.

No Google call is possible: the harness injects ``FakePlayVerifier``.

    .venv/Scripts/python.exe tests/billing_test.py
"""

from __future__ import annotations

import base64
import itertools
import json
from datetime import timedelta

from _support import START, Harness, check, run

import httpx

from app.db import accounts, ledger, play_events
from app.play import VerifiedProduct, VerifiedSubscription

PUSH = "/v1/billing/play?token=push-test-token"
PACKAGE = "app.holo.test"
_ids = itertools.count(1)


def envelope(notification: dict, message_id: str | None = None) -> dict:
    data = base64.b64encode(json.dumps({
        "version": "1.0", "packageName": PACKAGE, "eventTimeMillis": "1790000000000",
        **notification,
    }).encode()).decode()
    return {"message": {"data": data, "messageId": message_id or f"msg-{next(_ids)}",
                        "publishTime": "2026-10-03T06:00:00Z"},
            "subscription": "projects/holo/subscriptions/play-rtdn"}


def subscription(token: str, ntype: int, product: str = "holo_main_character") -> dict:
    return {"subscriptionNotification": {"version": "1.0", "notificationType": ntype,
                                         "purchaseToken": token, "subscriptionId": product}}


async def push(h: Harness, body: dict, path: str = PUSH) -> httpx.Response:
    return await h.client.post(path, json=body)


async def test_push_auth() -> None:
    async with Harness() as h:
        r = await push(h, envelope({"testNotification": {"version": "1.0"}}), "/v1/billing/play")
        check("no push token -> 401", r.status_code == 401, r.text)
        r = await push(h, envelope({"testNotification": {"version": "1.0"}}),
                       "/v1/billing/play?token=wrong")
        check("wrong push token -> 401", r.status_code == 401, r.text)
        r = await h.client.post("/v1/billing/play",
                                headers={"X-Play-Push-Token": "push-test-token"},
                                json=envelope({"testNotification": {"version": "1.0"}}))
        check("token in X-Play-Push-Token header accepted",
              r.status_code == 200 and r.json()["outcome"] == "test", r.text)
        r = await push(h, {"message": {"data": "%%%", "messageId": "m-bad"}})
        check("malformed data -> 400", r.status_code == 400, r.text)
    async with Harness(play_push_token="") as h:
        r = await push(h, envelope({"testNotification": {}}))
        check("no PLAY_PUSH_TOKEN configured -> 503", r.status_code == 503, r.text)


async def test_subscription_lifecycle() -> None:
    async with Harness() as h:
        expires = START + timedelta(days=30)
        h.play.subscriptions["tok-1"] = VerifiedSubscription(
            product_id="holo_main_character", account_id="user-p", state="active",
            expires_at=expires,
        )
        body = envelope(subscription("tok-1", 4), message_id="m-purchase")
        r = await push(h, body)
        check("PURCHASED -> 200 plan_set", r.status_code == 200 and r.json()["outcome"] == "plan_set",
              r.text)
        acct = (await h.rows(accounts, user_id="user-p"))[0]
        check("product holo_main_character mapped to main_character",
              acct["plan"] == "main_character" and acct["plan_source"] == "play", acct)
        check("plan bucket = 750 Aura", acct["plan_milli"] == 750_000, acct)
        check("period and plan end at the store expiry",
              acct["period_end"].isoformat().startswith("2026-11-02T06:00")
              and acct["plan_expires_at"].isoformat().startswith("2026-11-02T06:00"), acct)
        check("purchase token remembered", acct["play_purchase_token"] == "tok-1", acct)
        grant = (await h.rows(ledger, user_id="user-p"))[-1]
        check("grant ledger row references the purchase token",
              grant["kind"] == "grant" and grant["ref"] == "tok-1"
              and grant["plan_delta_milli"] == 750_000, grant)

        rows_before = len(await h.rows(ledger))
        r = await push(h, body)
        check("redelivered messageId -> duplicate, no second grant",
              r.json()["outcome"] == "duplicate" and len(await h.rows(ledger)) == rows_before, r.text)
        events = await h.rows(play_events)
        check("notification logged in play_events",
              len(events) == 1 and events[0]["outcome"] == "plan_set"
              and events[0]["user_id"] == "user-p" and events[0]["notification_type"] == 4, events)

        h.play.subscriptions["tok-1"] = VerifiedSubscription(
            "holo_main_character", "user-p", "canceled", expires,
        )
        r = await push(h, envelope(subscription("tok-1", 3)))
        acct = (await h.rows(accounts, user_id="user-p"))[0]
        check("CANCELED keeps the plan until expiry",
              r.json()["outcome"] == "cancel_scheduled" and acct["plan"] == "main_character", r.text)

        h.play.subscriptions["tok-old"] = VerifiedSubscription(
            "holo_side_quest", "user-p", "expired", START,
        )
        r = await push(h, envelope(subscription("tok-old", 13, "holo_side_quest")))
        acct = (await h.rows(accounts, user_id="user-p"))[0]
        check("a stale token's EXPIRED does not downgrade the current plan",
              r.json()["outcome"] == "ignored" and acct["plan"] == "main_character", r.text)

        h.play.subscriptions["tok-1"] = VerifiedSubscription(
            "holo_main_character", "user-p", "expired", expires,
        )
        r = await push(h, envelope(subscription("tok-1", 13)))
        acct = (await h.rows(accounts, user_id="user-p"))[0]
        check("EXPIRED on the current token -> back to spawn",
              r.json()["outcome"] == "downgraded" and acct["plan"] == "spawn"
              and acct["plan_milli"] == 50_000 and acct["plan_expires_at"] is None, acct)


async def test_unmappable_notifications() -> None:
    async with Harness() as h:
        h.play.subscriptions["tok-x"] = VerifiedSubscription(
            "holo_platinum", "user-q", "active", START + timedelta(days=30),
        )
        r = await push(h, envelope(subscription("tok-x", 4, "holo_platinum")))
        check("unknown product -> 200 unknown_product (acked, logged)",
              r.status_code == 200 and r.json()["outcome"] == "unknown_product", r.text)
        check("no account created for it", await h.rows(accounts) == [])

        r = await push(h, envelope(subscription("tok-forged", 4)))
        check("token Google does not know -> purchase_not_found",
              r.json()["outcome"] == "purchase_not_found", r.text)

        h.play.subscriptions["tok-anon"] = VerifiedSubscription(
            "holo_side_quest", None, "active", START + timedelta(days=30),
        )
        r = await push(h, envelope(subscription("tok-anon", 4, "holo_side_quest")))
        check("purchase without obfuscatedAccountId -> unlinked_purchase",
              r.json()["outcome"] == "unlinked_purchase", r.text)

        h.play.unavailable = True
        h.play.subscriptions["tok-2"] = VerifiedSubscription(
            "holo_side_quest", "user-q", "active", START + timedelta(days=30),
        )
        body = envelope(subscription("tok-2", 4, "holo_side_quest"), message_id="m-retry")
        r = await push(h, body)
        check("verification unavailable -> 503 so Pub/Sub retries", r.status_code == 503, r.text)
        h.play.unavailable = False
        r = await push(h, body)
        check("the retried message is processed (not seen as a duplicate)",
              r.json()["outcome"] == "plan_set", r.text)


async def test_topup_purchase() -> None:
    async with Harness() as h:
        h.play.products["tok-topup"] = VerifiedProduct("holo_aura_150", "user-t", True)
        one_time = {"oneTimeProductNotification": {
            "version": "1.0", "notificationType": 1, "purchaseToken": "tok-topup",
            "sku": "holo_aura_150"}}
        r = await push(h, envelope(one_time))
        check("top-up purchase -> topup", r.json()["outcome"] == "topup", r.text)
        acct = (await h.rows(accounts, user_id="user-t"))[0]
        check("150 Aura in the top-up bucket", acct["topup_milli"] == 150_000, acct)
        r = await push(h, envelope(one_time))  # same token, new messageId
        acct = (await h.rows(accounts, user_id="user-t"))[0]
        check("same purchase token never credited twice",
              r.json()["outcome"] == "duplicate_purchase" and acct["topup_milli"] == 150_000, acct)


if __name__ == "__main__":
    run([test_push_auth, test_subscription_lifecycle, test_unmappable_notifications,
         test_topup_purchase])
