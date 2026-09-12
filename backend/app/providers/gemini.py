"""Gemini chat provider — used only for English replies, with Sarvam as the
whole-stack fallback everywhere else and as the per-turn safety net here.

Verified against the live API (`generativelanguage.googleapis.com/v1beta`),
not assumed from documentation, which is exactly the caution this project
already applies to Sarvam:

* ``gemini-2.5-flash`` returns 404 for new API keys — Google's own error
  message says so and points at ``gemini-3.6-flash``. Model names on this
  vendor churn fast; ``GEMINI_MODEL`` in `.env` is the escape hatch.
* Every Gemini 3.x model "thinks" by default, and that budget comes out of
  the SAME ``max_output_tokens`` the visible answer does — a 200-token cap
  measured returning empty text with the entire budget spent on thinking.
  ``JARVIS_MAX_TOKENS``'s existing generous default (4000) is what makes
  this safe; do not lower it for Gemini specifically.
* Measured latency on an identical prompt: ``gemini-3.5-flash-lite`` ~1.7s
  to first token / ~4s total; ``gemini-3.6-flash`` ~9s / ~13s. The lite tier
  is the only one worth using as a default for a voice-adjacent assistant.
* A function-call part in the model's response carries a ``thoughtSignature``
  that Gemini 3.x REQUIRES verbatim on that same part if it is ever replayed
  in a later turn's history — omitting it is a hard 400
  ("Function call is missing a thought_signature"), not a soft warning.
  Tracked in ``_signatures`` below, keyed by the tool-call id JARVIS already
  threads through the whole agent loop. A call this provider never issued
  (Sarvam's history, or a signature this process never saw) has no entry —
  its function-call part is dropped and only its text/result content is kept,
  rather than sending Gemini a call it cannot avoid rejecting.
* ``google_search`` (built-in grounding) and this app's own
  ``function_declarations`` can be sent in the same request on 3.x models.
  On this account grounding hit a 429 (RESOURCE_EXHAUSTED) on the very first
  attempt — the free tier's grounding quota is small to nonexistent. Sent on
  every call regardless; a search-shaped failure retries once with grounding
  removed, so the model still has its own ``web_search``/``fetch_url`` tools
  to reach for instead. This is not a hypothetical path — it is the one that
  actually runs today on a fresh key.
"""

from __future__ import annotations

import json
import logging
import time
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
    ToolCall,
)

logger = logging.getLogger("jarvis.providers.gemini")

API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _require_key() -> str:
    key = settings.gemini_api_key.strip()
    if not key:
        raise ProviderNotConfigured("GEMINI_API_KEY is not set. Add it to backend/.env.")
    return key


def _transport_detail(exc: Exception) -> str:
    return str(exc).strip() or type(exc).__name__


#: Effort levels this app already speaks (Sarvam's `reasoning_effort`) mapped
#: onto Gemini's own enum. Empty/None -- the project's own default for
#: ordinary turns -- gets Gemini's cheapest available level rather than a
#: request field it would reject; there is no way to ask a Gemini 3.x model
#: for zero thinking (measured: `thinking_budget: 0` is refused outright).
_THINKING_LEVEL = {"": "low", None: "low", "low": "low", "medium": "medium", "high": "high"}


def _raise_for_status(response: httpx.Response, body: bytes) -> None:
    if response.status_code < 400:
        return
    try:
        detail = json.loads(body).get("error", {})
        message = detail.get("message", "") or body.decode(errors="replace")[:400]
        status = detail.get("status", "")
    except (json.JSONDecodeError, UnicodeDecodeError):
        message = body.decode(errors="replace")[:400]
        status = ""

    if response.status_code in (401, 403):
        raise ProviderAuthError(
            f"Gemini rejected the API key ({response.status_code}): {message}. "
            "Check GEMINI_API_KEY in backend/.env."
        )
    if response.status_code == 404:
        raise ProviderError(
            f"Gemini model {settings.gemini_model!r} is not available: {message}. "
            "Set GEMINI_MODEL in backend/.env to a current model id."
        )
    if response.status_code == 429 or status == "RESOURCE_EXHAUSTED":
        raise ProviderRateLimited(f"Gemini rate limited or out of quota: {message}")
    if response.status_code >= 500:
        raise ProviderUnavailable(f"Gemini failed ({response.status_code}): {message}")
    raise ProviderError(f"Gemini rejected the request ({response.status_code}): {message}")


