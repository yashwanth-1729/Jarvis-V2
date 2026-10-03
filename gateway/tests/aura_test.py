"""Aura accounting: 402, bucket order, monthly reset, daily cap, holds.

    .venv/Scripts/python.exe tests/aura_test.py
"""

from __future__ import annotations

from collections import deque

from _support import (
    Harness,
    auth,
    chat_body,
    chat_json,
    check,
    run,
    usage_block,
)

import httpx

from app.db import accounts, ledger, reservations, usage
from app.errors import GatewayError


def scripted(h: Harness, *prompt_tokens: int) -> None:
    """Answer successive non-streamed chats with these prompt sizes (no
    completion), so each costs exactly prompt x $0.10/1M."""
    queue = deque(prompt_tokens)
    h.upstream.handler = lambda r: httpx.Response(
        200, json=chat_json("ok", usage_block(queue.popleft(), 0)),
    )


async def chat(h: Harness, sub: str = "user-1") -> httpx.Response:
    return await h.client.post("/api/v1/chat/completions", headers=auth(sub),
                               json=chat_body(stream=False))


async def test_insufficient_aura_402() -> None:
    async with Harness(plan_overrides={"spawn": {"monthly_aura": 0}}) as h:
        r = await chat(h)
        error = r.json().get("error", {})
        check("empty balance -> 402", r.status_code == 402, r.text)
        check("402 code is insufficient_aura", error.get("code") == "insufficient_aura", error)
        check("402 carries balance, requirement and refill date",
              error.get("aura_balance") == 0 and error.get("aura_required") == 1.0
              and error.get("refills_at", "").startswith("2026-11-03")
              and error.get("plan") == "spawn" and error.get("upgrade_available") is True, error)
        check("402 message is human-readable", "Aura" in error.get("message", ""), error)
        check("nothing forwarded upstream", h.upstream.requests == [])
        check("nothing held or recorded",
              await h.rows(reservations) == [] and await h.rows(usage) == [])


async def test_plan_bucket_spent_before_topup() -> None:
    async with Harness(plan_overrides={"spawn": {"daily_cap_aura": 1000}}) as h:
        await h.me()
        r = await h.grant(topup_aura=10)
        check("admin top-up of 10 Aura", r.status_code == 200 and r.json()["aura"]["topup"] == 10.0,
              r.text)
        # $0.05 = 44,000 milli; $0.01 = 8,800; $0.02 = 17,600.
        scripted(h, 500_000, 100_000, 200_000)

        await chat(h)
        acct = (await h.rows(accounts))[0]
        check("first spend all from the plan bucket (50,000 -> 6,000), top-up untouched",
              (acct["plan_milli"], acct["topup_milli"]) == (6_000, 10_000), acct)

        await chat(h)
        acct = (await h.rows(accounts))[0]
        check("second spend empties the plan bucket, then dips into top-up",
              (acct["plan_milli"], acct["topup_milli"]) == (0, 7_200), acct)
        spend = [l for l in await h.rows(ledger) if l["kind"] == "spend"][-1]
        check("ledger row splits the spend: -6,000 plan, -2,800 top-up",
              (spend["plan_delta_milli"], spend["topup_delta_milli"],
               spend["plan_after_milli"], spend["topup_after_milli"]) == (-6_000, -2_800, 0, 7_200),
              spend)

        await chat(h)
        acct = (await h.rows(accounts))[0]
        check("a call costing more than everything left overdraws the plan bucket only",
              (acct["plan_milli"], acct["topup_milli"]) == (-10_400, 0), acct)
        r = await chat(h)
        check("and the next call is refused with 402", r.status_code == 402, r.text)


async def test_monthly_reset() -> None:
    async with Harness() as h:
        await h.me()
        scripted(h, 1_000)
        await chat(h)  # 1,000 x 1e-7 = $0.0001 = 88 milli
        await h.grant(topup_aura=5)
        h.clock.advance(days=31)

        me = await h.me()
        check("plan Aura refilled to the allowance (no rollover)", me["aura"]["plan"] == 50.0,
              me["aura"])
        check("top-up Aura persists across the reset", me["aura"]["topup"] == 5.0, me["aura"])
        check("period advanced one month",
              me["period"]["start"].startswith("2026-11-03")
              and me["period"]["end"].startswith("2026-12-03"), me["period"])
        kinds = [(l["kind"], l["plan_delta_milli"], l["topup_delta_milli"])
                 for l in await h.rows(ledger)]
        check("ledger: grant, spend, topup, adjust (unspent expired), grant",
              kinds == [("grant", 50_000, 0), ("spend", -88, 0), ("topup", 0, 5_000),
                        ("adjust", -49_912, 0), ("grant", 50_000, 0)], kinds)

        h.clock.advance(days=62)  # skipped two whole periods
        me = await h.me()
        check("long absence catches the period up to now",
              me["period"]["start"].startswith("2027-01-03")
              and me["period"]["end"].startswith("2027-02-03"), me["period"])
        check("and resets once, not once per missed month",
              len(await h.rows(ledger)) == 7, len(await h.rows(ledger)))


