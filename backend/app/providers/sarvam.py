"""Sarvam AI provider — chat (sarvam-105b), STT (saaras), TTS (bulbul).

Verified against the live API:

* ``POST /v1/chat/completions`` is OpenAI-shaped, authenticated with the
  ``api-subscription-key`` header. Streaming deltas carry ``content``,
  ``reasoning_content`` and incremental ``tool_calls``.
* Reasoning is **on by default** and its tokens bill against ``max_tokens`` —
  a 100-token budget returns ``content: null`` with ``finish_reason: "length"``
  because the budget is consumed before any visible text. Hence the generous
  default in settings.
* ``POST /text-to-speech`` returns base64 WAV in ``audios[0]``.
* ``POST /speech-to-text`` is multipart and returns ``{"transcript": ...}``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, AsyncIterator, Sequence

import httpx

from app.core.config import settings
from app.core.languages import AUTO_DETECT
from app.providers.base import (
    AudioPacket,
    ChatChunk,
    ChatResult,
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
    ProviderOutOfCredit,
    ProviderRateLimited,
    ProviderUnavailable,
    Speech,
    ToolCall,
    Transcript,
)

logger = logging.getLogger("jarvis.providers.sarvam")

AUTH_HEADER = "api-subscription-key"


def _require_key() -> str:
    key = settings.sarvam_api_key.strip()
    if not key:
        raise ProviderNotConfigured(
            "SARVAM_API_KEY is not set. Add it to backend/.env."
        )
    return key


def _raise_for_status(response: httpx.Response, what: str) -> None:
    if response.status_code < 400:
        return
    body = response.text[:400]
    if response.status_code in (401, 403):
        raise ProviderAuthError(
            f"Sarvam rejected the API key on {what} ({response.status_code}). "
            "Check SARVAM_API_KEY in backend/.env."
        )
    # 402 is not a bug and not something retrying fixes, so say so in words
    # rather than leaking the vendor's JSON. Observed body:
    # {"error":{"message":"No credits available.","code":"insufficient_quota_error"}}
    if response.status_code == 402:
        raise ProviderOutOfCredit(
            "Sarvam has no credits left on this account, so chat, speech and "
            "transcription are all refused. Top up at dashboard.sarvam.ai — "
            "nothing else is wrong."
        )
    if response.status_code == 429:
        raise ProviderRateLimited(f"Sarvam rate limited {what}. Try again shortly.")
    if response.status_code >= 500:
        raise ProviderUnavailable(f"Sarvam {what} failed ({response.status_code}).")
    raise ProviderError(f"Sarvam {what} rejected the request ({response.status_code}): {body}")


#: Transient network failures worth retrying once. Deliberately excludes HTTP
#: status errors — a 400 will fail identically the second time, and a 429 has
#: its own backoff path.
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 0.4


def _transport_detail(exc: Exception) -> str:
    """Return a useful message even for blank ``httpx`` timeout strings."""
    return str(exc).strip() or type(exc).__name__


def _latest_user_chars(messages: Sequence[dict[str, Any]]) -> int:
    """Size of the active user request, excluding tool results and old turns."""
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return len(content)
    return 0


def _chat_request_timeout(messages: Sequence[dict[str, Any]]) -> float:
    if _latest_user_chars(messages) >= settings.jarvis_typed_stream_chars:
        return max(settings.sarvam_chat_timeout, settings.sarvam_long_chat_timeout)
    return settings.sarvam_chat_timeout


async def _post_with_retry(
    client: httpx.AsyncClient, url: str, what: str,
    attempts: int = _RETRY_ATTEMPTS, **kwargs: Any
) -> httpx.Response:
    """POST, retrying briefly on a dropped connection or timeout.

    Wi-Fi drops a packet and the whole turn used to fail with "Could not reach
    Sarvam". The request has not been processed when the transport itself
    fails, so replaying it is safe — no risk of a duplicate side effect.
    """
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.post(url, **kwargs)
        except httpx.TransportError as exc:
            last = exc
            if attempt == attempts:
                break
            delay = _RETRY_BACKOFF_SECONDS * attempt
            logger.warning(
                "Sarvam %s attempt %d/%d failed (%s); retrying in %.1fs",
                what, attempt, attempts, _transport_detail(exc), delay,
            )
            await asyncio.sleep(delay)

    raise ProviderUnavailable(
        f"Could not reach Sarvam for {what} after {attempts} attempts: "
        f"{_transport_detail(last) if last is not None else 'transport error'}"
    ) from last


class _SarvamBase:
    """Shared pooled HTTP client. One connection pool per provider instance."""

    name = "sarvam"

    def __init__(self, timeout: float) -> None:
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=settings.sarvam_base_url.rstrip("/"),
                headers={AUTH_HEADER: _require_key()},
                timeout=httpx.Timeout(self._timeout, connect=10.0),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

class SarvamChat(_SarvamBase):
    def __init__(self) -> None:
        super().__init__(timeout=settings.sarvam_chat_timeout)
        self.model = settings.sarvam_chat_model
        self._result = ChatResult()

    def last_result(self) -> ChatResult:
        return self._result

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        incremental: bool = True,
    ) -> AsyncIterator[ChatChunk]:
        if not incremental:
            async for chunk in self._complete(messages, tools, model, max_tokens):
                yield chunk
            return

        payload: dict[str, Any] = {
            # Voice mode overrides this per request with the conversations
            # variant, which skips reasoning entirely and is far lower latency.
            "model": model or self.model,
            "messages": list(messages),
            "stream": True,
            "max_tokens": max_tokens or settings.jarvis_max_tokens,
            "temperature": settings.sarvam_temperature,
        }
        if settings.sarvam_reasoning_effort:
            payload["reasoning_effort"] = settings.sarvam_reasoning_effort
        if tools:
            payload["tools"] = list(tools)

        content: list[str] = []
        reasoning: list[str] = []
        # Tool calls stream in fragments keyed by index; arguments accumulate.
        partial: dict[int, dict[str, str]] = {}
        announced: set[int] = set()
        finish_reason: str | None = None
        usage: dict[str, int] = {}
        # A request may be replayed only until something has crossed the
        # provider boundary. Once text/reasoning/a tool name was yielded, a
        # retry could duplicate words or execute the same tool twice.
        emitted = False

        self._result = ChatResult()

        try:
            async with self._http().stream(
                "POST",
                "/v1/chat/completions",
                json=payload,
                timeout=httpx.Timeout(_chat_request_timeout(messages), connect=10.0),
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    _raise_for_status(response, "chat/completions")

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    if event.get("usage"):
                        raw_usage = event["usage"]
                        usage = {
                            k: v for k, v in raw_usage.items() if isinstance(v, int)
                        }
                        # Sarvam reports cache hits one level down, inside
                        # `prompt_tokens_details`, so the int filter above drops
                        # them. Flattened here because this is the number that
                        # says whether the byte-stable prefix in
                        # `agent._build_persona_message` is actually earning its
                        # keep -- without it the saving is real but invisible.
                        details = raw_usage.get("prompt_tokens_details")
                        if isinstance(details, dict):
                            cached = details.get("cached_tokens")
                            if isinstance(cached, int):
                                usage["cached_tokens"] = cached

                    choices = event.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]

                    delta = choice.get("delta") or {}

                    if delta.get("reasoning_content"):
                        text = str(delta["reasoning_content"])
                        reasoning.append(text)
                        emitted = True
                        yield ChatChunk(kind="reasoning", text=text)

                    if delta.get("content"):
                        text = str(delta["content"])
                        # The model reliably opens with a newline; drop it so the
                        # transcript does not start with a blank line.
                        if not content:
                            text = text.lstrip("\n")
                            if not text:
                                continue
                        content.append(text)
                        emitted = True
                        yield ChatChunk(kind="text", text=text)

                    for fragment in delta.get("tool_calls") or []:
                        index = int(fragment.get("index", 0))
                        slot = partial.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        if fragment.get("id"):
                            slot["id"] = fragment["id"]
                        function = fragment.get("function") or {}
                        if function.get("name"):
                            slot["name"] = function["name"]
                        if function.get("arguments"):
                            slot["arguments"] += function["arguments"]

                        # Announce once the name is known so the UI can show the
                        # call executing while its arguments are still arriving.
                        if slot["name"] and index not in announced:
                            announced.add(index)
                            emitted = True
                            yield ChatChunk(
                                kind="tool_call_started",
                                tool_call=ToolCall(
                                    id=slot["id"] or f"call_{index}",
                                    name=slot["name"],
                                    arguments="",
                                    index=index,
                                ),
                            )

        except httpx.HTTPError as exc:
            detail = _transport_detail(exc)
            if not emitted:
                # Android occasionally resolves api.sarvam.ai but loses the
                # streamed connection before response headers arrive. Typed
                # chat was unaffected because its non-streaming path already
                # retries. Reopen the pool and use that same proven path for
                # this turn instead of leaving voice mode silent.
                logger.warning(
                    "Sarvam streaming failed before output (%s: %s); "
                    "falling back to a retried completion",
                    type(exc).__name__, detail,
                )
                await self.aclose()
                async for chunk in self._complete(messages, tools, model, max_tokens):
                    yield chunk
                return
            raise ProviderUnavailable(
                f"Sarvam's voice stream was interrupted after it started "
                f"({type(exc).__name__}: {detail})."
            ) from exc

        self._result = ChatResult(
            content="".join(content),
            reasoning="".join(reasoning),
            tool_calls=[
                ToolCall(
                    id=slot["id"] or f"call_{index}",
                    name=slot["name"],
                    arguments=slot["arguments"],
                    index=index,
                )
                for index, slot in sorted(partial.items())
                if slot["name"]
            ],
            finish_reason=finish_reason,
            usage=usage,
        )

    async def _complete(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None,
        model: str | None,
        max_tokens: int | None,
    ) -> AsyncIterator[ChatChunk]:
        """One request, one response, the whole completion at once.

        Yields the same chunk types the streaming path does so the agent loop
        needs no branch -- just all at the end rather than as they arrive.

        This is the path that gets the prefix cache. Sarvam does not apply it to
        streaming requests, measured repeatedly: an identical prompt reports
        0 cached tokens streamed and 8,960 of 9,014 cached unstreamed, and the
        unstreamed request finishes the whole turn faster (1.61s) than the
        streamed one does (2.47s) despite having no head start.
        """
        payload: dict[str, Any] = {
            "model": model or self.model,
            "messages": list(messages),
            "stream": False,
            "max_tokens": max_tokens or settings.jarvis_max_tokens,
            "temperature": settings.sarvam_temperature,
        }
        if settings.sarvam_reasoning_effort:
            payload["reasoning_effort"] = settings.sarvam_reasoning_effort
        if tools:
            payload["tools"] = list(tools)

        self._result = ChatResult()

        response = await _post_with_retry(
            self._http(),
            "/v1/chat/completions",
            "chat/completions",
            json=payload,
            timeout=httpx.Timeout(_chat_request_timeout(messages), connect=10.0),
        )
        if response.status_code >= 400:
            _raise_for_status(response, "chat/completions")

        body = response.json()
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}

        content = message.get("content") or ""
        reasoning = message.get("reasoning_content") or ""

        raw_usage = body.get("usage") or {}
        usage = {k: v for k, v in raw_usage.items() if isinstance(v, int)}
        details = raw_usage.get("prompt_tokens_details")
        if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
            usage["cached_tokens"] = details["cached_tokens"]

        calls: list[ToolCall] = []
        for index, call in enumerate(message.get("tool_calls") or []):
            function = call.get("function") or {}
            calls.append(
                ToolCall(
                    id=call.get("id") or f"call_{index}",
                    name=function.get("name") or "",
                    arguments=function.get("arguments") or "",
                    index=index,
                )
            )

        self._result = ChatResult(
            content=content,
            reasoning=reasoning,
            tool_calls=calls,
            finish_reason=choice.get("finish_reason"),
            usage=usage,
        )

        # Announced in the same order the streaming path would, so the UI's
        # execution log reads identically whichever path produced it.
        for call in calls:
            yield ChatChunk(kind="tool_call_started", tool_call=call)
        if reasoning:
            yield ChatChunk(kind="reasoning", text=reasoning)
        if content:
            yield ChatChunk(kind="text", text=content)


# ---------------------------------------------------------------------------
# Speech-to-text
# ---------------------------------------------------------------------------

class SarvamSTT(_SarvamBase):
    def __init__(self) -> None:
        super().__init__(timeout=settings.sarvam_speech_timeout)
        self.model = settings.sarvam_stt_model

    async def transcribe(
        self,
        audio: bytes,
        filename: str = "audio.webm",
        content_type: str = "audio/webm",
        language_code: str | None = None,
    ) -> Transcript:
        # Always auto-detect. Forcing a language transliterates anything spoken
        # in a different one instead of transcribing it — measured: English
        # audio forced to te-IN comes back as Telugu-script gibberish. Detection
        # is reliable and lets the user switch languages mid-conversation.
        form = {
            "model": self.model,
            "language_code": language_code or AUTO_DETECT,
        }
        # Recognition precedes the agent's turn deadline. Sharing the 90-second
        # TTS timeout here allowed three stalled attempts to freeze voice mode
        # for minutes, with no transcript to display. Bound the entire request,
        # including retries; successful requests take no additional round trip.
        phase = "connection"

        async def trace(event: str, info: dict[str, Any]) -> None:
            nonlocal phase
            if event.endswith(".started"):
                phase = event.removesuffix(".started")
            elif event.endswith(".failed"):
                exc = info.get("exception")
                logger.warning("STT transport failed at %s (%s)", phase, type(exc).__name__)

        try:
            async with asyncio.timeout(20):
                response = await _post_with_retry(
                    self._http(),
                    "/speech-to-text",
                    "speech-to-text",
                    attempts=2,
                    timeout=httpx.Timeout(8, connect=5, pool=3),
                    extensions={"trace": trace},
                    files={"file": (filename, audio, content_type)},
                    data=form,
                )
        except (TimeoutError, ProviderUnavailable) as exc:
            logger.warning("Speech recognition unavailable at %s: %s", phase, _transport_detail(exc))
            raise ProviderUnavailable(
                "Speech recognition could not finish. Check your connection and try speaking again."
            ) from exc

        _raise_for_status(response, "speech-to-text")
        body = response.json()
        return Transcript(
            text=(body.get("transcript") or "").strip(),
            language_code=body.get("language_code"),
            confidence=body.get("language_probability"),
        )


# ---------------------------------------------------------------------------
# Text-to-speech
# ---------------------------------------------------------------------------

class SarvamTTS(_SarvamBase):
    #: bulbul:v3 accepts 2500 chars, v2 accepts 1500. Use the safer bound so a
    #: model swap cannot start truncating silently.
    max_chars = 1500

    def __init__(self) -> None:
        super().__init__(timeout=settings.sarvam_speech_timeout)
        self.model = settings.sarvam_tts_model

    async def synthesize(
        self,
        text: str,
        language_code: str | None = None,
        speaker: str | None = None,
        pace: float | None = None,
    ) -> Speech:
        clean = text.strip()
        if not clean:
            raise ProviderError("Nothing to speak.")
        if len(clean) > self.max_chars:
            # Cut on a sentence boundary where possible rather than mid-word.
            window = clean[: self.max_chars]
            cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
            clean = window[: cut + 1] if cut > self.max_chars // 2 else window

        payload: dict[str, Any] = {
            "text": clean,
            "target_language_code": language_code or settings.sarvam_language,
            "model": self.model,
            # Pace is per-language (Indic speech runs ~50% longer than the
            # equivalent English), nudged by a global multiplier from .env.
            "pace": round(
                max(0.5, min((pace or 1.0) * settings.sarvam_tts_pace, 2.0)), 2
            ),
            "speech_sample_rate": settings.sarvam_tts_sample_rate,
        }
        # bulbul:v3 exposes `temperature` for expressiveness; v2 rejects it and
        # uses pitch/loudness instead, which v3 in turn rejects.
        if self.model.startswith("bulbul:v3"):
            payload["temperature"] = settings.sarvam_tts_temperature
        chosen = (speaker or settings.sarvam_tts_speaker).strip()
        if chosen:
            payload["speaker"] = chosen

        response = await _post_with_retry(
            self._http(), "/text-to-speech", "text-to-speech", json=payload
        )

        # bulbul:v2 and bulbul:v3 expose different speaker sets, so a model
        # swap can invalidate a previously fine speaker. Rather than fail
        # the request, drop the speaker once and let the model's own default
        # answer — a warning in the log beats silence in the UI.
        if (
            response.status_code == 400
            and "speaker" in response.text.lower()
            and "speaker" in payload
        ):
            logger.warning(
                "Speaker %r is not valid for %s; retrying with the model default. "
                "Set SARVAM_TTS_SPEAKER to one this model supports.",
                chosen,
                self.model,
            )
            payload.pop("speaker")
            response = await _post_with_retry(
                self._http(), "/text-to-speech", "text-to-speech", json=payload
            )

        _raise_for_status(response, "text-to-speech")
        audios = response.json().get("audios") or []
        if not audios:
            raise ProviderError("Sarvam returned no audio.")
        return Speech(audio=base64.b64decode(audios[0]), content_type="audio/wav")


    async def stream_speech(
        self, text: str, language_code: str | None = None,
        speaker: str | None = None, pace: float | None = None,
    ) -> AsyncIterator[AudioPacket]:
        """Incremental PCM over the existing pooled HTTP client (no vendor SDK).

        Never retry after audio has escaped: doing so repeats spoken words.
        The service can use the WAV fallback only before the first packet.
        """
        clean = text.strip()
        if not clean or len(clean) > self.max_chars:
            raise ProviderError("Speech text is empty or exceeds the provider limit.")
        rate = min(settings.sarvam_tts_sample_rate, 24000)
        payload: dict[str, Any] = {
            "text": clean, "language_code": language_code or settings.sarvam_language,
            "model": self.model, "speaker": speaker or settings.sarvam_tts_speaker,
            "pace": round(max(0.5, min((pace or 1.0) * settings.sarvam_tts_pace, 2.0)), 2),
            "speech_sample_rate": rate, "output_audio_codec": "linear16",
        }
        if self.model.startswith("bulbul:v3"):
            payload["temperature"] = settings.sarvam_tts_temperature
        pending = bytearray()
        packet_bytes = int(rate * 0.1) * 2
        emitted = False
        try:
            async with self._http().stream("POST", "/text-to-speech/stream", json=payload) as response:
                if response.is_error:
                    await response.aread()
                    _raise_for_status(response, "streaming text-to-speech")
                content_type = response.headers.get("content-type", "").lower()
                if not (content_type.startswith("audio/") or content_type.startswith("application/octet-stream")):
                    raise ProviderError("Streaming speech returned a non-audio response.")
                async for data in response.aiter_bytes():
                    pending.extend(data)
                    # Do not mistake a WAV/MP3 container for signed PCM.
                    if not emitted and len(pending) >= 4 and pending[:4] in (b"RIFF", b"OggS", b"fLaC"):
                        raise ProviderError("Streaming speech returned an unexpected audio container.")
                    while len(pending) >= packet_bytes:
                        packet = bytes(pending[:packet_bytes])
                        del pending[:packet_bytes]
                        emitted = True
                        yield AudioPacket(packet, rate)
                if len(pending) % 2:
                    raise ProviderError("Streaming speech ended inside a PCM sample.")
                if pending:
                    emitted = True
                    yield AudioPacket(bytes(pending), rate)
                if not emitted:
                    raise ProviderError("Streaming speech returned no audio.")
        except httpx.HTTPError as exc:
            raise ProviderUnavailable("Streaming speech connection failed.") from exc
