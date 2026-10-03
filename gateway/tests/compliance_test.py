"""Play's rules for AI apps: report a reply, delete the account in the app.

    .venv/Scripts/python.exe tests/compliance_test.py
"""

from __future__ import annotations

import httpx

from _support import Harness, auth, chat_body, chat_json, check, run, usage_block
from app.db import accounts, ledger, reports, usage


async def test_report_a_reply() -> None:
    async with Harness() as h:
        r = await h.client.post("/v1/report", headers=auth("u-r"), json={"reason": "harmful", "excerpt": "a bad reply", "note": "why"})
        check("report accepted (201)", r.status_code == 201 and r.json().get("ok") is True, r.text)
        rows = await h.rows(reports)
        check("stored with reason and excerpt", len(rows) == 1 and rows[0]["reason"] == "harmful" and rows[0]["excerpt"] == "a bad reply", rows)
        r = await h.client.post("/v1/report", headers=auth("u-r"), json={"reason": "weird", "excerpt": "x"})
        check("unknown reason becomes other", r.status_code == 201 and (await h.rows(reports))[-1]["reason"] == "other")
        r = await h.client.post("/v1/report", headers=auth("u-r"), json={"reason": "harmful"})
        check("empty excerpt refused", r.status_code == 400, r.text)
        r = await h.client.post("/v1/report", json={"reason": "harmful", "excerpt": "x"})
        check("needs sign-in", r.status_code == 401, r.text)


ISS = "https://proj.supabase.co/auth/v1"


async def test_delete_account() -> None:
    calls: list[httpx.Request] = []

    def supabase(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={})

    async with Harness(auth_handler=supabase, supabase_service_role_key="service-key", supabase_url="https://proj.supabase.co") as h:
        h.upstream.handler = lambda r: httpx.Response(200, json=chat_json("ok", usage_block(5_000, 0)))
        r = await h.client.post("/api/v1/chat/completions", headers=auth("u-d", iss=ISS), json=chat_body(stream=False))
        check("a chat first, so there is usage", r.status_code == 200, r.text)
        await h.client.post("/v1/report", headers=auth("u-d", iss=ISS), json={"reason": "other", "excerpt": "x"})
        r = await h.client.delete("/v1/me", headers=auth("u-d", iss=ISS))
        check("delete answers 204", r.status_code == 204, r.text)
        check("account, ledger and reports gone",
              await h.rows(accounts) == [] and await h.rows(ledger) == [] and await h.rows(reports) == [])
        rows = await h.rows(usage)
        check("usage kept for cost accounting, anonymised", rows and all(u["user_id"] == "deleted" for u in rows), rows)
        check("Supabase login deleted with the service key",
              any(c.method == "DELETE" and c.url.path == "/auth/v1/admin/users/u-d" for c in calls), [str(c.url) for c in calls])
        check("login removal reported", r.headers.get("X-Login-Removed") == "1")


if __name__ == "__main__":
    run([test_report_a_reply, test_delete_account])
