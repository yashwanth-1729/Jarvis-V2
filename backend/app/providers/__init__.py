"""Provider registry.

JARVIS talks to three capabilities — chat, speech-to-text, text-to-speech —
through the protocols in `base.py`. Swapping vendors is a new module here plus
an env var; nothing in the agent, the API layer or the UI changes.

    v1  sarvam   — chat + STT + TTS
    v2  gangi    — STT + TTS   (chat stays on sarvam)
    v3  anthropic / openai
    v4  gemini   — English chat only, via get_english_chat_provider(), with
                   Sarvam as its own per-turn fallback; every other language
                   still gets Sarvam's whole stack unchanged
"""

from __future__ import annotations

import logging
from functools import lru_cache

from app.core.config import settings
from app.providers.base import (
    ChatProvider,
    ProviderNotConfigured,
    STTProvider,
    TTSProvider,
)

logger = logging.getLogger("jarvis.providers")


@lru_cache(maxsize=1)
def get_chat_provider() -> ChatProvider:
    name = settings.jarvis_chat_provider.lower()
    if name == "sarvam":
        from app.providers.sarvam import SarvamChat

        return SarvamChat()
    raise ProviderNotConfigured(
        f"Unknown chat provider {name!r}. Supported in v1: 'sarvam'."
    )


@lru_cache(maxsize=1)
def get_stt_provider() -> STTProvider:
    name = settings.jarvis_stt_provider.lower()
    if name == "sarvam":
        from app.providers.sarvam import SarvamSTT

        return SarvamSTT()
    raise ProviderNotConfigured(
        f"Unknown STT provider {name!r}. Supported in v1: 'sarvam'."
    )


@lru_cache(maxsize=1)
def get_tts_provider() -> TTSProvider:
    name = settings.jarvis_tts_provider.lower()
    if name == "sarvam":
        from app.providers.sarvam import SarvamTTS

        return SarvamTTS()
    raise ProviderNotConfigured(
        f"Unknown TTS provider {name!r}. Supported in v1: 'sarvam'."
    )


@lru_cache(maxsize=1)
def get_english_chat_provider() -> ChatProvider:
    """The model that answers when the reply language is English.

    Same shape as `get_english_tts_provider` below: a separate getter rather
    than a branch inside `get_chat_provider`, because English's engine is a
    genuinely different choice from every other language's, not a special
    case of it. Returns the plain Sarvam provider unchanged when configured
    for "sarvam", so callers need no special case either way.
    """
    if settings.jarvis_english_llm.lower() == "gemini":
        from app.providers.gemini import EnglishChatProvider

        return EnglishChatProvider()
    return get_chat_provider()


@lru_cache(maxsize=1)
def get_english_tts_provider() -> TTSProvider:
    """The engine that speaks English.

    Separate from `get_tts_provider` (which serves every other language) so a
    local neural voice can handle English while Sarvam handles the Indic set.
    Returns the Sarvam TTS unchanged when English is configured to stay on the
    cloud, so callers need no special case.
    """
    if settings.jarvis_english_tts.lower() == "piper":
        from app.providers.piper import PiperTTS

        return PiperTTS()
    return get_tts_provider()


async def close_providers() -> None:
    """Close pooled HTTP clients at shutdown."""
    for getter in (
        get_chat_provider,
        get_stt_provider,
        get_tts_provider,
        get_english_chat_provider,
        get_english_tts_provider,
    ):
        try:
            provider = getter()
        except ProviderNotConfigured:
            continue
        closer = getattr(provider, "aclose", None)
        if closer is not None:
            try:
                await closer()
            except Exception:  # noqa: BLE001 — shutdown must not raise
                logger.warning("Provider close failed", exc_info=True)
    get_chat_provider.cache_clear()
    get_stt_provider.cache_clear()
    get_tts_provider.cache_clear()
    get_english_chat_provider.cache_clear()
    get_english_tts_provider.cache_clear()


__all__ = [
    "ChatProvider",
    "STTProvider",
    "TTSProvider",
    "ProviderNotConfigured",
    "get_chat_provider",
    "get_stt_provider",
    "get_tts_provider",
    "get_english_chat_provider",
    "get_english_tts_provider",
    "close_providers",
]
