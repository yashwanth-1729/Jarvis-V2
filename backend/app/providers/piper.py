"""Local English text-to-speech with Piper (neural, on-device, no network).

English replies are synthesized here instead of at Sarvam: it is free, private,
and has no per-call latency once the model is resident. Every other language
still goes to Sarvam, which speaks the Indic set that Piper's English voices do
not — see `app.services.speech` for the routing.

Piper is an ONNX model. Loading it and running inference are blocking CPU work,
so both happen on a worker thread via `asyncio.to_thread`; the event loop is
never held while audio is generated. The model is loaded once, lazily, and kept
resident. The first inference after a load pays a one-off graph-init cost
(measured ~2.5s), so `warm()` is called at startup to pay it before a user is
waiting on it.

This is desktop-only. The Android build runs the backend under Chaquopy on
arm64, where neither `onnxruntime` nor Piper's compiled phonemizer has a wheel;
mobile English TTS is handled separately.
"""

from __future__ import annotations

import asyncio
import io
import logging
import wave
from pathlib import Path
from typing import Any, AsyncIterator

from app.core.config import BACKEND_ROOT, settings
from app.providers.base import (
    AudioPacket,
    ProviderError,
    ProviderNotConfigured,
    Speech,
)

logger = logging.getLogger("jarvis.piper")

#: Piper voices are 16-bit mono PCM. The sample rate is read from the model
#: config at load time; this is only the fallback if that field is missing.
_FALLBACK_RATE = 22050

#: ~100ms of audio per streamed packet, matching the Sarvam streaming path so
#: the client's jitter buffer behaves the same whichever engine spoke.
_PACKET_SECONDS = 0.1


def _model_path() -> Path:
    """Absolute path to the configured .onnx voice, or raise if it is absent."""
    raw = Path(settings.jarvis_piper_model)
    path = raw if raw.is_absolute() else (BACKEND_ROOT / raw)
    if not path.exists():
        raise ProviderNotConfigured(
            f"Piper model not found at {path}. Download an English voice into "
            "backend/models/piper/ (see explanations.md) or set "
            "JARVIS_ENGLISH_TTS=sarvam to speak English through Sarvam instead."
        )
    return path


