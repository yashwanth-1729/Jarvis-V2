"""Turning provider usage into Aura.

All money math is ``Decimal`` and every charge is rounded *up* to a whole
milli-Aura (1/1000 Aura = Rs 0.0001), so a charge is never short by a rounding
error and balances stay exact integers in the database.

    milli-Aura = ceil(cost_usd * USD_INR / AURA_INR * 1000)

At the defaults (USD_INR 88, AURA_INR 0.10) $1 is 880,000 milli-Aura, so a
typical measured text turn (~Rs 0.049) comes out near 0.5 Aura.
"""

from __future__ import annotations

import base64
import binascii
import struct
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from typing import Any

from app.config import DEFAULT_MODEL_PRICES, Settings

KINDS = ("chat", "stt", "tts")


def _dec(value: Any) -> Decimal:
    # Via str() so 0.1e-6 is exactly 1E-7, not the binary float's expansion.
    return Decimal(str(value or 0))


@dataclass(frozen=True)
class ModelPrice:
    model: str
    kind: str
    #: Chat, USD per token.
    prompt: Decimal = Decimal(0)
    cached_prompt: Decimal = Decimal(0)
    cache_write: Decimal = Decimal(0)
    completion: Decimal = Decimal(0)
    #: STT, USD per second of audio, and the shortest billable clip.
    per_second: Decimal = Decimal(0)
    min_seconds: Decimal = Decimal(0)
    #: TTS, USD per input character.
    per_char: Decimal = Decimal(0)

    @classmethod
    def from_config(cls, model: str, raw: dict[str, Any]) -> "ModelPrice":
        kind = str(raw.get("kind", ""))
        if kind not in KINDS:
            raise ValueError(f"price for {model!r} needs kind in {KINDS}, got {kind!r}")
        prompt = _dec(raw.get("prompt"))
        return cls(
            model=model,
            kind=kind,
            prompt=prompt,
            # Uncached-rate defaults: an unknown cache price is never cheaper.
            cached_prompt=_dec(raw.get("cached_prompt", raw.get("prompt"))),
            cache_write=_dec(raw.get("cache_write", raw.get("prompt"))),
            completion=_dec(raw.get("completion")),
            per_second=_dec(raw.get("per_second")),
            min_seconds=_dec(raw.get("min_seconds")),
            per_char=_dec(raw.get("per_char")),
        )


class ModelCatalog:
    """The allow-list and the price table, validated together at startup: an
    allowed model with no price would be forwarded and never charged."""

    def __init__(self, settings: Settings) -> None:
        merged: dict[str, dict[str, Any]] = {
            model: dict(fields) for model, fields in DEFAULT_MODEL_PRICES.items()
        }
        for model, fields in settings.model_prices.items():
            merged.setdefault(model, {}).update(fields)
        prices = {model: ModelPrice.from_config(model, raw) for model, raw in merged.items()}

        allowed = settings.allowed_model_list() or sorted(prices)
        unpriced = [m for m in allowed if m not in prices]
        if unpriced:
            raise ValueError(
                f"ALLOWED_MODELS has no price for {unpriced}; add them to MODEL_PRICES."
            )
        self._prices = {m: prices[m] for m in allowed}

    def get(self, model: Any, kind: str) -> ModelPrice | None:
        """The price for ``model`` if it is allowed *for this endpoint*."""
        price = self._prices.get(model) if isinstance(model, str) else None
        return price if price is not None and price.kind == kind else None

    def allowed(self, kind: str) -> list[str]:
        return sorted(m for m, p in self._prices.items() if p.kind == kind)


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------

def usd_to_milli(cost_usd: Decimal, settings: Settings) -> int:
    if cost_usd <= 0:
        return 0
    aura = cost_usd * _dec(settings.usd_inr) / _dec(settings.aura_inr)
    return int((aura * 1000).to_integral_value(rounding=ROUND_CEILING))


def aura_to_milli(aura: float) -> int:
    return int((_dec(aura) * 1000).to_integral_value(rounding=ROUND_CEILING))


def milli_to_aura(milli: int) -> float:
    return round(milli / 1000, 3)


def usd_to_inr(cost_usd: Decimal, settings: Settings) -> Decimal:
    return cost_usd * _dec(settings.usd_inr)


# ---------------------------------------------------------------------------
# Chat usage
# ---------------------------------------------------------------------------

