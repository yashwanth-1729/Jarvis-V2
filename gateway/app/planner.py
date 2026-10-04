"""``POST /v1/plan/week``: the onboarding's AI timetable (docs/public-edition.md).

The user says what they want in their week: activities, each with points on a
meter of 1-10 plus MAX (11) for how much of the week it should get. They also
give their wake/sleep times, any fixed hours (college, work), and whether they
want free blocks or a strict timetable. GPT-6 Luna lays out ONE weekly
timetable. They can push back ("gym too often", "more DSA", a free comment)
and get a revised plan.

Older clients still send importance (1-5) and an optional frequency. Both
are still accepted: importance maps to points x2, and a frequency, when
given, still wins.

Why it lives here and not in the app:

* **Before sign-in.** Onboarding comes before the account, so this is the one
  model call allowed without a token. It is safe to open because the prompt
  is built here from structured fields, so it cannot be used as a free
  general-purpose chatbot. Anonymous calls are limited per IP and paid from
  the shared free pool (``FREE_POOL_DAILY_AURA``). With a token, they're
  charged in Aura like any call.
* **The model's answer is checked, not trusted.** Blocks are clamped to the
  waking day, kept out of fixed hours, de-overlapped (the more important
  activity wins), limited to the user's own activities, rounded to 5 minutes,
  and tagged with a day phase here.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from decimal import Decimal
from typing import Any

import httpx
from fastapi import APIRouter, Request

from app.context import admit, gateway
from app.errors import GatewayError
from app.limits import read_json
from app.metering import chat_cost_usd, extract_chat_usage, usd_to_inr, usd_to_milli
from app.proxy import Charge, _settle_chat, _timeout, _upstream_headers

logger = logging.getLogger("holo.gateway.planner")

router = APIRouter()

MODEL = "openai/gpt-6-luna"
#: The points meter: 1-10, then MAX.
MAX_POINTS = 11
#: The free-time blocks a "leave me free time" plan includes.
FREE_NAME = "Free time"
FREQUENCIES = {"daily": 7, "6x": 6, "5x": 5, "4x": 4, "3x": 3, "2x": 2, "1x": 1}
PHASES = (("morning", 12 * 60), ("afternoon", 17 * 60), ("evening", 21 * 60), ("night", 24 * 60))

SYSTEM = """You build ONE weekly timetable for a young person in India. Answer with JSON only, matching the schema.

Rules:
- Use only the activities given, by their exact names.
- Each activity has points (1-10, or "MAX") saying how much of the week it should get compared with the others. Turn points into times per week and session length: 1-2 -> once, 3-4 -> twice, 5-6 -> 3 times, 7-8 -> 4-5 times, 9-10 -> 5-6 times, MAX -> daily or nearly, with the best slots. More points also means longer sessions within the sensible range. If an activity has a frequency, it wins (daily = 7).
- Pick sensible session lengths (gym ~60 min, deep study 60-120, coding 60-90, reading 30, meditation 15-20, a language 30, walk 30, practice 30-60).
- Everything between wake and sleep, never during the busy hours on busy days, no overlaps, at least 15 minutes between blocks, at most 5 activity blocks a day.
- freeTime true: also add blocks named exactly "Free time", 1-2 a day of 30-90 minutes (mostly evenings, more on weekends), so the week has breathing room. freeTime false: a strict timetable with no free-time blocks; the activities fill the week tightly but realistically.
- Leave ~30 minutes free after waking and before sleep.
- Keep the same activity at a consistent time across days. Put demanding focus work when energy is high (early birds: morning; night owls: evening). Spread repeats across the week and keep one lighter day.
- Days are 0=Monday ... 6=Sunday; times are 24h "HH:MM", start before end, inside one day.
- If a previous plan and feedback are given, change what the feedback asks ("less" = fewer or shorter sessions, "more" = more or longer) and follow the comment; keep everything else stable.
- summary: one short, friendly line about the week (under 120 characters)."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "blocks"],
    "properties": {
        "summary": {"type": "string"},
        "blocks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["activity", "day", "start", "end"],
                "properties": {
                    "activity": {"type": "string"},
                    "day": {"type": "integer"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                },
            },
        },
    },
}

