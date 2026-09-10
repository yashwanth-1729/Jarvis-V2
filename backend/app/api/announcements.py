"""What JARVIS wants to say, and the client that says it.

The scheduler decides *what* is worth interrupting for. It cannot decide *how*,
because the backend has no speaker and no notification tray -- on the desktop it
is a uvicorn process, and the audio device belongs to the browser or the Tauri
webview. So the split is: the backend produces announcements, the client drains
them and delivers them however it can (speak them, toast them, badge them).

That split also survives the app being closed. Announcements accumulate in the
database whether or not anything is listening, so opening JARVIS after lunch
still surfaces the reminder that came due during it, rather than that reminder
having been shouted into an empty room.

    GET    /api/announcements          what is waiting
    POST   /api/announcements/ack      mark them delivered
    POST   /api/reminders              set one directly (the UI, not the agent)
    GET    /api/reminders              what is still pending
    DELETE /api/reminders/{id}         cancel one
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.api.schemas import (
    AcknowledgeRequest,
    AnnouncementOut,
    AnnouncementsResponse,
    ReminderCreate,
    ReminderOut,
)
from app.core.timeutil import normalize_datetime, now, parse_datetime
from app.db import crud
from app.services import notification_policy

logger = logging.getLogger("jarvis.api.announcements")

router = APIRouter(tags=["announcements"])


@router.get("/api/notifications/policy")
async def get_notification_policy() -> dict:
    """Current alarm-selection policy for the local/native client."""
    return await notification_policy.load()


@router.get("/api/announcements", response_model=AnnouncementsResponse)
async def list_announcements(limit: int = 20) -> AnnouncementsResponse:
    rows = await crud.pending_announcements(limit=max(1, min(limit, 100)))
    return AnnouncementsResponse(
        announcements=[AnnouncementOut(**row) for row in rows]
    )


@router.post("/api/announcements/ack", status_code=204)
async def acknowledge(payload: AcknowledgeRequest) -> None:
    """Mark announcements delivered.

    The client acknowledges *after* delivering, not on receipt: a page that
    fetches and is then closed before speaking should find the announcement
    still waiting next time, not silently consumed.
    """
    updated = await crud.mark_announcements_delivered(payload.ids)
    logger.info("Delivered %d announcement(s)", updated)


@router.post("/api/reminders", response_model=ReminderOut, status_code=201)
async def create_reminder(payload: ReminderCreate) -> ReminderOut:
    when = normalize_datetime(payload.due_at)
    if when is None:
        raise HTTPException(422, f"Could not read '{payload.due_at}' as a datetime.")
    moment = parse_datetime(when)
    if moment is not None and moment <= now():
        raise HTTPException(422, "That time has already passed.")
    reminder = await crud.create_reminder(payload.text, when)
    await notification_policy.allow_specific(f"reminder:{reminder['id']}")
    return ReminderOut(**reminder)


@router.get("/api/reminders", response_model=list[ReminderOut])
async def list_reminders(include_fired: bool = False) -> list[ReminderOut]:
    rows = await crud.list_reminders(include_fired=include_fired)
    return [ReminderOut(**row) for row in rows]


@router.delete("/api/reminders/{reminder_id}", status_code=204)
async def delete_reminder(reminder_id: int) -> None:
    if await crud.delete_reminder(reminder_id) is None:
        raise HTTPException(404, f"No reminder with id {reminder_id}.")


@router.post("/api/reminders/native-fired", status_code=204)
async def mark_native_reminders_fired(payload: AcknowledgeRequest) -> None:
    """Reconcile alarms Android delivered while the Python runtime was closed."""
    for reminder_id in payload.ids:
        if await crud.get_reminder(reminder_id) is not None:
            await crud.mark_reminder_fired(reminder_id)