@dataclass
class ChatUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    #: OpenRouter's own ``usage.cost`` (USD), when it reports one.
    upstream_cost: Decimal | None = None


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def extract_chat_usage(raw: Any) -> ChatUsage | None:
    """Flatten OpenRouter's usage block, including the nested cache fields.

    Same reading as the backend's ``openrouter._extract_usage``: cached tokens
    live one level down in ``prompt_tokens_details`` and a flat read would
    silently bill every cached token at the full prompt rate.
    """
    if not isinstance(raw, dict):
        return None
    usage = ChatUsage(
        prompt_tokens=_int(raw.get("prompt_tokens")),
        completion_tokens=_int(raw.get("completion_tokens")),
    )
    details = raw.get("prompt_tokens_details")
    if isinstance(details, dict):
        usage.cached_tokens = _int(details.get("cached_tokens"))
        usage.cache_write_tokens = _int(details.get("cache_write_tokens"))
    completion_details = raw.get("completion_tokens_details")
    if isinstance(completion_details, dict):
        usage.reasoning_tokens = _int(completion_details.get("reasoning_tokens"))
    cost = raw.get("cost")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
        usage.upstream_cost = _dec(cost)
    return usage


def chat_cost_usd(price: ModelPrice, usage: ChatUsage) -> Decimal:
    """``prompt_tokens`` includes the cached and cache-write tokens (OpenAI
    convention, which OpenRouter follows), so only the remainder is billed at
    the full prompt rate. Reasoning tokens are already inside
    ``completion_tokens`` and billed as output."""
    cached = min(usage.cached_tokens, usage.prompt_tokens)
    written = min(usage.cache_write_tokens, usage.prompt_tokens - cached)
    fresh = usage.prompt_tokens - cached - written
    return (
        fresh * price.prompt
        + cached * price.cached_prompt
        + written * price.cache_write
        + usage.completion_tokens * price.completion
    )


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def wav_duration_seconds(data: bytes) -> float | None:
    """Exact duration of a RIFF/WAVE clip from its header, or None if it is
    not one. Walks the chunks rather than trusting fixed offsets: some
    encoders put LIST/fact chunks before ``data``. A streaming writer's
    placeholder data size (0 or 0xFFFFFFFF) falls back to the bytes present."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    byte_rate = 0
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        (size,) = struct.unpack("<I", data[pos + 4:pos + 8])
        body = pos + 8
        if chunk_id == b"fmt " and size >= 16 and body + 16 <= len(data):
            byte_rate = struct.unpack("<I", data[body + 8:body + 12])[0]
        elif chunk_id == b"data":
            present = len(data) - body
            if size == 0 or size == 0xFFFFFFFF or size > present:
                size = present
            return size / byte_rate if byte_rate else None
        pos = body + size + (size & 1)  # chunks are word-aligned
    return None


def audio_seconds_estimate(encoded: str, fmt: str, settings: Settings) -> float:
    """How long a base64 clip is, before it is sent anywhere.

    WAV (what the app records: 16 kHz mono ``segment.wav``) is exact. Anything
    compressed is estimated from its size at a deliberately low assumed
    bitrate, so the estimate errs long; OpenRouter's own ``usage.seconds``
    replaces it after the call whenever the response carries one.
    """
    if fmt.lower() in ("wav", "wave", "x-wav"):
        try:
            seconds = wav_duration_seconds(base64.b64decode(encoded, validate=False))
        except (binascii.Error, ValueError):
            seconds = None
        if seconds is not None:
            return seconds
    approx_bytes = len(encoded) * 3 // 4
    return approx_bytes / max(settings.stt_assumed_bytes_per_second, 1)


def stt_cost_usd(price: ModelPrice, seconds: float) -> Decimal:
    billable = max(_dec(round(seconds, 3)), price.min_seconds)
    return billable * price.per_second


def tts_cost_usd(price: ModelPrice, chars: int) -> Decimal:
    return chars * price.per_char


# ---------------------------------------------------------------------------
# Telugu detection (the voice_te gate)
# ---------------------------------------------------------------------------

def is_telugu(language: Any) -> bool:
    """``te``, ``te-IN``, ``te_IN``, any case."""
    if not isinstance(language, str):
        return False
    tag = language.strip().lower().replace("_", "-")
    return tag == "te" or tag.startswith("te-")


def telugu_share(text: str) -> float:
    """Share of the letters in ``text`` that are Telugu script (U+0C00-U+0C7F).
    Telugu vowel signs are combining marks, not ``isalpha``, so the block is
    counted explicitly."""
    letters = telugu = 0
    for ch in text:
        in_block = "ఀ" <= ch <= "౿"
        if in_block or ch.isalpha():
            letters += 1
            telugu += in_block
    return telugu / letters if letters else 0.0