# Anonymous use: tries per IP per UTC day (in memory; one gateway process).
_anon_counts: dict[tuple[str, str], int] = {}


def _minutes(value: Any) -> int | None:
    try:
        hours, minutes = str(value).strip().split(":")[:2]
        total = int(hours) * 60 + int(minutes)
    except (ValueError, AttributeError):
        return None
    return total if 0 <= total <= 24 * 60 else None


def _clock(total: int) -> str:
    total = max(0, min(total, 24 * 60 - 1))
    return f"{total // 60:02d}:{total % 60:02d}"


def _phase(start: int) -> str:
    for name, limit in PHASES:
        if start < limit:
            return name
    return "night"


def _clean_request(body: dict[str, Any]) -> dict[str, Any]:
    """Validate and bound what reaches the prompt."""
    wake, sleep = _minutes(body.get("wake")), _minutes(body.get("sleep"))
    if wake is None or sleep is None:
        raise GatewayError(400, "invalid_request", "wake and sleep must be HH:MM.")
    activities = []
    seen: set[str] = set()
    for raw in body.get("activities") or []:
        if not isinstance(raw, dict):
            continue
        name = " ".join(str(raw.get("name") or "").split())[:40]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        if name.lower() == FREE_NAME.lower():
            continue  # free time is asked for with freeTime, not as an activity
        points = raw.get("points")
        if not (isinstance(points, int) and not isinstance(points, bool) and 1 <= points <= MAX_POINTS):
            importance = raw.get("importance")
            valid = isinstance(importance, int) and not isinstance(importance, bool) and 1 <= importance <= 5
            points = importance * 2 if valid else 5
        activity: dict[str, Any] = {"name": name, "points": "MAX" if points == MAX_POINTS else points, "rank": points}
        if raw.get("frequency") in FREQUENCIES:
            activity["frequency"] = raw["frequency"]
        activities.append(activity)
    if not activities:
        raise GatewayError(400, "invalid_request", "Add at least one activity.")
    activities = activities[:12]
    busy = body.get("busy")
    clean_busy = None
    if isinstance(busy, dict):
        start, end = _minutes(busy.get("start")), _minutes(busy.get("end"))
        days = sorted({d for d in busy.get("days") or [] if isinstance(d, int) and 0 <= d <= 6})
        if start is not None and end is not None and start < end and days:
            clean_busy = {"label": str(busy.get("label") or "Busy")[:24], "days": days,
                          "start": _clock(start), "end": _clock(end)}
    feedback = [
        {"activity": str(f.get("activity"))[:40], "change": f.get("change")}
        for f in body.get("feedback") or []
        if isinstance(f, dict) and f.get("change") in ("less", "more")
    ][:12]
    previous = [
        b for b in body.get("previous") or []
        if isinstance(b, dict) and str(b.get("activity") or "").strip().lower() != FREE_NAME.lower()
    ][:40]
    return {
        "wake": _clock(wake), "sleep": _clock(sleep),
        "chronotype": body.get("chronotype") if body.get("chronotype") in ("early", "night") else None,
        "stage": str(body.get("stage") or "")[:20] or None,
        "exam": str(body.get("exam") or "")[:20] or None,
        "goals": [str(g)[:40] for g in (body.get("goals") or [])][:3],
        "interests": [str(i)[:30] for i in (body.get("interests") or [])][:12],
        "busy": clean_busy,
        "freeTime": body.get("freeTime") is True,
        "activities": activities,
        "previous": [{k: b.get(k) for k in ("activity", "day", "start", "end")} for b in previous] or None,
        "feedback": feedback or None,
        "comment": " ".join(str(body.get("comment") or "").split())[:300] or None,
    }


