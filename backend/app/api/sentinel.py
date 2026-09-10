"""Entry point for the native always-on daemon (`native/jarvis-sentinel`).

Deliberately a separate router rather than an addition to `voice.py`: the
existing endpoints are the browser's contract and are left untouched. This one
exists purely so a process outside the browser can hand over an utterance.

Flow: daemon captures a WAV -> POST here -> transcribe -> run one agent turn ->
return what JARVIS said. The daemon does no interpretation of its own; all the
intelligence stays in Python where it belongs.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from app.api.schemas import SentinelReplyOut
from app.core.config import settings
from app.llm.agent import run_turn
from app.providers import get_stt_provider
from app.providers.base import ProviderError
from app.services import speech

logger = logging.getLogger("jarvis.api.sentinel")

router = APIRouter(prefix="/api/sentinel", tags=["sentinel"])


@router.post("/utterance", response_model=SentinelReplyOut)
async def utterance(request: Request) -> SentinelReplyOut:
    """Accept a raw WAV body from the daemon and run one full turn.

    The body is raw bytes rather than multipart: the daemon speaks WinHTTP with
    no form-encoding library, and a bare `audio/wav` POST keeps the C++ side to
    a single send call.
    """
    if not settings.jarvis_voice_enabled:
        raise HTTPException(status_code=404, detail="Voice is disabled on this server.")

    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio body.")
    if len(audio) > settings.max_audio_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Clip exceeds the {settings.jarvis_max_audio_mb:g} MB limit.",
        )

    try:
        stt = get_stt_provider()
        transcript = await stt.transcribe(
            audio, filename="sentinel.wav", content_type="audio/wav"
        )
    except ProviderError as exc:
        logger.warning("Sentinel transcription failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    spoken = transcript.text.strip()
    if not spoken:
        return SentinelReplyOut(heard="", reply="", spoke=False)

    language = await speech.current_language()
    logger.info("Sentinel heard: %s", spoken)

    # Voice persona, same as the websocket path — this reply is meant to be
    # heard, not read.
    reply_parts: list[str] = []
    async for event in run_turn(spoken, voice=True, language=language):
        if event["type"] == "text":
            reply_parts.append(event["data"]["text"])
        elif event["type"] == "error":
            logger.warning("Sentinel turn error: %s", event["data"]["message"])

    reply = "".join(reply_parts).strip()
    return SentinelReplyOut(heard=spoken, reply=reply, spoke=bool(reply))
