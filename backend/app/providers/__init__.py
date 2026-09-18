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
    if settings.jarvis_voice_stack == "cloud":
        from app.providers.openrouter import OpenRouterChat

        return OpenRouterChat()
    name = settings.jarvis_chat_provider.lower()
    if name == "sarvam":
        from app.providers.sarvam import SarvamChat

        return SarvamChat()
    raise ProviderNotConfigured(
        f"Unknown chat provider {name!r}. Supported in v1: 'sarvam'."
    )


@lru_cache(maxsize=1)
def get_stt_provider() -> STTProvider:
    if settings.jarvis_voice_stack == "cloud":
        # Whisper via OpenRouter's own /audio/transcriptions (2026-09-16
        # choice; the original plan used DeepInfra directly -- see
        # app/providers/deepinfra.py, still present and unused, in case
        # OpenRouter's audio API ever needs to be swapped back out).
        from app.providers.openrouter import OpenRouterSTT

        return OpenRouterSTT()
    name = settings.jarvis_stt_provider.lower()
    if name == "sarvam":
        from app.providers.sarvam import SarvamSTT

        return SarvamSTT()
    raise ProviderNotConfigured(
        f"Unknown STT provider {name!r}. Supported in v1: 'sarvam'."
    )


@lru_cache(maxsize=1)
def get_tts_provider() -> TTSProvider:
    """The catch-all TTS engine -- every language that doesn't have its own
    specific getter (English, Hindi under the cloud stack) lands here.

    Deliberately stays Sarvam even under `JARVIS_VOICE_STACK=cloud`: Kokoro
    (this stack's English/Hindi engine, see `get_english_tts_provider` /
    `get_hindi_tts_provider`) only covers 8 languages, none of which are
    Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi,
    or Odia -- every other Indic language this app supports (see
    `app/core/languages.py`). Sarvam is the only engine in either stack that
    actually covers that set, which is the entire reason it was Sarvam in
    the first place. Only English and Hindi get a cloud-stack override;
    nothing else does.
    """
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
    if settings.jarvis_voice_stack == "cloud":
        return get_chat_provider()  # OpenRouter/Qwen answers every language under the cloud stack
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
    if settings.jarvis_voice_stack == "cloud":
        from app.providers.openrouter import OpenRouterTTS

        return OpenRouterTTS()  # Kokoro, default voice/model -- see class docstring
    if settings.jarvis_english_tts.lower() == "piper":
        from app.providers.piper import PiperTTS

        return PiperTTS()
    return get_tts_provider()


@lru_cache(maxsize=1)
def get_hindi_tts_provider() -> TTSProvider:
    """Hindi TTS under the cloud stack: also Kokoro (one of its 8 languages,
    same engine and model as English -- Kokoro's voice choice per-language is
    just a different `speaker` value, not a different model). Not used by the
    legacy stack, where Hindi is plain Sarvam via `get_tts_provider` like
    every other language Kokoro doesn't cover."""
    if settings.jarvis_voice_stack == "cloud":
        from app.providers.openrouter import OpenRouterTTS

        return OpenRouterTTS()
    return get_tts_provider()


@lru_cache(maxsize=1)
def get_telugu_tts_provider() -> TTSProvider:
    """The voice used for Telugu under the cloud stack: Grok TTS via
    OpenRouter's /audio/speech (`x-ai/grok-voice-tts-1.0`).

    History, in order, so the next person doesn't re-walk the same dead
    ends: (1) OpenAI TTS via OpenRouter -- confirmed NOT to exist on
    OpenRouter at all (their own official TTS model collection lists 20 real
    models, zero from OpenAI; every OpenAI model id tried was rejected live
    with "Model ... does not exist"). (2) Grok TTS direct from xAI --
    rejected because xAI's own docs explicitly exclude Telugu from Grok's
    documented 20-language list and require a separate XAI_API_KEY this
    project doesn't have. (3) Grok TTS *through OpenRouter* instead of
    direct -- this is different from (2): it uses the existing
    OPENROUTER_API_KEY (no XAI_API_KEY needed) and, tested live 2026-09-16
    with real Telugu text, returned real audio with no error. This is not
    the same guarantee as an official supported-language listing -- Telugu
    isn't documented as supported here either -- but it is a live,
    evidence-based result, not another guess, and it's what actually
    returned working audio. Soniox remains the real target once the user
    adds that key (module already written: app/providers/soniox_tts.py).

    Under the legacy stack this is unchanged from before: local Piper, used
    only when the user has opted in via `PREF_TELUGU_TTS_ENGINE` (checked by
    the caller in `app.services.speech._provider_for`) -- Sarvam remains the
    legacy-stack default. The legacy stack itself is no longer the default
    (`jarvis_voice_stack` defaults to "cloud" as of 2026-09-16); it only
    still exists as an explicit rollback path.
    """
    if settings.jarvis_voice_stack == "cloud":
        from app.providers.openrouter import OpenRouterTTS

        return OpenRouterTTS(model="x-ai/grok-voice-tts-1.0", default_voice="eve")
    from app.providers.piper import PiperTTS

    return PiperTTS(
        settings.jarvis_piper_telugu_model,
        language_label="Telugu",
        fallback_hint="switch the Telugu voice back to Sarvam in the language picker",
    )


async def close_providers() -> None:
    """Close pooled HTTP clients at shutdown."""
    for getter in (
        get_chat_provider,
        get_stt_provider,
        get_tts_provider,
        get_english_chat_provider,
        get_english_tts_provider,
        get_hindi_tts_provider,
        get_telugu_tts_provider,
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
    get_hindi_tts_provider.cache_clear()
    get_telugu_tts_provider.cache_clear()


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
    "get_hindi_tts_provider",
    "get_telugu_tts_provider",
    "close_providers",
]