def _prompt_view(clean: dict[str, Any]) -> dict[str, Any]:
    """What the model sees: the request without internal fields."""
    view = dict(clean)
    view["activities"] = [{k: v for k, v in a.items() if k != "rank"} for a in clean["activities"]]
    return view


def _repair(plan: dict[str, Any], request: dict[str, Any]) -> list[dict[str, Any]]:
    """Make the model's blocks safe to save, whatever it returned."""
    names = {a["name"].lower(): a for a in request["activities"]}
    if request.get("freeTime"):
        # Free time loses every overlap and never runs long.
        names[FREE_NAME.lower()] = {"name": FREE_NAME, "rank": 0, "free": True}
    wake = _minutes(request["wake"]) or 0
    sleep = _minutes(request["sleep"]) or 24 * 60
    if sleep <= wake:  # asleep after midnight: the day runs to its end
        sleep = 24 * 60
    busy = request["busy"]
    busy_days = set(busy["days"]) if busy else set()
    busy_start = _minutes(busy["start"]) if busy else None
    busy_end = _minutes(busy["end"]) if busy else None

    candidates = []
    for block in plan.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        activity = names.get(str(block.get("activity") or "").strip().lower())
        day = block.get("day")
        start, end = _minutes(block.get("start")), _minutes(block.get("end"))
        if activity is None or not isinstance(day, int) or not 0 <= day <= 6 or start is None or end is None:
            continue
        start, end = round(start / 5) * 5, round(end / 5) * 5
        start, end = max(start, wake), min(end, sleep)
        free = bool(activity.get("free"))
        if end - start < (20 if free else 10) or end - start > (120 if free else 240):
            continue
        if day in busy_days and busy_start is not None and start < busy_end and end > busy_start:
            continue
        candidates.append({"activity": activity["name"], "rank": activity["rank"], "free": free,
                           "day": day, "start": start, "end": end})

    # Overlaps: more points keeps the slot; free time always yields, 3 a day at most.
    kept: list[dict[str, Any]] = []
    for block in sorted(candidates, key=lambda b: (-b["rank"], b["day"], b["start"])):
        if any(k["day"] == block["day"] and block["start"] < k["end"] and block["end"] > k["start"] for k in kept):
            continue
        if block["free"] and sum(1 for k in kept if k["free"] and k["day"] == block["day"]) >= 3:
            continue
        kept.append(block)
    kept.sort(key=lambda b: (b["day"], b["start"]))
    out = []
    for b in kept:
        block = {"activity": b["activity"], "day": b["day"], "start": _clock(b["start"]),
                 "end": _clock(b["end"]), "phase": _phase(b["start"])}
        if b["free"]:
            block["free"] = True
        out.append(block)
    return out


