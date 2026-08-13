"""POST /api/tasks/toggle — the one-click status control on the task board."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.api.dashboard import _brief_payload, _counts
from app.api.schemas import ToggleTaskRequest, ToggleTaskResponse, TaskOut
from app.db import crud
from app.services import proactive

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.post("/toggle", response_model=ToggleTaskResponse)
async def toggle_task(payload: ToggleTaskRequest) -> ToggleTaskResponse:
    """Set a task's status explicitly, or cycle it forward when none is given.

    Returns the refreshed counters and brief alongside the task so the dashboard
    can update the banner without a second request.
    """
    if payload.status is not None:
        task = await crud.update_task_status(payload.task_id, payload.status)
    else:
        task = await crud.toggle_task_status(payload.task_id)

    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {payload.task_id} not found")

    return ToggleTaskResponse(
        task=TaskOut(**task),
        counts=await _counts(),
        brief=_brief_payload(await proactive.build_brief()),
    )
