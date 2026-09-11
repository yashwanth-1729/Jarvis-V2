"""One place that turns reply text into audio.

Both speech paths — the realtime websocket and the one-shot `/speak` endpoint —
go through here, so the spoken language, the selected voice, the per-language
pace and the number handling can never drift apart between them.
"""

from __future__ import annotations

import io
import logging
import struct
import wave
from typing import AsyncIterator

from app.core.config import settings

from app.core.languages import DEFAULT_LANGUAGE, is_supported
from app.core.languages import resolve as resolve_language
from app.core.speechtext import spell_numbers_in_english
from app.core.voices import Voice
from app.core.voices import resolve as resolve_voice
from app.db import crud
from app.providers import get_english_tts_provider, get_tts_provider
from app.providers.base import (
    AudioPacket,
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
    ProviderOutOfCredit,
    Speech,
    StreamingTTSProvider,
    TTSProvider,
)


logger = logging.getLogger("jarvis.speech")

#: Silence left at the end of a trimmed clip, in milliseconds.
#:
#: Not zero. Sentences run together with no pause at all sound hurried and
#: swallow the full stop; a short, *consistent* beat reads as natural speech.
#: The point of trimming is evenness, not speed.
TAIL_PAD_MS = 70

#: Amplitude below this fraction of the clip's peak counts as silence.
#:
#: -46dB, chosen from measurement rather than taste. The vendor's padding is not
#: digital silence -- it decays smoothly -- so there is no threshold that cleanly
#: separates "speech" from "padding". At a 2% (-34dB) floor the trim was eating
#: the last 16-33ms of real words, and the loudest sample it discarded sat at
#: 1.9% of peak: a trailing fricative, exactly the sound most likely to be
#: mistaken for silence. Dropping to 0.5% costs about 11ms of padding removal
#: and puts the cut safely below anything audible.
#:
#: Evenness does not depend on this number -- the fixed tail below guarantees
#: that -- so it is free to be conservative.
_SILENCE_FLOOR = 0.005


def trim_silence(audio: bytes, pad_ms: int = TAIL_PAD_MS) -> bytes:
    """Strip the vendor's padding and leave a fixed beat at the end.

    Spoken replies are synthesized one sentence at a time and scheduled
    back-to-back by the client, so any silence baked into a clip becomes a gap
    the listener hears *between* lines. Measured on bulbul:v3, that padding is
    both large and erratic -- 93ms, 166ms, 278ms across three consecutive
    sentences -- which is why the rhythm wobbles rather than merely dragging.

    Returns the audio unchanged if it cannot be parsed: a clip that plays with
    an ugly pause is far better than one that does not play.
    """
    try:
        with wave.open(io.BytesIO(audio)) as source:
            channels = source.getnchannels()
            width = source.getsampwidth()
            rate = source.getframerate()
            frames = source.readframes(source.getnframes())

        if width != 2 or not frames:  # 16-bit PCM is all bulbul returns
            return audio

        samples = struct.unpack(f"<{len(frames) // 2}h", frames)
        # Peak-track a stereo clip on one channel; the padding is identical.
        probe = samples[::channels] if channels > 1 else samples
        peak = max((abs(s) for s in probe), default=0)
        if peak == 0:
            return audio

        floor = peak * _SILENCE_FLOOR
        first = next((i for i, s in enumerate(probe) if abs(s) > floor), None)
        if first is None:
            return audio
        last = next(
            i for i in range(len(probe) - 1, -1, -1) if abs(probe[i]) > floor
        )

        # Cut *all* the trailing silence, then add back exactly the beat we
        # want. Merely truncating to a maximum would leave a clip that already
        # ended tight with no pause at all, so the gap would still vary between
        # lines -- and evenness, not brevity, is the whole point.
        start = first * channels
        kept = list(samples[start : (last + 1) * channels])
        if not kept:
            return audio
        kept.extend([0] * (int(rate * pad_ms / 1000) * channels))

        out = io.BytesIO()
        with wave.open(out, "wb") as sink:
            sink.setnchannels(channels)
            sink.setsampwidth(width)
            sink.setframerate(rate)
            sink.writeframes(struct.pack(f"<{len(kept)}h", *kept))
        return out.getvalue()
    except Exception:  # pragma: no cover - never lose audio to a tidying step
        logger.debug("silence trim failed; sending untrimmed", exc_info=True)
        return audio


async def current_language() -> str:
    stored = await crud.get_preference(crud.PREF_VOICE_LANGUAGE, DEFAULT_LANGUAGE)
    return stored if is_supported(stored) else DEFAULT_LANGUAGE


async def current_voice() -> Voice:
    return resolve_voice(await crud.get_preference(crud.PREF_VOICE_SPEAKER, ""))


def _provider_for(language_code: str | None) -> TTSProvider:
    """Which engine speaks this language.

    English is spoken by the local engine (Piper) when one is configured;
    everything else goes to Sarvam, which covers the Indic set Piper's English
    voices do not. `get_english_tts_provider` returns the Sarvam TTS itself when
    English is set to stay on the cloud, so this stays a single line either way.
    """
    if resolve_language(language_code).code == DEFAULT_LANGUAGE:
        return get_english_tts_provider()
    return get_tts_provider()


def prepare(text: str, language_code: str | None) -> str:
    """Rewrite text so it is spoken the way the user expects.

    For non-English output that means numerals become English words: the
    engine otherwise reads a bare digit in the target language, which is the
    one thing the user asked never to happen to times and counts.
    """
    if resolve_language(language_code).code == DEFAULT_LANGUAGE:
        return text
    return spell_numbers_in_english(text)


async def speak(
    text: str, language_code: str | None = None, speaker: str | None = None
) -> Speech:
    language = resolve_language(language_code)
    voice = resolve_voice(speaker) if speaker else await current_voice()
    provider = _provider_for(language.code)
    try:
        return await provider.synthesize(
            prepare(text, language.code),
            language_code=language.code,
            speaker=voice.id,
            pace=language.pace,
        )
    except ProviderNotConfigured as exc:
        # The local English engine is not installed or its model is missing.
        # English must still be spoken, so fall back to Sarvam once rather than
        # failing the reply. (Non-English never reaches this branch.)
        if provider is get_tts_provider():
            raise
        logger.warning("Local English TTS unavailable (%s); using Sarvam", exc)
        return await get_tts_provider().synthesize(
            prepare(text, language.code),
            language_code=language.code,
            speaker=voice.id,
            pace=language.pace,
        )


async def stream(
    text: str, language_code: str | None = None, speaker: str | None = None,
    *, incremental: bool = True,
) -> AsyncIterator[AudioPacket | Speech]:
    """Share pronunciation/pace/voice rules with REST; fallback before audio only."""
    language = resolve_language(language_code)
    provider = _provider_for(language.code)
    voice = resolve_voice(speaker) if speaker else await current_voice()
    emitted = False
    if incremental and settings.jarvis_streaming_tts and isinstance(provider, StreamingTTSProvider):
        try:
            async for packet in provider.stream_speech(
                prepare(text, language.code), language.code, voice.id, language.pace,
            ):
                emitted = True
                yield packet
            return
        except (ProviderOutOfCredit, ProviderAuthError):
            raise
        except (ProviderError, ProviderNotConfigured):
            if emitted:
                raise
            logger.warning("Streaming speech unavailable; using WAV for this phrase")
    # `speak` applies the same English/Sarvam routing and its own fallback, so
    # a missing local engine still yields audio here rather than an error.
    rendered = await speak(text, language.code, voice.id)
    yield Speech(trim_silence(rendered.audio), rendered.content_type)
