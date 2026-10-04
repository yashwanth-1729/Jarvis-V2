"""Serious mode over HTTP (services/focus.py). Mounted under /api by records."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import focus, replan

router = APIRouter(prefix="/focus", tags=["focus"])


class FocusItemIn(BaseModel):
    kind: Literal["task", "block"]
    mode: Literal["session", "quick"] = "session"
    title: str = Field(min_length=1, max_length=300)
    block_kind: str | None = None
    day_of_week: int | None = Field(default=None, ge=0, le=6)
    start_time: str | None = None
    end_time: str | None = None
    time_start: str | None = None
    time_end: str | None = None
    due_date: str | None = None


class OccurrenceIn(BaseModel):
    occurrence: str | None = None


@router.get("")
async def overview() -> dict[str, Any]:
    """Serious items and the events that say where each stands today."""
    return {"items": await focus.list_items(), "events": await focus.recent_events()}


@router.put("/items/{uid}")
async def mark(uid: str, payload: FocusItemIn) -> dict[str, Any]:
    return await focus.upsert_item(uid, payload.model_dump())


@router.delete("/items/{uid}", status_code=204)
async def unmark(uid: str) -> None:
    if not await focus.remove_item(uid):
        raise HTTPException(404, "That is not marked serious.")


@router.post("/items/{uid}/start")
async def start(uid: str, payload: OccurrenceIn | None = None) -> dict[str, Any]:
    event = await focus.start(uid, payload.occurrence if payload else None)
    if event is None:
        raise HTTPException(404, "That is not marked serious.")
    return event


@router.post("/items/{uid}/done")
async def done(uid: str, payload: OccurrenceIn | None = None) -> dict[str, Any]:
    event = await focus.finish(uid, payload.occurrence if payload else None)
    if event is None:
        raise HTTPException(404, "That is not marked serious.")
    return event


@router.post("/items/{uid}/reset")
async def reset(uid: str, payload: OccurrenceIn | None = None) -> dict[str, int]:
    return {"removed": await focus.reset(uid, payload.occurrence if payload else None)}


@router.get("/stats")
async def stats(days: int = 30) -> dict[str, Any]:
    return await focus.stats(days)


@router.get("/week")
async def week() -> dict[str, Any]:
    """The honest number: time locked in and the plan kept, this week vs last."""
    return await focus.week()


# --------------------------------------------------- catch-up (services/replan.py)

class BusyIn(BaseModel):
    date: str = Field(min_length=10, max_length=10)
    start: str = Field(min_length=1, max_length=8)
    end: str | None = Field(default=None, max_length=8)


class CatchUpIn(BaseModel):
    #: What is already booked on the coming days (the client owns the schedule).
    busy: list[BusyIn] = Field(default_factory=list, max_length=400)


class OccurrenceRef(BaseModel):
    uid: str = Field(min_length=1, max_length=200)
    occurrence: str = Field(min_length=10, max_length=10)


class SettleIn(BaseModel):
    moved: list[OccurrenceRef] = Field(default_factory=list, max_length=60)
    dropped: list[OccurrenceRef] = Field(default_factory=list, max_length=60)


@router.get("/missed")
async def missed() -> dict[str, Any]:
    """Serious blocks that slipped this week and haven't been dealt with."""
    return {"missed": await replan.missed()}


@router.post("/catchup")
async def catch_up(payload: CatchUpIn) -> dict[str, Any]:
    """Catch-up sessions for what slipped: GPT-6 Luna's, checked, or the plain placer's."""
    return await replan.propose([entry.model_dump() for entry in payload.busy])


@router.post("/catchup/settle")
async def settle(payload: SettleIn) -> dict[str, int]:
    """Moved (a catch-up covers it) or let go: either way, off the missed list."""
    return {
        "recorded": await replan.settle(
            [ref.model_dump() for ref in payload.moved], [ref.model_dump() for ref in payload.dropped],
        )
    }
