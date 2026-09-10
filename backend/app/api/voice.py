"""Voice endpoints — speech in, speech out.

    POST /api/voice/transcribe   multipart audio  -> { text, language_code }
    POST /api/voice/speak        { text }         -> audio/wav bytes

Both delegate to the configured provider, so swapping the speech vendor (v2)
does not touch this module.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.api.schemas import (
    LanguageOut,
    LanguageStateOut,
    SetLanguageRequest,
    SetVoiceRequest,
    SpeakRequest,
    TranscriptOut,
    VoiceConfigOut,
    VoiceOut,
)
from app.core.config import settings
from app.core.languages import DEFAULT_LANGUAGE, LANGUAGES, is_supported, resolve
from app.core.voices import VOICES
from app.core.voices import is_supported as voice_supported
from app.core.voices import resolve as resolve_voice
from app.db import crud
from app.providers import get_stt_provider
from app.services import speech
from app.providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
    ProviderOutOfCredit,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger("jarvis.api.voice")

router = APIRouter(prefix="/api/voice", tags=["voice"])


def _http_error(exc: ProviderError) -> HTTPException:
    """Map provider failures onto meaningful HTTP statuses."""
    if isinstance(exc, ProviderNotConfigured):
        return HTTPException(status_code=501, detail=str(exc))
    if isinstance(exc, ProviderAuthError):
        return HTTPException(status_code=502, detail=str(exc))
    # Passed through as 402 rather than folded into the generic 502, so the
    # client can tell "the account is empty" from "something broke" and stop
    # re-sending every utterance into a wall.
    if isinstance(exc, ProviderOutOfCredit):
        return HTTPException(status_code=402, detail=str(exc))
    if isinstance(exc, ProviderRateLimited):
        return HTTPException(status_code=429, detail=str(exc))
    if isinstance(exc, ProviderUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


def _guard_enabled() -> None:
    if not settings.jarvis_voice_enabled:
        raise HTTPException(status_code=404, detail="Voice is disabled on this server.")


@router.get("/config", response_model=VoiceConfigOut)
async def voice_config() -> VoiceConfigOut:
    """Lets the UI hide the mic and speaker controls when voice is unavailable."""
    current = await crud.get_preference(crud.PREF_VOICE_LANGUAGE, DEFAULT_LANGUAGE)
    chosen_voice = await speech.current_voice()
    return VoiceConfigOut(
        enabled=settings.jarvis_voice_enabled and settings.has_api_key,
        stt_provider=settings.jarvis_stt_provider,
        tts_provider=settings.jarvis_tts_provider,
        language=current if is_supported(current) else DEFAULT_LANGUAGE,
        max_audio_mb=settings.jarvis_max_audio_mb,
        languages=[
            LanguageOut(code=lang.code, label=lang.label, native=lang.native)
            for lang in LANGUAGES
        ],
        voice=chosen_voice.id,
        voices=[
            VoiceOut(id=v.id, label=v.label, gender=v.gender, note=v.note)
            for v in VOICES
        ],
    )


@router.put("/voice", response_model=VoiceOut)
async def set_voice(payload: SetVoiceRequest) -> VoiceOut:
    """Persist the speaking voice chosen in the UI.

    Shares its storage with the `set_voice` tool, so picking Kavya here and
    saying "use a girl's voice" converge on the same preference.
    """
    if not voice_supported(payload.voice):
        raise HTTPException(status_code=400, detail=f"Unknown voice {payload.voice!r}.")
    await crud.set_preference(crud.PREF_VOICE_SPEAKER, payload.voice)
    chosen = resolve_voice(payload.voice)
    return VoiceOut(
        id=chosen.id, label=chosen.label, gender=chosen.gender, note=chosen.note
    )


@router.put("/language", response_model=LanguageStateOut)
async def set_language(payload: SetLanguageRequest) -> LanguageStateOut:
    """Persist the spoken-output language chosen in the UI.

    Shared with the `set_language` tool, so picking Telugu here and saying
    "speak Telugu" converge on the same stored preference.
    """
    if not is_supported(payload.language):
        raise HTTPException(
            status_code=400, detail=f"Unsupported language {payload.language!r}."
        )
    await crud.set_preference(crud.PREF_VOICE_LANGUAGE, payload.language)
    chosen = resolve(payload.language)
    return LanguageStateOut(code=chosen.code, label=chosen.label, native=chosen.native)


@router.post("/transcribe", response_model=TranscriptOut)
async def transcribe(
    file: UploadFile = File(..., description="Recorded audio clip"),
    language_code: str | None = Form(default=None),
) -> TranscriptOut:
    _guard_enabled()

    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(audio) > settings.max_audio_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Clip exceeds the {settings.jarvis_max_audio_mb:g} MB limit.",
        )

    try:
        provider = get_stt_provider()
        result = await provider.transcribe(
            audio,
            filename=file.filename or "audio.webm",
            content_type=file.content_type or "application/octet-stream",
            language_code=language_code,
        )
    except ProviderError as exc:
        logger.warning("Transcription failed: %s", exc)
        raise _http_error(exc) from exc

    return TranscriptOut(
        text=result.text,
        language_code=result.language_code,
        confidence=result.confidence,
    )


@router.post("/speak")
async def speak(payload: SpeakRequest) -> Response:
    _guard_enabled()

    try:
        # Routed through the speech service so the one-shot endpoint gets the
        # same voice, pace and number handling as the realtime path.
        rendered = await speech.speak(
            payload.text,
            language_code=payload.language_code or await speech.current_language(),
        )
    except ProviderError as exc:
        logger.warning("Speech synthesis failed: %s", exc)
        raise _http_error(exc) from exc

    return Response(
        content=rendered.audio,
        media_type=rendered.content_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="jarvis.wav"',
        },
    )
