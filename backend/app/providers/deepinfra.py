"""DeepInfra providers -- cloud STT (Whisper large-v3) and English/Hindi TTS
(Kokoro-82M) for the cloud voice stack (``JARVIS_VOICE_STACK=cloud``).

Verified against DeepInfra's own API docs (2026-09-16), not assumed:

* Both are plain REST endpoints (``POST /v1/inference/{model}``), not
  WebSocket -- DeepInfra does not expose a streaming/partial-transcript or
  streaming-audio interface for either model. This provider therefore
  buffers a full utterance (post-VAD segment, same as Sarvam's own STT path
  today) and a full TTS chunk per call; the *pipeline* around it stays
  streaming (chunked LLM output -> one Kokoro call per chunk -> chunk N+1
  can be requested while chunk N plays), matching what the spec calls
  "efficient buffered utterance transcription while keeping the rest of the
  pipeline streaming."
* Whisper: multipart form upload (``audio=@file``), Bearer auth. Response
  includes ``text`` and a detected ``language`` code -- used directly as the
  turn's language signal rather than running a separate language-ID model
  (see ``WebSearchRouter``-style reasoning in openrouter.py: don't add a
  model call where a field you already have answers the question).
* Kokoro: JSON body ``{"text": ...}``, Bearer auth. The exact audio-encoding
  field in the response (base64 vs. url, sample rate) was NOT fully
  documented in DeepInfra's public reference page at verification time --
  ``_decode_audio`` below handles the two shapes DeepInfra's docs and
  changelog both mention (a base64 ``audio`` string, or an ``audio`` object
  with a ``url``) and raises a clear ``ProviderError`` on anything else, so
  a real key + first live call will surface exactly what's wrong rather
  than silently mis-parsing. **This has not been exercised against a real
  key or real audio bytes** -- flag any decode error here first.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

import httpx

from app.core.config import settings
from app.providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderUnavailable,
    Speech,
    Transcript,
)

logger = logging.getLogger("jarvis.providers.deepinfra")

API_BASE = "https://api.deepinfra.com/v1/inference"


def _require_key() -> str:
    key = settings.deepinfra_api_key.strip()
    if not key:
        raise ProviderNotConfigured(
            "DEEPINFRA_API_KEY is not set. Add it to backend/.env."
        )
    return key


def _raise_for_status(response: httpx.Response, body: bytes, what: str) -> None:
    if response.status_code < 400:
        return
    try:
        detail = json.loads(body)
        message = detail.get("error") or detail.get("detail") or body.decode(errors="replace")[:400]
    except (json.JSONDecodeError, UnicodeDecodeError):
        message = body.decode(errors="replace")[:400]

    if response.status_code in (401, 403):
        raise ProviderAuthError(
            f"DeepInfra rejected the API key on {what} ({response.status_code}): {message}. "
            "Check DEEPINFRA_API_KEY in backend/.env."
        )
    if response.status_code == 429:
        raise ProviderRateLimited(f"DeepInfra rate limited {what}: {message}")
    if response.status_code >= 500:
        raise ProviderUnavailable(f"DeepInfra {what} failed ({response.status_code}): {message}")
    raise ProviderError(f"DeepInfra rejected the {what} request ({response.status_code}): {message}")


class _DeepInfraBase:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=API_BASE,
                headers={"Authorization": f"bearer {_require_key()}"},
                timeout=httpx.Timeout(self._timeout, connect=10.0),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


class DeepInfraWhisperSTT(_DeepInfraBase):
    """``STTProvider`` — Whisper large-v3, English/Hindi/Telugu."""

    name = "deepinfra"

    def __init__(self) -> None:
        super().__init__(timeout=settings.deepinfra_timeout)
        self.model = settings.deepinfra_stt_model

    async def transcribe(
        self,
        audio: bytes,
        filename: str = "audio.webm",
        content_type: str = "audio/webm",
        language_code: str | None = None,
    ) -> Transcript:
        files = {"audio": (filename, audio, content_type)}
        # Whisper's own language codes are bare ("en", "hi", "te"), not the
        # app's region-tagged ones ("en-IN") -- strip the region if present.
        data: dict[str, Any] = {}
        if language_code:
            data["language"] = language_code.split("-")[0]
        try:
            response = await self._http().post(f"/{self.model}", files=files, data=data)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"DeepInfra STT request failed ({exc}).") from exc
        if response.status_code >= 400:
            _raise_for_status(response, response.content, "speech-to-text")
        body = response.json()
        text = str(body.get("text", "")).strip()
        return Transcript(
            text=text,
            language_code=body.get("language"),
            confidence=None,
        )


def _decode_audio(body: dict[str, Any]) -> bytes:
    """See module docstring -- the exact response shape is unverified
    against a live key. Handles both documented possibilities explicitly
    rather than guessing one and failing silently on the other."""
    audio = body.get("audio")
    if isinstance(audio, str) and audio:
        # Either a bare base64 string or a data: URI.
        raw = audio.split(",", 1)[-1] if audio.startswith("data:") else audio
        try:
            return base64.b64decode(raw)
        except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
            raise ProviderError(f"DeepInfra Kokoro returned undecodable audio: {exc}") from exc
    if isinstance(audio, dict) and audio.get("url"):
        raise ProviderError(
            "DeepInfra Kokoro returned a URL-based audio response "
            f"({audio['url']!r}) -- fetching by URL is not yet implemented; "
            "this needs a live key to confirm which shape the API actually returns."
        )
    raise ProviderError(
        f"DeepInfra Kokoro response has no recognizable 'audio' field: keys={list(body.keys())}"
    )


class DeepInfraKokoroTTS(_DeepInfraBase):
    """``TTSProvider`` — Kokoro-82M, routed here for English and Hindi only
    (``TTSRouter`` in ``speech.py`` sends Telugu to Soniox instead)."""

    name = "deepinfra"
    #: Not vendor-documented; matches this app's other TTS providers' order
    #: of magnitude rather than an unbounded request.
    max_chars = 4000

    def __init__(self) -> None:
        super().__init__(timeout=settings.deepinfra_timeout)
        self.model = settings.deepinfra_tts_model

    async def synthesize(
        self,
        text: str,
        language_code: str | None = None,
        speaker: str | None = None,
        pace: float | None = None,
    ) -> Speech:
        clean = (text or "").strip()
        if not clean:
            raise ProviderError("Nothing to speak.")
        payload: dict[str, Any] = {"text": clean[: self.max_chars]}
        if speaker:
            payload["voice"] = speaker
        if pace:
            payload["speed"] = pace
        try:
            response = await self._http().post(f"/{self.model}", json=payload)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"DeepInfra Kokoro request failed ({exc}).") from exc
        if response.status_code >= 400:
            _raise_for_status(response, response.content, "text-to-speech")
        body = response.json()
        audio_bytes = _decode_audio(body)
        content_type = "audio/wav" if str(body.get("output_format", "")).lower() == "wav" else "audio/mpeg"
        return Speech(audio=audio_bytes, content_type=content_type)
