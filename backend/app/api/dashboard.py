"""GET /api/dashboard — everything the right-hand pane renders, in one round trip."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.api.schemas import (
    BriefOut,
    DashboardOut,
    IdeaOut,
    MemoryOut,
    ScheduleEventOut,
    TaskCounts,
    TaskOut,
)
from app.core.timeutil import now_iso
from app.db import crud
from app.services import proactive

router = APIRouter(prefix="/api", tags=["dashboard"])


def _brief_payload(brief: dict) -> BriefOut:
    return BriefOut(
        id=brief.get("id"),
        summary_text=brief["summary_text"],
        urgent_count=brief["urgent_count"],
        generated_at=brief.get("generated_at"),
        bullets=brief.get("bullets") or [],
    )


async def _counts() -> TaskCounts:
    counts = await crud.count_tasks_by_status()
    overdue = await crud.overdue_tasks()
    return TaskCounts(
        PENDING=counts["PENDING"],
        IN_PROGRESS=counts["IN_PROGRESS"],
        COMPLETED=counts["COMPLETED"],
        OVERDUE=len(overdue),
    )


@router.get("/dashboard", response_model=DashboardOut)
async def get_dashboard(
    include_completed: bool = Query(
        default=True, description="Include COMPLETED tasks in the task board."
    ),
    horizon_days: int = Query(default=14, ge=1, le=90),
) -> DashboardOut:
    statuses = (
        ("PENDING", "IN_PROGRESS", "COMPLETED")
        if include_completed
        else ("PENDING", "IN_PROGRESS")
    )

    tasks = await crud.list_tasks(statuses=statuses)
    today = await crud.todays_schedule()
    upcoming = await crud.upcoming_schedule(days=horizon_days)
    ideas = await crud.list_ideas()
    memories = await crud.list_memories(limit=50)
    brief = await proactive.get_or_build_brief()

    return DashboardOut(
        generated_at=now_iso(),
        counts=await _counts(),
        brief=_brief_payload(brief),
        tasks=[TaskOut(**task) for task in tasks],
        today=[ScheduleEventOut(**event) for event in today],
        upcoming=[ScheduleEventOut(**event) for event in upcoming],
        ideas=[IdeaOut(**idea) for idea in ideas],
        memories=[MemoryOut(**memory) for memory in memories],
    )


@router.post("/briefs/generate", response_model=BriefOut)
async def regenerate_brief() -> BriefOut:
    """Force a fresh proactive brief, bypassing the freshness window."""
    return _brief_payload(await proactive.build_brief())
