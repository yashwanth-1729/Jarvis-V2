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

import base64
import json
import logging
from typing import Any, AsyncIterator, Sequence

import httpx

from app.core.config import settings
from app.providers.base import (
    ChatChunk,
    ChatResult,
    ProviderAuthError,
    ProviderError,
    ProviderNotConfigured,
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
    if response.status_code == 429:
        raise ProviderRateLimited(f"Sarvam rate limited {what}. Try again shortly.")
    if response.status_code >= 500:
        raise ProviderUnavailable(f"Sarvam {what} failed ({response.status_code}).")
    raise ProviderError(f"Sarvam {what} rejected the request ({response.status_code}): {body}")


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
    ) -> AsyncIterator[ChatChunk]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": list(messages),
            "stream": True,
            "max_tokens": settings.jarvis_max_tokens,
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

        self._result = ChatResult()

        try:
            async with self._http().stream(
                "POST", "/v1/chat/completions", json=payload
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
                        usage = {
                            k: v
                            for k, v in event["usage"].items()
                            if isinstance(v, int)
                        }

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
            raise ProviderUnavailable(f"Could not reach Sarvam: {exc}") from exc

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
        form = {
            "model": self.model,
            "language_code": language_code or settings.sarvam_language,
        }
        try:
            response = await self._http().post(
                "/speech-to-text",
                files={"file": (filename, audio, content_type)},
                data=form,
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Could not reach Sarvam: {exc}") from exc

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
        }
        chosen = (speaker or settings.sarvam_tts_speaker).strip()
        if chosen:
            payload["speaker"] = chosen

        try:
            response = await self._http().post("/text-to-speech", json=payload)

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
                response = await self._http().post("/text-to-speech", json=payload)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Could not reach Sarvam: {exc}") from exc

        _raise_for_status(response, "text-to-speech")
        audios = response.json().get("audios") or []
        if not audios:
            raise ProviderError("Sarvam returned no audio.")
        return Speech(audio=base64.b64decode(audios[0]), content_type="audio/wav")
