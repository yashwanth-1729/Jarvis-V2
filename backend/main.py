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
    agent_runs,
    announcements,
    chat,
    connectors,
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
from app.agent_runtime.approvals import LocalAuthenticator
from app.agent_runtime.database import runtime_db
from app.agent_runtime.repository import RuntimeRepository
from app.agent_runtime.worker import ReadOnlyFixtureAdapter, ReadOnlyWorker
from app.providers import (
    ProviderNotConfigured,
    close_providers,
    get_chat_provider,
    get_english_tts_provider,
    get_stt_provider,
)
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
    await runtime_db.connect()
    app.state.agent_pairing_enabled = bool(settings.jarvis_agent_pairing_secret)
    app.state.agent_auth = LocalAuthenticator(settings.jarvis_agent_pairing_secret or 'runtime-api-disabled')
    app.state.agent_repository = RuntimeRepository(runtime_db)
    app.state.agent_worker = ReadOnlyWorker(
        app.state.agent_repository,
        ReadOnlyFixtureAdapter(
            {
                "desktop-installed-path": (
                    "The installed desktop window reached its owned local backend "
                    "and completed a read-only verified fixture."
                )
            }
        ),
        worker_id="desktop-fixture-worker",
    )

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

    # Warn about the key the active stack actually needs. On Android the
    # OpenRouter key arrives moments later via the BYOK credentials endpoint,
    # so this is informational there, not an error.
    if settings.jarvis_voice_stack == "cloud":
        if not settings.has_openrouter_key:
            logger.warning(
                "OPENROUTER_API_KEY is not set yet. Chat, transcription and speech "
                "will fail until it is (Android supplies it from the client on connect)."
            )
    elif not settings.has_api_key:
        logger.warning(
            "SARVAM_API_KEY is not set in backend/.env. The dashboard will work, "
            "but chat, transcription and speech will fail."
        )
    # Report what the getters actually resolve to, not the raw legacy
    # setting strings -- those still say "sarvam" under the cloud stack and
    # made the startup log look like Sarvam was being called.
    from app.providers import get_chat_provider, get_english_tts_provider, get_stt_provider

    chat_p, stt_p, tts_p = (
        _resolved(g) for g in (get_chat_provider, get_stt_provider, get_english_tts_provider)
    )
    logger.info(
        "JARVIS v%s ready — stack=%s chat=%s/%s stt=%s/%s english-tts=%s/%s",
        __version__, settings.jarvis_voice_stack, *chat_p, *stt_p, *tts_p,
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
        from app.connectors import registry as connector_registry

        await connector_registry.close()
        await runtime_db.disconnect()
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
app.include_router(agent_runs.router)
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
# Google + MCP connectors (definitions and secrets come from the client).
app.include_router(connectors.router)


def _resolved(getter: object) -> tuple[str, str]:
    """(name, model) of whatever a provider getter actually resolves to right
    now -- not the raw legacy setting string, which stayed "sarvam" even
    after `JARVIS_VOICE_STACK=cloud` started routing chat/STT/English TTS
    elsewhere, and was confusing to see reported as-is (it looked like
    Sarvam was still being called when it wasn't)."""
    try:
        provider = getter()  # type: ignore[operator]
        return provider.name, getattr(provider, "model", "")
    except ProviderNotConfigured as exc:
        return "unconfigured", str(exc)


@app.get("/api/health", response_model=HealthOut, tags=["meta"])
async def health() -> HealthOut:
    task_count = await db.fetch_value("SELECT COUNT(*) FROM tasks", default=0)
    chat_name, chat_model = _resolved(get_chat_provider)
    stt_name, stt_model = _resolved(get_stt_provider)
    tts_name, tts_model = _resolved(get_english_tts_provider)
    return HealthOut(
        status="ok",
        version=__version__,
        model=chat_model or settings.sarvam_chat_model,
        database=str(settings.db_file),
        api_key_configured=settings.has_api_key,
        gemini_key_configured=settings.has_gemini_key,
        openrouter_key_configured=settings.has_openrouter_key,
        details={
            "voice_stack": settings.jarvis_voice_stack,
            "chat_provider": chat_name,
            "stt_provider": stt_name,
            "stt_model": stt_model,
            # English TTS specifically, since that's the language people
            # actually mean when they ask "why is this calling Sarvam" --
            # the catch-all get_tts_provider() for the 8 other Indic
            # languages Kokoro/Grok don't cover is deliberately still Sarvam.
            "tts_provider": tts_name,
            "tts_model": tts_model,
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
