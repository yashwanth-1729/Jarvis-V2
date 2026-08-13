"""JARVIS v1 — FastAPI entry point.

Run from the `backend/` directory:

    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import chat, dashboard, tasks, voice
from app.api.schemas import HealthOut
from app.core.config import settings
from app.db.database import db
from app.providers import close_providers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)-18s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("jarvis")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()
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
        await close_providers()
        await db.disconnect()


app = FastAPI(
    title="JARVIS",
    description="Persistent AI personal command center — v1 backend.",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(dashboard.router)
app.include_router(tasks.router)
app.include_router(voice.router)


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