#: Deliberately not error-message matching. The live 429 this app actually
#: hit on a fresh key's grounding quota reads "You exceeded your current
#: quota, please check your plan and billing details" -- generic wording
#: shared with every other Gemini rate limit, with no mention of "search" or
#: "grounding" to match against. Since search is the only thing that differs
#: between the two attempts, any failure on the search-enabled one is worth
#: retrying without it: removing a tool can only ever narrow what the model
#: could do, never introduce a new way for the *same* request to fail.


def _openai_tool_to_declaration(tool: dict[str, Any]) -> dict[str, Any] | None:
    """This app's OpenAI-shaped tool defs -> Gemini's ``function_declarations``
    shape. Both describe JSON Schema parameters, so this is a reshape, not a
    translation of the schema itself."""
    function = tool.get("function")
    if not isinstance(function, dict) or not function.get("name"):
        return None
    declaration: dict[str, Any] = {
        "name": function["name"],
        "description": function.get("description", ""),
    }
    parameters = function.get("parameters")
    if isinstance(parameters, dict):
        declaration["parameters"] = parameters
    return declaration


class GeminiChat:
    """Talks only to Gemini. Callers wanting the Sarvam safety net use
    :class:`EnglishChatProvider` below, not this class directly."""

    name = "gemini"

    def __init__(self) -> None:
        self.model = settings.gemini_model
        self._client: httpx.AsyncClient | None = None
        self._result = ChatResult()
        #: tool-call id -> {"name", "signature"}. See the module docstring's
        #: thoughtSignature note. Process-lifetime; a few hundred bytes per
        #: call, and this process does not run long enough for that to matter.
        self._signatures: dict[str, dict[str, str]] = {}

    def last_result(self) -> ChatResult:
        return self._result

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=API_BASE,
                headers={"x-goog-api-key": _require_key()},
                timeout=httpx.Timeout(settings.gemini_chat_timeout, connect=10.0),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- message translation --------------------------------------------

    def _to_contents(
        self, messages: Sequence[dict[str, Any]]
    ) -> tuple[str, list[dict[str, Any]]]:
        """OpenAI-shaped history -> (system_instruction text, Gemini contents)."""
        system_parts: list[str] = []
        contents: list[dict[str, Any]] = []

        for message in messages:
            role = message.get("role")
            content = message.get("content") or ""

            if role == "system":
                if content:
                    system_parts.append(str(content))
                continue

            if role == "user":
                contents.append({"role": "user", "parts": [{"text": str(content)}]})
                continue

            if role == "assistant":
                parts: list[dict[str, Any]] = []
                if content:
                    parts.append({"text": str(content)})
                for call in message.get("tool_calls") or []:
                    call_id = call.get("id", "")
                    cached = self._signatures.get(call_id)
                    if cached is None:
                        # Issued by Sarvam, or by a Gemini process that has
                        # since restarted -- no signature to replay. Keep the
                        # text above (already appended); drop the structured
                        # call rather than send one Gemini will reject.
                        continue
                    function = call.get("function") or {}
                    try:
                        args = json.loads(function.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    parts.append({
                        "functionCall": {"name": cached["name"], "args": args},
                        "thoughtSignature": cached["signature"],
                    })
                if parts:
                    contents.append({"role": "model", "parts": parts})
                continue

            if role == "tool":
                call_id = message.get("tool_call_id", "")
                cached = self._signatures.get(call_id)
                if cached is None:
                    # No matching recognised call (see above) -- fold the
                    # result into a plain text turn so the content survives
                    # even though the structured link to a call is gone.
                    contents.append({
                        "role": "user",
                        "parts": [{"text": f"Result: {content}"}],
                    })
                    continue
                try:
                    response_value: Any = json.loads(content)
                    if not isinstance(response_value, dict):
                        response_value = {"result": response_value}
                except json.JSONDecodeError:
                    response_value = {"result": str(content)}
                contents.append({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": cached["name"],
                            "response": response_value,
                        },
                    }],
                })
                continue

        return "\n\n".join(system_parts), contents

    # -- request/response ------------------------------------------------

    def _payload(
        self,
        contents: list[dict[str, Any]],
        system_text: str,
        declarations: list[dict[str, Any]],
        *,
        include_search: bool,
        max_tokens: int | None,
        reasoning_effort: str | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "contents": contents,
            "generation_config": {
                "max_output_tokens": max_tokens or settings.jarvis_max_tokens,
                "thinking_config": {
                    "thinking_level": _THINKING_LEVEL.get(reasoning_effort, "low"),
                },
            },
        }
        if system_text:
            payload["system_instruction"] = {"parts": [{"text": system_text}]}

        tools: list[dict[str, Any]] = []
        if include_search:
            tools.append({"google_search": {}})
        if declarations:
            tools.append({"function_declarations": declarations})
        if tools:
            payload["tools"] = tools
        return payload

    async def _stream_once(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[ChatChunk]:
        """One real HTTP stream, yielding chunks as they actually arrive.

        The status check happens before any line is read — Gemini reports a
        4xx/5xx on the response headers, before any SSE data follows — so a
        failure here is always detected before a single chunk would have been
        yielded, exactly like `SarvamChat.stream`'s own pre-consumption check.
        A search-related failure at this point costs nothing to retry.
        """
        call_index = 0
        url = f"/models/{self.model}:streamGenerateContent"
        async with self._http().stream(
            "POST", url, params={"alt": "sse"}, json=payload
        ) as response:
            if response.status_code >= 400:
                body = await response.aread()
                _raise_for_status(response, body)

            async for line in response.aiter_lines():
                if not line.strip() or not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue

                raw_usage = event.get("usageMetadata")
                if isinstance(raw_usage, dict):
                    self._usage = {
                        "prompt_tokens": raw_usage.get("promptTokenCount", 0),
                        "completion_tokens": raw_usage.get("candidatesTokenCount", 0),
                        "total_tokens": raw_usage.get("totalTokenCount", 0),
                        "reasoning_tokens": raw_usage.get("thoughtsTokenCount", 0),
                    }

                candidates = event.get("candidates") or []
                if not candidates:
                    continue
                candidate = candidates[0]
                if candidate.get("finishReason"):
                    self._finish_reason = str(candidate["finishReason"]).lower()

                for part in (candidate.get("content") or {}).get("parts") or []:
                    if part.get("text"):
                        text = str(part["text"])
                        self._content.append(text)
                        yield ChatChunk(kind="text", text=text)

                    function_call = part.get("functionCall")
                    if function_call:
                        call_id = function_call.get("id") or f"call_{call_index}"
                        call_index += 1
                        signature = part.get("thoughtSignature", "")
                        if signature:
                            self._signatures[call_id] = {
                                "name": function_call.get("name", ""),
                                "signature": signature,
                            }
                        call = ToolCall(
                            id=call_id,
                            name=function_call.get("name", ""),
                            arguments=json.dumps(function_call.get("args") or {}),
                            index=len(self._tool_calls),
                        )
                        self._tool_calls.append(call)
                        yield ChatChunk(kind="tool_call_started", tool_call=call)

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        incremental: bool = True,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[ChatChunk]:
        if model:
            self.model = model

        system_text, contents = self._to_contents(messages)
        declarations = [
            declaration
            for tool in (tools or [])
            if (declaration := _openai_tool_to_declaration(tool)) is not None
        ]

        self._result = ChatResult()
        self._content: list[str] = []
        self._tool_calls: list[ToolCall] = []
        self._finish_reason: str | None = None
        self._usage: dict[str, int] = {}

        payload = self._payload(
            contents, system_text, declarations,
            include_search=True, max_tokens=max_tokens, reasoning_effort=reasoning_effort,
        )
        try:
            try:
                async for chunk in self._stream_once(payload):
                    yield chunk
            except ProviderError as exc:
                if self._content or self._tool_calls:
                    raise
                logger.info("Gemini search grounding unavailable (%s); retrying without it", exc)
                payload = self._payload(
                    contents, system_text, declarations,
                    include_search=False, max_tokens=max_tokens,
                    reasoning_effort=reasoning_effort,
                )
                async for chunk in self._stream_once(payload):
                    yield chunk
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(
                f"Gemini stream failed ({type(exc).__name__}: {_transport_detail(exc)})."
            ) from exc

        self._result = ChatResult(
            content="".join(self._content),
            tool_calls=self._tool_calls,
            finish_reason=self._finish_reason,
            usage=self._usage,
        )


class EnglishChatProvider:
    """Gemini for English replies, with Sarvam as the per-turn safety net.

    Mirrors the exact cooldown shape `SarvamChat` already uses for its own
    voice-model override (see `sarvam.py`'s `VOICE_MODEL_COOLDOWN_SECONDS`):
    a model that just failed to respond is skipped for a while rather than
    stalling every subsequent turn on the same timeout.

    The same partial-output rule applies as everywhere else in this codebase
    that falls back mid-stream: a request may be replayed only until
    something has crossed the provider boundary. Once Gemini has yielded any
    text or a tool call, a fallback would risk duplicating output or
    executing a tool twice, so the failure is raised instead of retried.
    """

    name = "gemini"  # what the model actually answered with, per turn, see below

    #: How long to stop trying Gemini after it fails outright. Shorter than
    #: Sarvam's own 180s override cooldown -- Gemini is a whole provider, not
    #: a single per-request model swap, so a real outage should recover into
    #: normal English answers sooner rather than staying on the fallback for
    #: a full three minutes on a transient blip.
    COOLDOWN_SECONDS = 60.0

    def __init__(self) -> None:
        self._gemini = GeminiChat()
        self._sarvam: Any = None  # constructed lazily; may never be needed
        self.model = self._gemini.model
        self._result = ChatResult()
        self._down_until = 0.0

    def _sarvam_chat(self):
        if self._sarvam is None:
            from app.providers.sarvam import SarvamChat

            self._sarvam = SarvamChat()
        return self._sarvam

    def last_result(self) -> ChatResult:
        return self._result

    async def aclose(self) -> None:
        await self._gemini.aclose()
        if self._sarvam is not None:
            await self._sarvam.aclose()

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        incremental: bool = True,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[ChatChunk]:
        if time.monotonic() >= self._down_until:
            emitted = False
            try:
                async for chunk in self._gemini.stream(
                    messages, tools, None, max_tokens, incremental, reasoning_effort
                ):
                    emitted = True
                    yield chunk
                self._result = self._gemini.last_result()
                self.model = self._gemini.model
                self.name = "gemini"
                return
            except ProviderError as exc:
                if emitted:
                    # Already spoken: cannot safely retry on another provider.
                    raise
                logger.warning(
                    "Gemini failed before any output (%s); falling back to "
                    "Sarvam for this English turn, and for the next %.0fs",
                    exc, self.COOLDOWN_SECONDS,
                )
                self._down_until = time.monotonic() + self.COOLDOWN_SECONDS
        else:
            logger.info("Gemini is in cooldown; using Sarvam for this English turn")

        sarvam = self._sarvam_chat()
        async for chunk in sarvam.stream(
            messages, tools, model, max_tokens, incremental, reasoning_effort
        ):
            yield chunk
        self._result = sarvam.last_result()
        self.model = sarvam.model
        self.name = "sarvam"
