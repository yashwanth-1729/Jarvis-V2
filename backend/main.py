"""JARVIS FastAPI entry point.

Run from the `backend/` directory:

    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import (
    announcements,
    chat,
    dashboard,
    localstore,
    location,
    realtime,
    records,
    sentinel,
    tasks,
    voice,
)
from app.api.schemas import HealthOut
from app.core.config import settings
from app.db import crud
from app.db.database import db
from app.providers import close_providers
from app.services import scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)-18s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("jarvis")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()

    # The board holds outstanding work only. Completing a task normally clears
    # it on the spot; this catches anything left behind by an older build or a
    # crash, so stale "done" rows never accumulate.
    swept = await crud.sweep_completed_tasks()
    if swept:
        logger.info("Cleared %d completed task(s) off the board", swept)

    # Cross-device sync. There used to be a second engine here, running
    # against this process's own SQLite, for whichever platform did not set
    # jarvis_client_owned_data. As of 2026-09-12 every platform sets it: the
    # WebView (mobile or desktop) owns the data in IndexedDB and runs the
    # only sync engine, against Supabase, client-side (see
    # frontend/src/lib/syncClient.ts). Exactly one engine per device is the
    # whole point -- a second one here would race the client and double-write
    # the same rows to the mirror. If jarvis_client_owned_data is ever false
    # again (a build that reintroduces a backend-authoritative mode), sync
    # simply does not run; that mode does not currently exist, so there is
    # nothing here to start.
    if not settings.jarvis_client_owned_data:
        logger.warning(
            "jarvis_client_owned_data is false but no backend sync engine "
            "exists any more (removed 2026-09-12) -- this device will not sync."
        )

    # Makes the timetable act rather than merely exist. Off on mobile, where the
    # app is foreground-only by design and a background timer would be firing
    # into a process the OS is about to freeze.
    stop_scheduler = asyncio.Event()
    scheduler_task: asyncio.Task[None] | None = None
    if settings.scheduler_enabled:
        scheduler_task = asyncio.create_task(scheduler.run_forever(stop_scheduler))

    # Load the local English voice before anyone waits on it: the first Piper
    # inference pays a one-off graph-init cost. Desktop-only and non-fatal — if
    # it fails, English speech falls back to Sarvam at call time.
    if settings.jarvis_english_tts.lower() == "piper":
        from app.providers import get_english_tts_provider

        warm = getattr(get_english_tts_provider(), "warm", None)
        if warm is not None:
            asyncio.create_task(warm())

    if not settings.has_api_key:
        logger.warning(
            "SARVAM_API_KEY is not set in backend/.env. The dashboard will work, "
            "but chat, transcription and speech will fail."
        )
    logger.info(
        "JARVIS v%s ready — chat=%s/%s stt=%s/%s tts=%s/%s",
        __version__,
        settings.jarvis_chat_provider,
        settings.sarvam_chat_model,
        settings.jarvis_stt_provider,
        settings.sarvam_stt_model,
        settings.jarvis_tts_provider,
        settings.sarvam_tts_model,
    )
    try:
        yield
    finally:
        if scheduler_task is not None:
            stop_scheduler.set()
            scheduler_task.cancel()
            with suppress(asyncio.CancelledError):
                await scheduler_task
        await close_providers()
        await db.disconnect()


app = FastAPI(
    title="JARVIS",
    description="JARVIS 3 persistent AI personal command center backend.",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # Also accept any private-LAN address on the frontend port. Pinning a
    # literal LAN IP here means the app breaks every time DHCP hands this
    # machine a new address — which it has. This is a single-user tool bound to
    # a home network, so trusting RFC1918 origins on one known port is
    # proportionate and removes a recurring failure.
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(dashboard.router)
app.include_router(tasks.router)
app.include_router(voice.router)
app.include_router(realtime.router)
# Only meaningful when the client owns the data (mobile); the endpoints
# refuse otherwise, so registering unconditionally is harmless.
app.include_router(localstore.router)
# Entry point for the native always-on daemon; see native/jarvis-sentinel.
app.include_router(sentinel.router)
# What the scheduler wants said, and the reminders that feed it.
app.include_router(announcements.router)
# Direct editing of the boards, for a person rather than the agent.
app.include_router(records.router)

app.include_router(location.router)


@app.get("/api/health", response_model=HealthOut, tags=["meta"])
async def health() -> HealthOut:
    task_count = await db.fetch_value("SELECT COUNT(*) FROM tasks", default=0)
    return HealthOut(
        status="ok",
        version=__version__,
        model=settings.sarvam_chat_model,
        database=str(settings.db_file),
        api_key_configured=settings.has_api_key,
        details={
            "chat_provider": settings.jarvis_chat_provider,
            "stt_provider": settings.jarvis_stt_provider,
            "stt_model": settings.sarvam_stt_model,
            "tts_provider": settings.jarvis_tts_provider,
            "tts_model": settings.sarvam_tts_model,
            "voice_enabled": settings.jarvis_voice_enabled,
            "reasoning_effort": settings.sarvam_reasoning_effort or "default",
            "max_tokens": settings.jarvis_max_tokens,
            "tasks_stored": task_count,
            "cors_origins": settings.cors_origins,
            # True when the *client* owns the user's data and this is only
            # the AI runtime. The client reads this to decide whether its
            # own store or this one is authoritative.
            "client_owned_data": settings.jarvis_client_owned_data,
        },
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.jarvis_host,
        port=settings.jarvis_port,
        reload=True,
    )