class PiperTTS:
    """A `TTSProvider` and `StreamingTTSProvider` backed by a local ONNX voice."""

    name = "piper"
    #: Piper phonemizes the whole string in memory; there is no vendor limit.
    #: The cap only stops a runaway generation, and sits well above one sentence.
    max_chars = 4000

    def __init__(self) -> None:
        self.model = Path(settings.jarvis_piper_model).name
        self._voice: Any | None = None
        self._rate: int = _FALLBACK_RATE
        self._load_lock = asyncio.Lock()

    # -- loading -----------------------------------------------------------
    def _load_sync(self) -> Any:
        # Imported lazily so a machine without piper-tts installed can still run
        # the rest of the backend; the import only happens when English speech
        # is actually requested through Piper.
        from piper import PiperVoice  # type: ignore

        path = _model_path()
        voice = PiperVoice.load(str(path))
        rate = getattr(getattr(voice, "config", None), "sample_rate", None)
        self._rate = int(rate) if rate else _FALLBACK_RATE
        return voice

    async def _ensure_voice(self) -> Any:
        if self._voice is not None:
            return self._voice
        async with self._load_lock:
            if self._voice is None:  # re-check inside the lock
                try:
                    self._voice = await asyncio.to_thread(self._load_sync)
                except ProviderNotConfigured:
                    raise
                except ImportError as exc:
                    raise ProviderNotConfigured(
                        "piper-tts is not installed. `pip install piper-tts` in "
                        "the backend venv, or set JARVIS_ENGLISH_TTS=sarvam."
                    ) from exc
                except Exception as exc:  # noqa: BLE001
                    raise ProviderError(f"Piper failed to load its voice: {exc}") from exc
                logger.info("Piper voice %s ready (%d Hz)", self.model, self._rate)
        return self._voice

    async def warm(self) -> None:
        """Load the model and run one throwaway inference, off the hot path.

        Called at startup so the first real reply does not pay the graph-init
        cost. Never raises: a warm-up failure just means the first utterance is
        slower, or that we fall back to Sarvam, both handled at call time.
        """
        try:
            voice = await self._ensure_voice()
            await asyncio.to_thread(lambda: list(voice.synthesize("ready", self._config(None))))
            logger.info("Piper warm-up complete")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Piper warm-up skipped: %s", exc)

    # -- synthesis ---------------------------------------------------------
    def _config(self, pace: float | None) -> Any:
        from piper import SynthesisConfig  # type: ignore

        # Piper's length_scale is duration, not rate: larger = slower. The rest
        # of the app expresses speed as `pace` (larger = faster, English 1.04),
        # so invert it, then apply the global nudge from .env. Clamp to a sane
        # band — outside roughly [0.6, 1.6] length_scale the voice distorts.
        speed = max(0.5, (pace or 1.0) * settings.jarvis_piper_pace)
        length_scale = max(0.6, min(1.0 / speed, 1.6))
        return SynthesisConfig(
            length_scale=round(length_scale, 3),
            volume=1.0,
            normalize_audio=True,
        )

    def _render_sync(self, voice: Any, text: str, pace: float | None) -> tuple[bytes, int]:
        pcm = bytearray()
        rate = self._rate
        for chunk in voice.synthesize(text, self._config(pace)):
            pcm.extend(chunk.audio_int16_bytes)
            rate = getattr(chunk, "sample_rate", rate)
        return bytes(pcm), rate

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
        voice = await self._ensure_voice()
        pcm, rate = await asyncio.to_thread(self._render_sync, voice, clean[: self.max_chars], pace)
        if not pcm:
            raise ProviderError("Piper produced no audio.")
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)  # 16-bit
            wav.setframerate(rate)
            wav.writeframes(pcm)
        return Speech(audio=out.getvalue(), content_type="audio/wav")

    async def stream_speech(
        self,
        text: str,
        language_code: str | None = None,
        speaker: str | None = None,
        pace: float | None = None,
    ) -> AsyncIterator[AudioPacket]:
        """Emit fixed-size PCM16 packets so playback starts before the whole
        sentence is rendered.

        Piper yields per-phrase chunks; those are re-cut to a steady packet
        size to match the client's buffer, exactly as the Sarvam stream path
        does. Generation runs on a worker thread and hands finished chunks back
        over a queue so the event loop stays free.
        """
        clean = (text or "").strip()
        if not clean:
            raise ProviderError("Nothing to speak.")
        voice = await self._ensure_voice()
        config = self._config(pace)

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[bytes, int] | None | Exception] = asyncio.Queue(maxsize=64)

        def produce() -> None:
            try:
                for chunk in voice.synthesize(clean[: self.max_chars], config):
                    rate = getattr(chunk, "sample_rate", self._rate)
                    loop.call_soon_threadsafe(queue.put_nowait, (chunk.audio_int16_bytes, rate))
            except Exception as exc:  # noqa: BLE001
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        worker = asyncio.create_task(asyncio.to_thread(produce))
        pending = bytearray()
        rate = self._rate
        emitted = False
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    if emitted:
                        raise ProviderError(f"Piper streaming failed mid-utterance: {item}") from item
                    raise ProviderError(f"Piper streaming failed: {item}") from item
                data, rate = item
                pending.extend(data)
                packet_bytes = int(rate * _PACKET_SECONDS) * 2  # 16-bit samples
                while len(pending) >= packet_bytes:
                    yield AudioPacket(bytes(pending[:packet_bytes]), rate)
                    del pending[:packet_bytes]
                    emitted = True
            if pending:
                yield AudioPacket(bytes(pending), rate)
                emitted = True
            if not emitted:
                raise ProviderError("Piper streaming returned no audio.")
        finally:
            worker.cancel()

    async def aclose(self) -> None:
        # ONNX runtime sessions are freed on GC; nothing to close explicitly.
        self._voice = None
