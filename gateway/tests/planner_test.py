"""The onboarding's AI timetable: POST /v1/plan/week.

    .venv/Scripts/python.exe tests/planner_test.py
"""

from __future__ import annotations

import json

import httpx

from _support import Harness, auth, chat_json, check, run, usage_block
from app import planner
from app.db import accounts, usage

REQUEST = {
    "wake": "06:30", "sleep": "23:00", "chronotype": "early", "stage": "college",
    "busy": {"label": "College", "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "16:00"},
    "activities": [
        {"name": "Gym", "importance": 4},
        {"name": "DSA", "importance": 5, "frequency": "5x"},
        {"name": "Reading", "importance": 2, "frequency": "3x"},
    ],
}

MODEL_PLAN = {
    "summary": "A strong week with room to breathe.",
    "blocks": [
        {"activity": "Gym", "day": 0, "start": "07:00", "end": "08:00"},
        {"activity": "DSA", "day": 0, "start": "10:00", "end": "12:00"},      # inside college: dropped
        {"activity": "DSA", "day": 0, "start": "18:00", "end": "19:30"},
        {"activity": "Reading", "day": 0, "start": "18:30", "end": "19:00"},  # overlaps DSA, less important: dropped
        {"activity": "Netflix", "day": 1, "start": "20:00", "end": "21:00"},  # not theirs: dropped
        {"activity": "gym", "day": 1, "start": "05:00", "end": "06:00"},      # before waking: dropped
        {"activity": "Reading", "day": 2, "start": "22:02", "end": "22:31"},  # night, rounded to 5 min
        {"activity": "DSA", "day": 5, "start": "10:00", "end": "12:00"},      # Saturday, no college: kept
    ],
}


def answer(plan: dict) -> httpx.Response:
    return httpx.Response(200, json=chat_json(json.dumps(plan), usage_block(2_000, 600)))


async def test_anonymous_plan_is_checked() -> None:
    planner._anon_counts.clear()
    async with Harness() as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        r = await h.client.post("/v1/plan/week", json=REQUEST)
        check("anonymous plan answers 200", r.status_code == 200, r.text)
        body = r.json()
        blocks = body["blocks"]
        key = {(b["activity"], b["day"], b["start"], b["end"]) for b in blocks}
        check("valid blocks kept", ("Gym", 0, "07:00", "08:00") in key and ("DSA", 0, "18:00", "19:30") in key
              and ("DSA", 5, "10:00", "12:00") in key, key)
        check("nothing inside college hours", ("DSA", 0, "10:00", "12:00") not in key)
        check("overlap goes to the more important activity", ("Reading", 0, "18:30", "19:00") not in key)
        check("only their own activities", all(b["activity"] in ("Gym", "DSA", "Reading") for b in blocks))
        check("nothing before waking", not any(b["day"] == 1 for b in blocks))
        check("times rounded to 5 minutes", ("Reading", 2, "22:00", "22:30") in key, key)
        phases = {(b["activity"], b["day"]): b["phase"] for b in blocks}
        check("phases tagged", phases[("Gym", 0)] == "morning" and phases[("DSA", 0)] == "evening"
              and phases[("Reading", 2)] == "night", phases)
        per = {p["activity"]: p for p in body["perActivity"]}
        check("per-activity counts", per["DSA"]["timesPerWeek"] == 2 and per["DSA"]["minutesPerSession"] == 105, per)
        check("summary passed through", body["summary"].startswith("A strong week"))
        sent = h.upstream.json()
        check("asks Luna for a strict JSON schema", sent["model"] == "openai/gpt-6-luna"
              and sent["response_format"]["json_schema"]["strict"] is True)
        rows = await h.rows(usage)
        check("usage recorded as free-pool (Spawn) use with no account",
              len(rows) == 1 and rows[0]["plan"] == "spawn" and rows[0]["user_id"].startswith("anon:")
              and rows[0]["endpoint"] == "plan" and rows[0]["milli_aura"] > 0, rows)
        check("no account created", await h.rows(accounts) == [])


async def test_feedback_reaches_the_model() -> None:
    planner._anon_counts.clear()
    async with Harness() as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        body = {**REQUEST, "previous": [{"activity": "Gym", "day": 0, "start": "07:00", "end": "08:00"}],
                "feedback": [{"activity": "Gym", "change": "less"}, {"activity": "x", "change": "sideways"}],
                "comment": "no gym on sundays " * 40}
        r = await h.client.post("/v1/plan/week", json=body)
        check("tweak answers 200", r.status_code == 200, r.text)
        prompt = json.loads(h.upstream.json()["messages"][1]["content"])
        check("previous plan and valid feedback sent", prompt["previous"][0]["activity"] == "Gym"
              and prompt["feedback"] == [{"activity": "Gym", "change": "less"}], prompt.get("feedback"))
        check("comment bounded to 300 chars", len(prompt["comment"]) <= 300)


async def test_limits_and_errors() -> None:
    planner._anon_counts.clear()
    async with Harness(plan_anon_daily_per_ip=2) as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        codes = [(await h.client.post("/v1/plan/week", json=REQUEST)).status_code for _ in range(3)]
        check("per-IP limit: third anonymous try refused", codes == [200, 200, 429], codes)
    planner._anon_counts.clear()
    async with Harness(free_pool_daily_aura=1) as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        first = await h.client.post("/v1/plan/week", json=REQUEST)
        second = await h.client.post("/v1/plan/week", json=REQUEST)
        check("free pool guards anonymous planning",
              first.status_code == 200 and second.status_code == 429
              and second.json()["error"]["code"] == "free_pool_exhausted", (first.status_code, second.text))
    planner._anon_counts.clear()
    async with Harness() as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        r = await h.client.post("/v1/plan/week", json={**REQUEST, "activities": []})
        check("no activities -> 400", r.status_code == 400, r.text)
        r = await h.client.post("/v1/plan/week", json={**REQUEST, "wake": "late"})
        check("bad wake time -> 400", r.status_code == 400, r.text)
        h.upstream.handler = lambda r: httpx.Response(200, json=chat_json("not json", usage_block(100, 10)))
        r = await h.client.post("/v1/plan/week", json=REQUEST)
        check("unreadable model answer -> 502 plan_failed", r.status_code == 502 and r.json()["error"]["code"] == "plan_failed", r.text)
        h.upstream.handler = lambda r: answer({"summary": "x", "blocks": [{"activity": "Netflix", "day": 0, "start": "20:00", "end": "21:00"}]})
        r = await h.client.post("/v1/plan/week", json=REQUEST)
        check("nothing usable -> 502 plan_failed", r.status_code == 502, r.text)


async def test_signed_in_plan_costs_aura() -> None:
    planner._anon_counts.clear()
    async with Harness() as h:
        h.upstream.handler = lambda r: answer(MODEL_PLAN)
        r = await h.client.post("/v1/plan/week", headers=auth("u-plan"), json=REQUEST)
        check("signed-in plan answers 200", r.status_code == 200, r.text)
        acct = (await h.rows(accounts))[0]
        check("charged in Aura from the plan bucket", acct["plan_milli"] < 50_000 and acct["held_milli"] == 0, acct)
        rows = await h.rows(usage)
        check("usage row on the user", rows[-1]["user_id"] == "u-plan" and rows[-1]["endpoint"] == "plan", rows[-1])


if __name__ == "__main__":
    run([test_anonymous_plan_is_checked, test_feedback_reaches_the_model, test_limits_and_errors, test_signed_in_plan_costs_aura])