def _per_activity(blocks: list[dict[str, Any]], request: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for activity in request["activities"]:
        mine = [b for b in blocks if b["activity"] == activity["name"]]
        minutes = [(_minutes(b["end"]) or 0) - (_minutes(b["start"]) or 0) for b in mine]
        out.append({"activity": activity["name"], "timesPerWeek": len(mine),
                    "minutesPerSession": round(sum(minutes) / len(minutes)) if minutes else 0})
    return out


def _client_ip(request: Request) -> str:
    # cloudflared passes the caller's address through.
    return (request.headers.get("cf-connecting-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown"))


def _count_anonymous(gw: Any, ip: str) -> None:
    day = gw.clock().strftime("%Y-%m-%d")
    for key in [k for k in _anon_counts if k[0] != day]:
        _anon_counts.pop(key, None)
    used = _anon_counts.get((day, ip), 0)
    if used >= gw.settings.plan_anon_daily_per_ip:
        raise GatewayError(
            429, "rate_limited",
            "That's a lot of plans for one day. Try again tomorrow, or set your week up yourself.",
            headers={"Retry-After": "3600"},
        )
    _anon_counts[(day, ip)] = used + 1


@router.post("/v1/plan/week")
async def plan_week(request: Request) -> dict[str, Any]:
    gw = gateway(request)
    if not gw.settings.openrouter_api_key:
        raise GatewayError(503, "gateway_not_configured", "The AI service is not configured yet.")
    body = await read_json(request, gw.settings.max_body_bytes)
    clean = _clean_request(body)
    price = gw.models.get(MODEL, "chat")
    if price is None:
        raise GatewayError(503, "gateway_not_configured", "The planner model is not enabled.")

    signed_in = bool(request.headers.get("authorization", "").strip())
    charge: Charge | None = None
    anon_id = ""
    if signed_in:
        principal, _ = await admit(request)
        reservation = await gw.bank.reserve(
            principal.user_id, "plan", MODEL, int(gw.settings.reserve_aura_chat * 1000),
        )
        charge = Charge(gw, reservation, streamed=False)
    else:
        ip = _client_ip(request)
        _count_anonymous(gw, ip)
        if not await gw.bank.free_pool_allows(int(gw.settings.reserve_aura_chat * 1000)):
            raise GatewayError(
                429, "free_pool_exhausted",
                "Free planning is all used up for today. It's back at midnight.",
            )
        anon_id = "anon:" + hashlib.sha256(ip.encode()).hexdigest()[:16]

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(_prompt_view(clean), ensure_ascii=False)},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "week_plan", "strict": True, "schema": SCHEMA}},
        "reasoning": {"effort": "low"},
        "max_tokens": gw.settings.max_output_tokens,
        "usage": {"include": True},
    }
    started = time.perf_counter()
    try:
        upstream = await gw.upstream.post(
            "/chat/completions", json=payload, headers=_upstream_headers(gw),
            timeout=_timeout(gw, max(gw.settings.openrouter_chat_timeout, 60.0)),
        )
    except httpx.HTTPError as exc:
        if charge:
            await charge.settle(status="upstream_unreachable", milli=0)
        raise GatewayError(502, "upstream_unreachable", "Couldn't reach the planner. Try again.") from exc
    if upstream.status_code >= 400:
        if charge:
            await charge.settle(status="upstream_error", milli=0, http_status=upstream.status_code)
        logger.warning("planner upstream %s: %s", upstream.status_code, upstream.text[:300])
        raise GatewayError(502, "upstream_error", "The planner stumbled. Try again.")
    data = upstream.json() if upstream.content else {}
    data = data if isinstance(data, dict) else {}

    # Meter first, whatever the content: the call happened.
    if charge:
        await _settle_chat(gw, price, charge, data.get("usage"), status="ok",
                           http_status=upstream.status_code, generation_id=data.get("id"))
    else:
        usage = extract_chat_usage(data.get("usage"))
        cost = chat_cost_usd(price, usage) if usage else Decimal(0)
        if usage and usage.upstream_cost and usage.upstream_cost > cost:
            cost = usage.upstream_cost
        await gw.bank.record_anonymous(anon_id, "plan", MODEL, usd_to_milli(cost, gw.settings), {
            "status": "ok", "http_status": upstream.status_code, "cost_usd": float(cost),
            "cost_inr": float(usd_to_inr(cost, gw.settings)),
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "prompt_tokens": usage.prompt_tokens if usage else 0,
            "completion_tokens": usage.completion_tokens if usage else 0,
        })

    try:
        content = data["choices"][0]["message"]["content"]
        plan = json.loads(content) if isinstance(content, str) else content
    except (KeyError, IndexError, TypeError, ValueError):
        plan = None
    if not isinstance(plan, dict):
        raise GatewayError(502, "plan_failed", "The planner returned something unreadable. Try again.")
    blocks = _repair(plan, clean)
    if not any(not b.get("free") for b in blocks):
        raise GatewayError(502, "plan_failed", "Couldn't fit that week. Try fewer activities or wider hours.")
    summary = " ".join(str(plan.get("summary") or "").split())[:160] or "Your week, balanced."
    logger.info("plan: %d blocks for %d activities in %.1fs", len(blocks), len(clean["activities"]),
                time.perf_counter() - started)
    return {"blocks": blocks, "summary": summary, "perActivity": _per_activity(blocks, clean)}