async def test_daily_cap() -> None:
    async with Harness(plan_overrides={"spawn": {"daily_cap_aura": 1}}) as h:
        scripted(h, 1_000, 1_000, 1_000)
        r = await chat(h)
        check("first call fits under a 1-Aura daily cap", r.status_code == 200, r.text)
        r = await chat(h)
        check("second call trips the cap -> 429 daily_cap_reached",
              r.status_code == 429 and r.json()["error"]["code"] == "daily_cap_reached", r.text)
        check("429 has Retry-After", r.headers.get("retry-after", "").isdigit(), r.headers)
        # START is 06:00 UTC = 11:30 IST; the cap resets at IST midnight.
        h.clock.advance(hours=13)
        r = await chat(h)
        check("cap resets at midnight IST", r.status_code == 200, r.text)


async def test_holds_prevent_overspend_and_expire() -> None:
    async with Harness(plan_overrides={"spawn": {"monthly_aura": 2}}) as h:
        await h.me()
        bank = h.gw.bank
        first = await bank.reserve("user-1", "chat", "openai/gpt-6-luna", 1000)
        await bank.reserve("user-1", "chat", "openai/gpt-6-luna", 1000)
        try:
            await bank.reserve("user-1", "chat", "openai/gpt-6-luna", 1000)
            check("a third concurrent hold beyond the balance is refused", False, "reserved")
        except GatewayError as exc:
            check("a third concurrent hold beyond the balance is refused", exc.status == 402, exc)
        check("held_milli tracks open holds", (await h.rows(accounts))[0]["held_milli"] == 2000)

        h.clock.advance(minutes=16)  # past RESERVATION_TTL_SECONDS (900)
        scripted(h, 1_000)
        await chat(h)
        stale = [u for u in await h.rows(usage) if u["status"] == "stale_hold"]
        check("expired holds charged at their reserve and released",
              len(stale) == 2 and all(u["milli_aura"] == 1000 for u in stale), stale)
        check("no holds left", (await h.rows(accounts))[0]["held_milli"] == 0
              and await h.rows(reservations) == [])

        await bank.settle(first, 1500, {"status": "ok"})
        late = (await h.rows(usage))[-1]
        check("a late settle after the sweep charges only the excess over the reserve",
              late["milli_aura"] == 500, late)


async def test_free_pool_caps_all_free_users_together() -> None:
    # The wallet guarantee: every free user together gets 1 Aura a day here.
    async with Harness(free_pool_daily_aura=1) as h:
        scripted(h, 5_000, 5_000, 5_000)  # each about 0.44 Aura
        r = await chat(h, "free-a")
        check("first free chat fits the pool", r.status_code == 200, r.text)
        r = await chat(h, "free-b")
        error = r.json().get("error", {})
        check("a second free user is refused once the pool is spent",
              r.status_code == 429 and error.get("code") == "free_pool_exhausted", r.text)
        check("the refusal says when it is back and offers the upgrade",
              error.get("resets_at") and error.get("upgrade_available") is True
              and "Retry-After" in r.headers, error)
        await h.grant("paid-c", plan="side_quest", days=30)
        r = await chat(h, "paid-c")
        check("paid plans are not limited by the free pool", r.status_code == 200, r.text)
        rows = await h.rows(usage)
        check("usage rows record the plan they were spent on",
              sorted(u["plan"] for u in rows) == ["side_quest", "spawn"], [u["plan"] for u in rows])
        h.clock.advance(days=1)
        r = await chat(h, "free-b")
        check("the pool refills the next day", r.status_code == 200, r.text)

    async with Harness(free_pool_daily_aura=0) as h:
        scripted(h, 5_000, 5_000)
        ok = [(await chat(h, f"free-{i}")).status_code for i in range(2)]
        check("pool 0 means no shared limit", ok == [200, 200], ok)


if __name__ == "__main__":
    run([
        test_insufficient_aura_402,
        test_plan_bucket_spent_before_topup,
        test_monthly_reset,
        test_daily_cap,
        test_holds_prevent_overspend_and_expire,
        test_free_pool_caps_all_free_users_together,
    ])
