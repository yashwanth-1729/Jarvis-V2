"""The News tab: the nightly Grok refresh and GET /v1/news.

    .venv/Scripts/python.exe tests/news_test.py

Grok is scripted (no OpenRouter call is possible from here) with the shape a
live probe returned on 2026-10-17: strict JSON content, ``url_citation``
annotations, and a usage block with OpenRouter's cost and search count.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone

import httpx

from _support import ADMIN, START, Harness, check, run, usage_block
from app import news
from app.config import Settings
from app.db import news_sections, usage
from app.main import create_app

CITED = [
    "https://www.espncricinfo.com/series/india-vs-australia-2026/match-report-1234567",
    "https://sportstar.thehindu.com/cricket/india-squad-announced/article71597580.ece",
    "https://www.tribuneindia.com/news/cricket",  # a listing page, but cited
    "https://www.ndtv.com/sports/kohli-century-record-9876543",
]
LONG_TITLE = "Record crowd at Eden Gardens " + "watches a very long and very tense final over " * 4


def item(title: str, url: str, published: str = "2026-10-03", trending: bool = False,
         source: str = "ESPNcricinfo", summary: str = "A plain two-sentence summary of what happened. It matters.") -> dict:
    return {"title": title, "summary": summary, "source": source, "url": url,
            "published": published, "trending": trending}


ITEMS = [
    item("India beat Australia by 6 wickets in Perth", CITED[0] + "?utm_source=x#top", trending=True,
         summary="Kohli's unbeaten century steered the chase in Perth. <b>India</b> lead the series 1-0. [1]"),
    item("Squad named for the New Zealand Tests", CITED[1], "2026-10-02", trending=True, source="Sportstar"),
    item("Women's team clinch the T20 series 3-0", CITED[2], trending=True, source="The Tribune"),
    item("Bumrah ruled out of the second Test with a back spasm",
         "https://madeupdaily.example/cricket/bumrah-ruled-out-second-test-back", source="Made Up Daily"),
    item("Ranji Trophy: Punjab take first-innings lead over Delhi",
         "https://ndtv.com/sports/ranji-punjab-lead-delhi-5551234", source="NDTV"),
    item("Gill to captain India A in the warm-up game", "javascript:alert(1)", source=""),
    item("An old story about a series that ended weeks ago", CITED[3], "2026-09-23"),
    item("India beat Australia by six wickets in Perth", CITED[3]),          # same story as the first
    item("Kohli's unbeaten 112 seals the chase at Perth Stadium", CITED[0]),  # same article as the first
    item("Hi", CITED[3]),                                                    # too short
    item(LONG_TITLE, CITED[3], "not a date"),
    item("Mandhana becomes the fastest to 8,000 international runs", CITED[3] + "?page=2", "2026-10-09"),
    item("One story too many for the section's limit", CITED[3] + "?page=3"),
]


def grok(items: list, cited: list[str] = CITED, cost: float | None = 0.0269, searches: int = 2,
         content: str | None = None) -> httpx.Response:
    usage = usage_block(10_865, 1_971, cached=1_536, cost=cost)
    usage["server_tool_use_details"] = {"web_search_requests": searches}
    return httpx.Response(200, json={
        "id": "gen-news-1", "model": "x-ai/grok-4.3", "object": "chat.completion",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {
            "role": "assistant",
            "content": content if content is not None else json.dumps({"items": items}),
            "annotations": [
                {"type": "url_citation", "url_citation": {"url": u, "title": u, "content": "",
                                                          "start_index": 0, "end_index": 0}}
                for u in cited
            ],
        }}],
        "usage": usage,
    })


async def refresh(h: Harness, sections: list[str] | None = None) -> dict:
    body: dict = {"wait": True}
    if sections is not None:
        body["sections"] = sections
    r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN, json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def test_empty_news() -> None:
    async with Harness() as h:
        r = await h.client.get("/v1/news")
        body = r.json()
        check("GET /v1/news works with no sign-in", r.status_code == 200, r.text)
        check("nothing stored yet: no sections", body["sections"] == [] and body["updated_at"] is None, body)
        check("no next refresh when the nightly job is off", body["next_refresh"] is None, body)
        check("cacheable for a few minutes", "max-age=300" in r.headers.get("cache-control", ""))


async def test_refresh_cleans_and_stores() -> None:
    async with Harness(news_sections="cricket", news_items_per_section=8) as h:
        h.upstream.handler = lambda r: grok(ITEMS)
        report = await refresh(h)
        section = report["sections"][0]
        check("one section refreshed", report["ok"] == 1 and len(report["sections"]) == 1, report)
        check("report: ok, 8 items, cost and searches",
              section["status"] == "ok" and section["items"] == 8 and section["cost_usd"] == 0.0269
              and section["searches"] == 2, section)

        sent = h.upstream.json()
        system = sent["messages"][0]["content"]
        check("asks Grok 4.3 with the web plugin", sent["model"] == "x-ai/grok-4.3"
              and sent["plugins"][0]["id"] == "web", sent.get("plugins"))
        check("strict JSON schema", sent["response_format"]["json_schema"]["strict"] is True)
        check("search budget in the prompt", "at most 2 web searches" in system, system[:400])
        check("today's IST date and the window in the prompt",
              "Today is 2026-10-03" in system and "on or after 2026-09-30" in system)
        check("the section's brief is the user message",
              sent["messages"][1]["content"].startswith("Section: Cricket. Cricket. India's matches first"))
        check("low reasoning effort", sent["reasoning"] == {"effort": "low"})

        r = await h.client.get("/v1/news")
        body = r.json()
        check("served", r.status_code == 200 and len(body["sections"]) == 1, body)
        cricket = body["sections"][0]
        items = cricket["items"]
        titles = [i["title"] for i in items]
        check("section id, title and time", cricket["id"] == "cricket" and cricket["title"] == "Cricket"
              and cricket["updated_at"] == START.isoformat() and body["updated_at"] == START.isoformat(), cricket)
        check("capped at the section limit", len(items) == 8 and "One story too many" not in " ".join(titles), titles)
        check("cited link kept, tracking and fragment stripped", items[0]["url"] == CITED[0], items[0]["url"])
        mandhana = [i for i in items if i["title"].startswith("Mandhana")]
        check("other query parameters kept", mandhana and mandhana[0]["url"] == CITED[3] + "?page=2", mandhana)
        check("HTML and citation markers stripped",
              items[0]["summary"] == "Kohli's unbeaten century steered the chase in Perth. India lead the series 1-0.",
              items[0]["summary"])
        check("at most two trending", [i["trending"] for i in items[:3]] == [True, True, False]
              and sum(i["trending"] for i in items) == 2)
        check("a cited listing page is kept", items[2]["url"] == CITED[2])
        by_title = {i["title"]: i for i in items}
        bumrah = by_title["Bumrah ruled out of the second Test with a back spasm"]
        check("uncited link on an unread site dropped, story kept",
              bumrah["url"] is None and bumrah["source"] == "Made Up Daily", bumrah)
        ranji = by_title["Ranji Trophy: Punjab take first-innings lead over Delhi"]
        check("uncited article on a site the search read is kept", ranji["url"] is not None, ranji)
        gill = by_title["Gill to captain India A in the warm-up game"]
        check("javascript: link dropped", gill["url"] is None and gill["source"] == "", gill)
        check("story older than the window dropped", not any("old story" in t for t in titles))
        check("same story twice dropped", sum("Perth" in t for t in titles) == 1, titles)
        check("too-short title dropped", "Hi" not in titles)
        long = [t for t in titles if t.startswith("Record crowd")]
        check("long title clipped at a word", len(long) == 1 and len(long[0]) <= 120 and long[0].endswith("…"), long)
        check("unreadable date kept as null", by_title[long[0]]["published"] is None)
        check("future date kept as null",
              by_title["Mandhana becomes the fastest to 8,000 international runs"]["published"] is None)
        check("dates kept as given", items[1]["published"] == "2026-10-02")
        check("ids are unique short hashes", len({i["id"] for i in items}) == 8
              and all(re.fullmatch(r"[0-9a-f]{12}", i["id"]) for i in items))

        rows = await h.rows(usage)
        check("one usage row for the service, not a user", len(rows) == 1 and rows[0]["user_id"] == "system:news"
              and rows[0]["plan"] == "system" and rows[0]["endpoint"] == "news", rows)
        check("nobody charged; real cost logged", rows[0]["milli_aura"] == 0 and rows[0]["cost_usd"] == 0.0269
              and rows[0]["upstream_cost_usd"] == 0.0269 and rows[0]["model"] == "x-ai/grok-4.3"
              and rows[0]["cached_tokens"] == 1_536, rows[0])
        stored = await h.rows(news_sections)
        check("stored once with its cost", len(stored) == 1 and stored[0]["cost_usd"] == 0.0269
              and stored[0]["last_error"] is None, stored)


async def test_failed_refresh_keeps_yesterday() -> None:
    async with Harness(news_sections="cricket") as h:
        h.upstream.handler = lambda r: grok(ITEMS)
        await refresh(h)
        before = (await h.client.get("/v1/news")).json()["sections"][0]

        h.clock.advance(days=1)
        cases = [
            ("upstream_error", lambda r: httpx.Response(500, json={"error": {"message": "boom"}})),
            ("too_few", lambda r: grok(ITEMS[:2])),
            ("unreadable", lambda r: grok([], content="Sorry, I could not find any news today.")),
            ("upstream_unreachable", lambda r: (_ for _ in ()).throw(httpx.ConnectError("down"))),
        ]
        for expected, handler in cases:
            h.upstream.handler = handler
            report = await refresh(h)
            got = report["sections"][0]
            check(f"{expected}: reported", got["status"] == expected and got["items"] == 0, got)
            after = (await h.client.get("/v1/news")).json()["sections"][0]
            check(f"{expected}: yesterday's copy still served", after == before)
        stored = (await h.rows(news_sections))[0]
        check("the failed attempt is recorded", stored["last_error"] and stored["attempted_at"] is not None
              and news.aware(stored["attempted_at"]) == START + timedelta(days=1), stored)
        check("every attempt is logged in usage", len(await h.rows(usage)) == 5)


async def test_first_failure_stores_nothing_to_serve() -> None:
    async with Harness(news_sections="cricket") as h:
        h.upstream.handler = lambda r: httpx.Response(502, json={"error": {"message": "bad gateway"}})
        report = await refresh(h)
        check("first attempt failed", report["sections"][0]["status"] == "upstream_error", report)
        body = (await h.client.get("/v1/news")).json()
        check("an empty section isn't served", body["sections"] == [], body)
        check("but the attempt is on record", len(await h.rows(news_sections)) == 1)


async def test_structured_output_fallback() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if "response_format" in payload:
            return httpx.Response(400, json={"error": {"message": "structured outputs unsupported with plugins"}})
        prose = "Here are today's stories:\n```json\n" + json.dumps({"items": ITEMS[:5]}) + "\n```"
        return grok([], content=prose)

    async with Harness(news_sections="cricket") as h:
        h.upstream.handler = handler
        report = await refresh(h)
        check("falls back to JSON in prose", report["sections"][0]["status"] == "ok", report)
        check("two calls, the second without the schema", len(h.upstream.requests) == 2
              and "response_format" not in h.upstream.json(1)
              and "Answer with JSON only" in h.upstream.json(1)["messages"][0]["content"])


async def test_budget_stops_the_day() -> None:
    async with Harness(news_sections="cricket,ai,tech", news_concurrency=1, news_daily_budget_usd=0.05) as h:
        h.upstream.handler = lambda r: grok(ITEMS, cost=0.03)
        report = await refresh(h)
        statuses = [s["status"] for s in report["sections"]]
        check("stops once the day's budget is spent", statuses == ["ok", "ok", "budget"], statuses)
        check("no call past the budget", len(h.upstream.requests) == 2)
        check("the report totals the spend", report["cost_usd"] == 0.06, report)

        h.clock.advance(days=1)
        report = await refresh(h, ["tech"])
        check("a new day has a new budget", report["sections"][0]["status"] == "ok", report)


async def test_admin_guard() -> None:
    async with Harness() as h:
        r = await h.client.post("/v1/admin/news/refresh", json={})
        check("no token: 401", r.status_code == 401, r.text)
        r = await h.client.post("/v1/admin/news/refresh", headers={"X-Admin-Token": "nope"}, json={})
        check("wrong token: 401", r.status_code == 401, r.text)
        for bad in (["nope"], "cricket", []):
            r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN, json={"sections": bad})
            check(f"bad sections {bad!r}: 400", r.status_code == 400, r.text)

        h.upstream.handler = lambda r: grok(ITEMS)
        r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN, json={"sections": ["ai"]})
        check("without wait: 202 with what started", r.status_code == 202 and r.json() == {"started": ["ai"]}, r.text)
        await asyncio.gather(*list(h.gw.news_tasks))
        body = (await h.client.get("/v1/news")).json()
        check("the background refresh landed", [s["id"] for s in body["sections"]] == ["ai"], body)
        r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN)
        check("an empty body means every section", r.status_code == 202
              and r.json()["started"] == [s.id for s in news.SECTIONS], r.text)
        await asyncio.gather(*list(h.gw.news_tasks))

    async with Harness(admin_token="") as h:
        r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN, json={})
        check("admin disabled: 503", r.status_code == 503, r.text)
    async with Harness(openrouter_api_key="") as h:
        r = await h.client.post("/v1/admin/news/refresh", headers=ADMIN, json={"wait": True})
        check("no OpenRouter key: 503", r.status_code == 503, r.text)


async def test_since_and_section_filter() -> None:
    async with Harness(news_sections="cricket,ai") as h:
        h.upstream.handler = lambda r: grok(ITEMS)
        await refresh(h)
        body = (await h.client.get("/v1/news")).json()
        check("both sections, in SECTIONS order", [s["id"] for s in body["sections"]] == ["cricket", "ai"], body)
        same = (await h.client.get("/v1/news", params={"since": body["updated_at"]})).json()
        check("since the newest copy: unchanged", same == {"unchanged": True, "updated_at": body["updated_at"]}, same)
        older = (await h.client.get("/v1/news", params={"since": (START - timedelta(hours=1)).isoformat()})).json()
        check("since an older copy: everything", len(older.get("sections", [])) == 2)
        junk = (await h.client.get("/v1/news", params={"since": "yesterday"})).json()
        check("an unreadable since is ignored", len(junk.get("sections", [])) == 2)
        one = (await h.client.get("/v1/news", params={"section": "ai"})).json()
        check("one section on request", [s["id"] for s in one["sections"]] == ["ai"], one)
        r = await h.client.get("/v1/news", params={"section": "gossip"})
        check("unknown section: 404", r.status_code == 404, r.text)


async def test_read_rate_limit() -> None:
    async with Harness() as h:
        headers = {"cf-connecting-ip": "203.0.113.9"}
        codes = [(await h.client.get("/v1/news", headers=headers)).status_code for _ in range(news.READS_PER_MINUTE)]
        check("reads within the limit pass", set(codes) == {200}, codes)
        r = await h.client.get("/v1/news", headers=headers)
        check("one more is limited", r.status_code == 429 and r.headers.get("retry-after"), r.text)
        r = await h.client.get("/v1/news", headers={"cf-connecting-ip": "203.0.113.10"})
        check("another address is not", r.status_code == 200)


async def test_schedule() -> None:
    s = Settings(_env_file=None, news_refresh_at="04:30")
    utc = timezone.utc
    check("next run from late morning IST is 04:30 IST (23:00 UTC) tonight",
          news.next_run(datetime(2026, 10, 3, 6, 0, tzinfo=utc), s) == datetime(2026, 10, 3, 23, 0, tzinfo=utc))
    check("a minute before, it's the same night",
          news.next_run(datetime(2026, 10, 3, 22, 59, tzinfo=utc), s) == datetime(2026, 10, 3, 23, 0, tzinfo=utc))
    check("on the minute, it's the next night",
          news.next_run(datetime(2026, 10, 3, 23, 0, tzinfo=utc), s) == datetime(2026, 10, 4, 23, 0, tzinfo=utc))
    for field, value in (("news_refresh_at", "25:00"), ("news_refresh_at", "4.30"), ("news_sections", "cricket,gossip")):
        try:
            news.validate_settings(Settings(_env_file=None, **{field: value}))
            ok = False
        except ValueError:
            ok = True
        check(f"{field}={value!r} stops the deploy", ok)
    try:
        create_app(Settings(_env_file=None, supabase_jwt_secret="x", news_sections="gossip"))
        ok = False
    except ValueError:
        ok = True
    check("create_app refuses unknown sections", ok)
    check("NEWS_SECTIONS picks and orders nothing new",
          [x.id for x in news.active_sections(Settings(_env_file=None, news_sections="ai, cricket"))] == ["ai", "cricket"])

    async with Harness(news_sections="cricket,ai") as h:
        h.upstream.handler = lambda r: grok(ITEMS)
        check("all stale before any refresh", await news.stale_sections(h.gw) == ["cricket", "ai"])
        await refresh(h, ["cricket"])
        check("a fresh section isn't stale", await news.stale_sections(h.gw) == ["ai"])
        h.clock.advance(hours=27)
        check("older than NEWS_STALE_HOURS is stale again", await news.stale_sections(h.gw) == ["cricket", "ai"])


async def post(h: Harness, section: str, items: list, **extra) -> httpx.Response:
    return await h.client.post("/v1/admin/news/items", headers=ADMIN,
                               json={"section": section, "items": items, **extra})


async def test_hand_posted_stories() -> None:
    async with Harness(news_sections="cricket") as h:
        r = await post(h, "cricket", [
            {"title": "India beat Australia by 6 wickets in Perth", "summary": "The owner's own pick.",
             "url": "https://example.com/story-one?utm_source=x", "trending": True},
            {"title": "Just a title"},
        ])
        check("posted by hand", r.status_code == 200 and len(r.json()["posted"]) == 2 and r.json()["items"] == 2, r.text)
        items = (await h.client.get("/v1/news")).json()["sections"][0]["items"]
        check("served with the refresh off", [i["title"] for i in items]
              == ["India beat Australia by 6 wickets in Perth", "Just a title"], items)
        check("marked as hand-posted, link cleaned", items[0]["manual"] is True and items[0]["trending"] is True
              and items[0]["url"] == "https://example.com/story-one", items[0])
        check("defaults: source JARVIS, today's date, no link", items[1]["source"] == "JARVIS"
              and items[1]["published"] == "2026-10-03" and items[1]["url"] is None and items[1]["summary"] == "", items[1])
        check("no model call and no cost", h.upstream.requests == [] and await h.rows(usage) == [])

        h.upstream.handler = lambda r: grok(ITEMS)
        h.clock.advance(hours=12)
        await refresh(h)
        items = (await h.client.get("/v1/news")).json()["sections"][0]["items"]
        titles = [i["title"] for i in items]
        check("a refresh keeps hand-posted stories on top", titles[:2]
              == ["India beat Australia by 6 wickets in Perth", "Just a title"], titles)
        check("and drops Grok's copy of the same story", sum("Perth" in t for t in titles) == 1
              and not items[2]["manual"], titles)

        h.clock.advance(days=4)
        h.upstream.handler = lambda r: grok([{**i, "published": ""} for i in ITEMS])
        report = await refresh(h)
        check("a later refresh succeeds", report["ok"] == 1, report)
        items = (await h.client.get("/v1/news")).json()["sections"][0]["items"]
        check("past the window they're gone", not any(i["manual"] for i in items), [i["title"] for i in items])

        r = await post(h, "cricket", [{"title": "Only this one"}], replace=True)
        items = (await h.client.get("/v1/news")).json()["sections"][0]["items"]
        check("replace: the section becomes exactly the post", [i["title"] for i in items] == ["Only this one"], items)

        await post(h, "cricket", [{"title": "Second story"}])
        target = items[0]["id"]
        r = await h.client.delete(f"/v1/admin/news/items/cricket/{target}", headers=ADMIN)
        check("one story taken down", r.status_code == 200 and r.json()["removed"] == 1, r.text)
        items = (await h.client.get("/v1/news")).json()["sections"][0]["items"]
        check("and gone from the feed", [i["title"] for i in items] == ["Second story"], items)
        r = await h.client.delete(f"/v1/admin/news/items/cricket/{target}", headers=ADMIN)
        check("unknown story: 404", r.status_code == 404, r.text)
        r = await h.client.delete("/v1/admin/news/items/cricket", headers=ADMIN)
        check("section cleared", r.status_code == 200 and r.json()["items"] == 0, r.text)
        body = (await h.client.get("/v1/news")).json()
        check("an empty section isn't shown", body["sections"] == [], body)

        bad = [
            ("unknown section", {"section": "gossip", "items": [{"title": "Hello there"}]}),
            ("no items", {"section": "cricket", "items": []}),
            ("too many", {"section": "cricket", "items": [{"title": f"Story {n}"} for n in range(11)]}),
            ("no title", {"section": "cricket", "items": [{"summary": "no title here"}]}),
            ("not a web link", {"section": "cricket", "items": [{"title": "Hello there", "url": "ftp://x.y/z"}]}),
        ]
        for label, body in bad:
            r = await h.client.post("/v1/admin/news/items", headers=ADMIN, json=body)
            check(f"{label}: 400", r.status_code == 400, r.text)
        r = await h.client.post("/v1/admin/news/items", json={"section": "cricket", "items": [{"title": "Hello there"}]})
        check("no admin token: 401", r.status_code == 401, r.text)
        r = await h.client.delete("/v1/admin/news/items/cricket")
        check("delete without the token: 401", r.status_code == 401, r.text)


async def test_nightly_task_runs_only_when_enabled() -> None:
    async with Harness() as h:
        names = {t.get_name() for t in asyncio.all_tasks()}
        check("off in the harness", "news-nightly" not in names)
    async with Harness(news_refresh_enabled=True) as h:
        names = {t.get_name() for t in asyncio.all_tasks()}
        check("started by the lifespan when enabled", "news-nightly" in names, names)
        body = (await h.client.get("/v1/news")).json()
        check("the next refresh is advertised", body["next_refresh"] == "2026-10-03T23:00:00+00:00", body)
        check("no call before the startup delay", h.upstream.requests == [])
    names = {t.get_name() for t in asyncio.all_tasks()}
    check("cancelled at shutdown", "news-nightly" not in names, names)


if __name__ == "__main__":
    run([
        test_empty_news,
        test_refresh_cleans_and_stores,
        test_failed_refresh_keeps_yesterday,
        test_first_failure_stores_nothing_to_serve,
        test_structured_output_fallback,
        test_budget_stops_the_day,
        test_admin_guard,
        test_since_and_section_filter,
        test_read_rate_limit,
        test_schedule,
        test_hand_posted_stories,
        test_nightly_task_runs_only_when_enabled,
    ])
