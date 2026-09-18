"""Soniox TTS -- the cloud voice stack's Telugu voice.

Verified against Soniox's WebSocket TTS API reference (2026-09-16):

* ``wss://tts-rt.soniox.com/tts-websocket``, a genuinely real-time
  full-duplex stream -- text goes in, audio comes back on the same
  connection while more text is still being sent. This is the one provider
  in this whole cloud stack that does NOT need the "buffer a full chunk,
  make one request per chunk" pattern the others use: a single session can
  stay open for an entire reply, matching ``StreamingTTSProvider`` more
  naturally than the request/response ``TTSProvider`` shape.
* Session-start message carries ``api_key``, ``stream_id``, ``model``,
  ``language``, ``voice``, ``audio_format``; text messages carry ``text`` +
  ``text_end``; audio comes back as ``{"audio": "<base64>", "audio_end":
  bool}``; a final ``{"terminated": true}`` closes the stream out.
* **Not exercised against a real key.** The exact error-message shape on
  auth failure, rate limiting, or a malformed session-start was not in the
  public reference at verification time -- ``_raise_for_status``-equivalent
  handling here is best-effort from the generic WebSocket close-code
  semantics, not vendor-confirmed error bodies. First live call should be
  watched closely.

Implements both ``TTSProvider`` (one-shot ``synthesize``, for parity with
every other engine in this app) and ``StreamingTTSProvider``
(``stream_speech``, used by ``speech.stream()`` when incremental audio is
requested) -- see ``app/providers/base.py``.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import AsyncIterator

import websockets
from websockets.exceptions import WebSocketException

from app.core.config import settings
from app.providers.base import (
    AudioPacket,
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnavailable,
    Speech,
)

logger = logging.getLogger("jarvis.providers.soniox")

WS_URL = "wss://tts-rt.soniox.com/tts-websocket"

#: Soniox samples at 24kHz PCM by default for the ``pcm_s16le`` format,
#: matching this app's other streaming engines (Piper, Sarvam) closely
#: enough that no client-side resampling is needed.
_SAMPLE_RATE = 24000


def _require_key() -> str:
    key = settings.soniox_api_key.strip()
    if not key:
        raise ProviderNotConfigured("SONIOX_API_KEY is not set. Add it to backend/.env.")
    return key


class SonioxTTS:
    name = "soniox"
    #: Per Soniox's own text-message limit (5000 chars); this app's chunker
    #: never produces anything close to that, so this is a hard backstop.
    max_chars = 5000

    def __init__(self) -> None:
        self.model = settings.soniox_tts_model

    async def aclose(self) -> None:  # no pooled connection to close -- one WS per call
        return

    async def _session(self, text: str, language_code: str | None, speaker: str | None, pace: float | None):
        stream_id = f"jarvis-{id(text)}-{len(text)}"
        start_message = {
            "api_key": _require_key(),
            "stream_id": stream_id,
            "model": self.model,
            "language": (language_code or "te").split("-")[0],
            "voice": speaker or settings.soniox_tts_voice,
            "audio_format": "pcm_s16le",
            "sample_rate": _SAMPLE_RATE,
        }
        if pace:
            start_message["speed"] = max(0.7, min(1.3, pace))

        try:
            ws = await websockets.connect(WS_URL, open_timeout=10)
        except (OSError, WebSocketException) as exc:
            raise ProviderUnavailable(f"Soniox connection failed ({exc}).") from exc

        try:
            await ws.send(json.dumps(start_message))
            await ws.send(json.dumps({"stream_id": stream_id, "text": text, "text_end": True}))
        except WebSocketException as exc:
            await ws.close()
            raise ProviderUnavailable(f"Soniox send failed ({exc}).") from exc
        return ws, stream_id

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
        pcm = bytearray()
        async for packet in self.stream_speech(clean[: self.max_chars], language_code, speaker, pace):
            pcm.extend(packet.audio)
        if not pcm:
            raise ProviderError("Soniox produced no audio.")
        return Speech(audio=bytes(pcm), content_type="audio/L16")  # raw PCM16, caller wraps if a WAV is needed

    async def stream_speech(
        self,
        text: str,
        language_code: str | None = None,
        speaker: str | None = None,
        pace: float | None = None,
    ) -> AsyncIterator[AudioPacket]:
        clean = (text or "").strip()
        if not clean:
            raise ProviderError("Nothing to speak.")

        ws, stream_id = await self._session(clean[: self.max_chars], language_code, speaker, pace)
        emitted = False
        try:
            async for raw in ws:
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event.get("terminated"):
                    break
                audio_b64 = event.get("audio")
                if audio_b64:
                    try:
                        pcm = base64.b64decode(audio_b64)
                    except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
                        raise ProviderError(f"Soniox returned undecodable audio: {exc}") from exc
                    if pcm:
                        emitted = True
                        yield AudioPacket(pcm, _SAMPLE_RATE)
                if event.get("audio_end"):
                    break
        except WebSocketException as exc:
            if emitted:
                raise ProviderError(f"Soniox streaming failed mid-utterance: {exc}") from exc
            raise ProviderUnavailable(f"Soniox streaming failed: {exc}") from exc
        finally:
            await ws.close()

        if not emitted:
            raise ProviderError("Soniox streaming returned no audio.")
