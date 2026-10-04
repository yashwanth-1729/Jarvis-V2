"""Catch-up (services/replan.py): missed Lock-in blocks fitted back into the week.

Offline and isolated: a temporary database, a fake OpenRouter transport (no
provider call, no credits), fixed clock times, no user data.

    .venv/Scripts/python.exe tests/catchup_test.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ROOT = Path(tempfile.mkdtemp(prefix="jarvis-catchup-"))
os.environ["JARVIS_DB_PATH"] = str(ROOT / "catchup.db")
os.environ["JARVIS_SCHEDULER_ENABLED"] = "false"
os.environ["OPENROUTER_API_KEY"] = "offline-test-key"
os.environ["JARVIS_EDITION"] = "personal"

import httpx  # noqa: E402

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()
import app.db.database as dbmod  # noqa: E402

dbmod.db = dbmod.Database(get_settings().db_file, 2)
import app.db.crud as crud  # noqa: E402
from app.providers import openrouter  # noqa: E402
from app.services import focus, replan  # noqa: E402

crud.db = dbmod.db

failures: list[str] = []
passed = 0

# Thursday 1 Oct 2026, 15:00. The week began Monday 28 Sep.
NOW = datetime(2026, 10, 1, 15, 0)
BUSY = [
    {"date": "2026-10-01", "start": "18:00", "end": "22:00"},  # Thu: college fest
    {"date": "2026-10-02", "start": "09:00", "end": "16:00"},  # Fri: college
    {"date": "2026-10-03", "start": "22:00", "end": "24:00"},  # Sat: up to midnight
]


def check(label: str, condition: bool, detail: object = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


async def add_item(uid: str, title: str, day: int | None, start: str | None, end: str | None,
                   created: str = "2026-09-20T09:00:00", kind: str = "block", mode: str = "session") -> None:
    await dbmod.db.execute(
        "INSERT INTO focus_items (uid, kind, mode, title, block_kind, day_of_week, start_time, end_time, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, 'ROUTINE', ?, ?, ?, ?, ?)",
        (uid, kind, mode, title, day, start, end, created, created),
    )


async def add_event(uid: str, title: str, occurrence: str, status: str) -> None:
    await dbmod.db.execute(
        "INSERT INTO focus_events (item_uid, title, occurrence, status, finished_at) VALUES (?, ?, ?, ?, ?)",
        (uid, title, occurrence, status, f"{occurrence}T20:00:00"),
    )


def model_answer(plan: dict) -> httpx.Response:
    return httpx.Response(200, json={
        "id": "gen-test",
        "choices": [{"message": {"role": "assistant", "content": json.dumps(plan)}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020},
    })


def use_transport(handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    openrouter._test_transport = httpx.MockTransport(wrapped)
    openrouter._client = None
    return seen


def overlaps(session: dict, busy: list[dict]) -> bool:
    start, end = replan._minutes(session["start"]), replan._minutes(session["end"])
    for entry in busy:
        if entry["date"] != session["date"]:
            continue
        b, e = replan._minutes(entry["start"]), replan._minutes(entry["end"])
        if start < e and end > b:
            return True
    return False


async def main() -> None:
    await dbmod.db.connect()
    try:
        # Tue DSA 19:00-20:30: missed. Wed Gym: done. Thu Reading: still ahead.
        # Mon Yoga: marked after it started. Mon Run: let go. A task: not a block.
        await add_item("dsa", "DSA", 1, "19:00", "20:30")
        await add_item("gym", "Gym", 2, "07:00", "08:00")
        await add_event("gym", "Gym", "2026-09-30", "done")
        await add_item("read", "Reading", 3, "21:00", "21:30")
        await add_item("yoga", "Yoga", 0, "06:00", "06:30", created="2026-09-28T09:00:00")
        await add_item("run", "Run", 0, "18:00", "19:00")
        await add_event("run", "Run", "2026-09-28", "dropped")
        await add_item("essay", "Essay", None, None, None, kind="task", mode="quick")

        print("missed")
        misses = await replan.missed(NOW)
        check("only the unhandled, ended block is missed",
              [(m["uid"], m["occurrence"]) for m in misses] == [("dsa", "2026-09-29")], misses)
        check("missed carries its time and length",
              misses and misses[0]["start"] == "19:00" and misses[0]["end"] == "20:30" and misses[0]["minutes"] == 90, misses)

        print("horizon")
        days = replan.horizon(NOW)
        check("rest of the week from Thursday", [d.isoformat() for d in days] == ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"])
        saturday = replan.horizon(datetime(2026, 10, 3, 9, 0))
        check("never fewer than three days", [d.isoformat() for d in saturday] == ["2026-10-03", "2026-10-04", "2026-10-05"])

        print("model plan, checked")
        plan = {
            "message": "Tuesday's DSA slipped. Friday 7 PM, same 90.",
            "sessions": [
                {"activity": "DSA", "date": "2026-10-01", "start": "19:00", "end": "20:30"},   # clashes with the fest
                {"activity": "dsa", "date": "2026-10-02", "start": "19:00", "end": "21:00"},   # too long: trimmed to 90
                {"activity": "DSA", "date": "2026-10-03", "start": "10:00", "end": "11:00"},   # nothing left to catch up
                {"activity": "Netflix", "date": "2026-10-02", "start": "21:00", "end": "22:00"},  # not theirs
                {"activity": "Gym", "date": "2026-10-03", "start": "08:00", "end": "09:00"},   # wasn't missed
                {"activity": "DSA", "date": "2026-10-09", "start": "10:00", "end": "11:00"},   # outside the days given
            ],
        }
        seen = use_transport(lambda request: model_answer(plan))
        result = await replan.propose(BUSY, current=NOW)
        sessions = result["sessions"]
        check("the model was asked once, for a strict schema on GPT-6 Luna", len(seen) == 1)
        sent = json.loads(seen[0].content) if seen else {}
        check("strict json_schema payload", sent.get("model") == "openai/gpt-6-luna"
              and sent.get("response_format", {}).get("json_schema", {}).get("strict") is True, sent.get("response_format"))
        prompt = json.loads(sent["messages"][1]["content"]) if sent else {}
        check("prompt has today's earliest start and the busy time",
              prompt.get("days", [{}])[0].get("earliest") == "15:10"
              and {"start": "18:00", "end": "22:00"} in prompt["days"][0]["scheduled"], prompt.get("days", [None])[0])
        check("one session kept, trimmed to the missed 90 minutes",
              [(s["title"], s["date"], s["start"], s["end"]) for s in sessions] == [("DSA", "2026-10-02", "19:00", "20:30")], sessions)
        check("it covers Tuesday's miss", sessions and sessions[0]["covers"] == {"uid": "dsa", "occurrence": "2026-09-29", "mode": "session"}, sessions)
        check("the model's line is used", result["source"] == "ai" and result["message"].startswith("Tuesday's DSA"), result)

        print("plain placer")
        result = await replan.propose(BUSY, current=NOW, use_model=False)
        sessions = result["sessions"]
        check("placed today, before the fest, clear of it",
              len(sessions) == 1 and sessions[0]["date"] == "2026-10-01" and not overlaps(sessions[0], BUSY)
              and replan._minutes(sessions[0]["end"]) <= 17 * 60 + 50, sessions)
        check("full 90 minutes, on 5-minute marks", sessions and sessions[0]["minutes"] == 90
              and sessions[0]["start"].endswith(("0", "5")), sessions)
        check("a plain message and source", result["source"] == "basic" and "DSA moves to Thu" in result["message"], result["message"])

        late = await replan.propose(BUSY, current=datetime(2026, 10, 1, 22, 55), use_model=False)
        check("nothing lands on a finished day",
              late["sessions"] and all(s["date"] != "2026-10-01" for s in late["sessions"]), late["sessions"])
        check("Friday's college is respected", all(not overlaps(s, BUSY) for s in late["sessions"]), late["sessions"])

        print("model unavailable or wrong -> plain placer")
        use_transport(lambda request: httpx.Response(500, json={"error": {"message": "upstream down"}}))
        result = await replan.propose(BUSY, current=NOW)
        check("a provider failure falls back", result["source"] == "basic" and len(result["sessions"]) == 1, result)
        use_transport(lambda request: httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}))
        result = await replan.propose(BUSY, current=NOW)
        check("an unreadable answer falls back", result["source"] == "basic" and len(result["sessions"]) == 1, result)
        use_transport(lambda request: model_answer({"message": "x", "sessions": [{"activity": "DSA", "date": "2026-10-01", "start": "19:00", "end": "20:30"}]}))
        result = await replan.propose(BUSY, current=NOW)
        check("an answer with nothing valid falls back", result["source"] == "basic"
              and not overlaps(result["sessions"][0], BUSY), result)
        openrouter._test_transport = None
        openrouter._client = None

        print("a packed week")
        packed = [{"date": f"2026-10-0{d}", "start": "00:00", "end": "24:00"} for d in (1, 2, 3, 4)]
        result = await replan.propose(packed, current=NOW, use_model=False)
        check("nothing fits: nothing proposed, honest message",
              result["sessions"] == [] and result["left"] and result["source"] == "none"
              and "No room" in result["message"], result)

        print("settle")
        recorded = await replan.settle([{"uid": "dsa", "occurrence": "2026-09-29"}], [{"uid": "ghost", "occurrence": "2026-09-29"}])
        check("moved is recorded; an unknown uid is ignored", recorded == 1)
        check("a moved occurrence is no longer missed", await replan.missed(NOW) == [])
        check("settling twice records nothing", await replan.settle([{"uid": "dsa", "occurrence": "2026-09-29"}], []) == 0)
        nothing = await replan.propose(BUSY, current=NOW, use_model=False)
        check("nothing missed: nothing to do", nothing["source"] == "none" and nothing["sessions"] == [] and nothing["missed"] == [])
        stats = await focus.stats(30)
        dsa = next((row for row in stats["items"] if row["uid"] == "dsa"), None)
        check("the skip still counts in the stats (honest)", dsa is not None and dsa["skipped"] >= 1 and dsa["done"] == 0, dsa)
        started = await focus.start("dsa", "2026-09-29")
        check("a moved occurrence can still be started late", started is not None and started["status"] == "running", started)

        print("routes")
        from app.api import focus as focus_api
        paths = {route.path for route in focus_api.router.routes}
        check("missed, catchup and settle are mounted",
              {"/focus/missed", "/focus/catchup", "/focus/catchup/settle"} <= paths, paths)
    finally:
        await dbmod.db.disconnect()

    print(f"\n{passed} passed, {len(failures)} failed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
