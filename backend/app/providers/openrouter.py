"""OpenRouter providers -- the cloud voice stack's LLM gateway, and (per the
user's explicit choice, 2026-09-16, overriding the original DeepInfra plan)
its STT and English/Hindi TTS too, via OpenRouter's own newer audio API.

Verified against OpenRouter's real audio-API announcement (2026-09-16):

* ``POST /api/v1/audio/transcriptions`` -- ``model`` (e.g.
  ``"openai/whisper-large-v3"``), ``input_audio: {data: base64, format}``,
  optional ``language`` hint. Same Bearer key as chat completions.
* ``POST /api/v1/audio/speech`` -- ``model`` (e.g. ``"hexgrad/kokoro-82m"``,
  confirmed real and routable through this endpoint), ``input``, ``voice``,
  ``response_format`` (``"mp3"`` or ``"pcm"``). Response is a raw audio byte
  stream, not JSON. Kokoro on OpenRouter covers 8 languages including
  English and Hindi, but not Telugu -- Telugu stays on Sarvam (see
  ``get_telugu_tts_provider`` in ``providers/__init__.py``) until Soniox is
  wired in later; Grok TTS was considered but doesn't officially support
  Telugu and needs a separate ``XAI_API_KEY`` this project doesn't have.
* Neither endpoint's docs specify streaming/partial output -- both are
  request/response, same "one call per buffered utterance / per chunk"
  pattern as every other engine in this codebase.

Chat is only active when ``JARVIS_VOICE_STACK=cloud`` (see config.py). Wire
format there is OpenAI-shaped chat completions:

* ``POST https://openrouter.ai/api/v1/chat/completions``, Bearer auth.
* Streaming SSE chunks are the same shape Sarvam already speaks --
  ``choices[0].delta.content`` / ``.tool_calls[].function.{name,arguments}``
  -- so this provider reuses the exact same accumulation logic as
  ``SarvamChat.stream()`` rather than inventing new parsing.
* Web search is a request-level plugin, not a tool the model calls itself:
  ``"plugins": [{"id": "web", "max_results": N}]`` (or the ``:online`` model
  suffix). Citations come back as ``url_citation`` annotations on the
  message, not inside the streamed delta content -- this provider does not
  yet surface those annotations to callers (see WebSearchRouter's own
  docstring for why this is a router problem, not a parsing gap).

``WebSearchRouter`` decides per-turn whether to add the plugin at all: most
voice turns ("what's on my schedule", "add a task") have nothing to do with
live information, and JARVIS already has its own ``web_search``/`fetch_url``
tools the model can call explicitly -- this router only controls OpenRouter's
*built-in* grounding plugin, which behaves like Gemini's ``google_search``
grounding in this codebase (see ``gemini.py``): additive, not a replacement
for the app's own tools.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
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
    Speech,
    ToolCall,
    Transcript,
)

logger = logging.getLogger("jarvis.providers.openrouter")

API_BASE = "https://openrouter.ai/api/v1"


def _require_key() -> str:
    key = settings.openrouter_api_key.strip()
    if not key:
        raise ProviderNotConfigured(
            "OPENROUTER_API_KEY is not set. Add it to backend/.env."
        )
    return key


# ---------------------------------------------------------------------------
# One shared connection pool for every OpenRouter call
#
# Root cause of "OpenRouter stream failed ()" / "STT request failed ()"
# (2026-09-18, three separate live failures, every one at exactly ~10.0s):
# the 10s *connect* timeout firing on a fresh TCP+TLS handshake that stalled
# on the phone's mobile network. Fresh handshakes were happening on nearly
# every turn for two compounding reasons:
#   * chat, STT and each TTS language each owned a separate AsyncClient, so
#     a connection STT had just warmed was useless to chat a second later;
#   * httpx's default keepalive_expiry is 5s, so anything idle between turns
#     (i.e. always, in a voice conversation) was thrown away anyway.
# The network itself measured clean (25ms RTT, full-size packets pass on
# v4 and v6), so the fix is fewer handshakes and failing fast on the rare
# stalled one -- not a provider change.
# ---------------------------------------------------------------------------

_client: httpx.AsyncClient | None = None
_client_loop: asyncio.AbstractEventLoop | None = None

#: Exceptions raised before the request reached the server -- always safe to
#: retry, nothing was sent, nothing was billed.
_CONNECT_ERRORS = (httpx.ConnectTimeout, httpx.ConnectError, httpx.PoolTimeout)
#: Any transport-level failure (dropped mid-flight, stale pooled socket).
_TRANSPORT_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)


def _describe(exc: BaseException) -> str:
    """Type name as well as message: httpx timeouts stringify to "" -- which
    is exactly why three real failures logged as the useless "failed ()"."""
    text = str(exc)
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _timeout(read: float) -> httpx.Timeout:
    return httpx.Timeout(read, connect=settings.openrouter_connect_timeout)


def _http() -> httpx.AsyncClient:
    """The process-wide client, rebuilt if the event loop changed (tests run
    several ``asyncio.run`` loops; a pooled connection cannot cross loops)."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop is not loop:
        _client = httpx.AsyncClient(
            base_url=API_BASE,
            # Attribution only; the key goes on each request (`_headers`) so a
            # key change via the BYOK credentials endpoint needs no rebuild.
            headers={
                "HTTP-Referer": "https://github.com/yashwanth-1729/Jarvis-V2",
                "X-Title": "JARVIS",
            },
            timeout=_timeout(settings.openrouter_chat_timeout),
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
                keepalive_expiry=settings.openrouter_keepalive_seconds,
            ),
            transport=_test_transport,
        )
        _client_loop = loop
    return _client


#: Test hook: an ``httpx.MockTransport`` swapped in by tests. Never set in
#: production code.
_test_transport: httpx.AsyncBaseTransport | None = None


async def close_shared_client() -> None:
    global _client, _client_loop
    if _client is not None and not _client.is_closed:
        try:
            await _client.aclose()
        except RuntimeError:  # its loop is already gone; nothing to release
            pass
    _client, _client_loop = None, None


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_require_key()}"}


async def warm_connection() -> None:
    """Open (or keep alive) a pooled connection before the user needs it.

    Called when a voice session opens and periodically while it stays open,
    so the first STT/chat/TTS request of a turn reuses a live TLS connection
    instead of paying -- and occasionally stalling on -- a fresh handshake.
    `/key` is a free metadata read, not billed.
    """
    try:
        await _http().get("/key", headers=_headers(), timeout=_timeout(10.0))
    except ProviderNotConfigured:
        return
    except Exception as exc:  # noqa: BLE001 - warming must never break a session
        logger.info("OpenRouter warm-up skipped (%s)", _describe(exc))


#: Stable per conversation so OpenRouter pins follow-up turns to the provider
#: endpoint already holding the warm KV cache (documented: a 10-minute
#: best-effort pin keyed on `session_id`). JARVIS has one conversation thread,
#: so one id per process, rotated after long idle so a stale pin never sticks.
_session_id: str | None = None
_session_last_used = 0.0
_SESSION_IDLE_ROTATE_SECONDS = 30 * 60


def _conversation_session_id() -> str:
    global _session_id, _session_last_used
    now_ = time.monotonic()
    if _session_id is None or now_ - _session_last_used > _SESSION_IDLE_ROTATE_SECONDS:
        import uuid

        _session_id = f"jarvis-{uuid.uuid4().hex[:16]}"
    _session_last_used = now_
    return _session_id


async def _post_with_retry(
    url: str, json_body: dict[str, Any], *, read_timeout: float,
) -> httpx.Response:
    """One retry on a transport failure, one on a transient status (429/5xx).

    A stalled connect fails after `openrouter_connect_timeout` (4s, not 10s)
    and is retried at once on a fresh connection -- the live evidence is that
    the retry connects normally. A 4xx other than 429 is never retried: that
    is a stable rejection (bad payload/model/key) a retry cannot fix.
    """
    try:
        response = await _post_timed(url, json_body, read_timeout)
    except _TRANSPORT_ERRORS as exc:
        logger.warning("OpenRouter %s failed (%s); retrying once", url, _describe(exc))
        return await _post_timed(url, json_body, read_timeout)

    if response.status_code == 429 or response.status_code >= 500:
        logger.warning(
            "OpenRouter %s returned %d; retrying once after backoff", url, response.status_code,
        )
        await asyncio.sleep(0.4)
        return await _post_timed(url, json_body, read_timeout)
    return response


async def _post_timed(url: str, json_body: dict[str, Any], read_timeout: float) -> httpx.Response:
    """POST and read the whole body, recording time-to-first-byte separately.

    The audio endpoints answer with a chunked body, so first-byte vs last-byte
    tells "the provider was slow to start" apart from "the download to this
    device was slow" -- the question a live 29s TTS on the phone raised while
    the same request from desktop took ~1s. OpenRouter's generation lookup
    does not cover audio (404), so this is the only way to see it.
    """
    client = _http()
    request = client.build_request(
        "POST", url, json=json_body, headers=_headers(), timeout=_timeout(read_timeout),
    )
    started = time.perf_counter()
    response = await client.send(request, stream=True)
    first_byte = time.perf_counter() - started
    try:
        await response.aread()
    finally:
        await response.aclose()
    response.extensions["jarvis_timing"] = (first_byte, time.perf_counter() - started)
    return response


def _log_audio_timing(label: str, response: httpx.Response) -> None:
    first_byte, total = response.extensions.get("jarvis_timing", (0.0, 0.0))
    logger.info(
        "OpenRouter %s timing: first-byte %.2fs, complete %.2fs, %d bytes, gen=%s",
        label, first_byte, total, len(response.content),
        response.headers.get("x-generation-id", "-"),
    )


async def _hedged(label: str, attempt, hedge_after: float) -> httpx.Response:
    """Run `attempt()`; if it has not answered within `hedge_after`, fire an
    identical second request and take whichever succeeds first.

    For the audio endpoints only, where the tail is the problem: identical
    requests measured 0.8s one moment and 13s the next (a live voice turn sat
    silent 13s waiting on one TTS call while direct probes took ~1.5s). A
    duplicate usually lands on a different, faster upstream instance. It costs
    almost nothing -- Kokoro is ~$0.62 per million characters, Whisper-turbo
    ~$0.04/hour -- and only fires on the slow tail, not every request.
    Never used for chat: that stream drives tool calls and would double-bill
    a large prompt.
    """
    tasks: list[asyncio.Task] = [asyncio.create_task(attempt())]
    started = time.perf_counter()
    try:
        done, _ = await asyncio.wait(tasks, timeout=hedge_after)
        if done:
            return tasks[0].result()
        logger.info("OpenRouter %s slow (>%.1fs); sending a hedge request", label, hedge_after)
        tasks.append(asyncio.create_task(attempt()))
        pending = set(tasks)
        fallback: httpx.Response | None = None
        error: BaseException | None = None
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task.exception() is not None:
                    error = task.exception()
                    continue
                response = task.result()
                if response.status_code >= 400 and pending:
                    fallback = response  # a real error answer; see if the other succeeds
                    continue
                logger.info(
                    "OpenRouter %s answered by the %s request after %.2fs", label,
                    "hedge" if task is tasks[1] else "original", time.perf_counter() - started,
                )
                return response
        if fallback is not None:
            return fallback
        assert error is not None
        raise error
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()


def _extract_usage(raw: dict[str, Any] | None) -> dict[str, int]:
    """Flatten OpenRouter's usage block, including the nested cache fields.

    Live-verified (2026-09-16): OpenRouter/Qwen genuinely returns
    ``prompt_tokens_details.cached_tokens`` -- and it genuinely reflects real
    prefix-cache hits, including on streaming requests (two identical-prefix
    requests measured 5/1428 then 1427/1428 cached). A flat
    ``{k: v for k, v in usage.items() if isinstance(v, int)}`` silently drops
    this since it lives one level down and would never surface -- exactly
    the kind of caching claim this project's own discipline says never to
    make without proof, so it is pulled out explicitly here instead.
    """
    if not raw:
        return {}
    flat = {k: v for k, v in raw.items() if isinstance(v, int)}
    details = raw.get("prompt_tokens_details")
    if isinstance(details, dict):
        for key in ("cached_tokens", "cache_write_tokens"):
            value = details.get(key)
            if isinstance(value, int):
                flat[key] = value
    return flat


def _raise_for_status(response: httpx.Response, body: bytes) -> None:
    if response.status_code < 400:
        return
    try:
        detail = json.loads(body).get("error", {})
        message = detail.get("message", "") or body.decode(errors="replace")[:400]
    except (json.JSONDecodeError, UnicodeDecodeError):
        message = body.decode(errors="replace")[:400]

    if response.status_code in (401, 403):
        raise ProviderAuthError(
            f"OpenRouter rejected the API key ({response.status_code}): {message}. "
            "Check OPENROUTER_API_KEY in backend/.env."
        )
    if response.status_code == 429:
        raise ProviderRateLimited(f"OpenRouter rate limited or out of credit: {message}")
    if response.status_code >= 500:
        raise ProviderUnavailable(f"OpenRouter failed ({response.status_code}): {message}")
    raise ProviderError(f"OpenRouter rejected the request ({response.status_code}): {message}")


class WebSearchRouter:
    """Decides whether a turn needs OpenRouter's built-in web-search plugin.

    Deterministic heuristics only, per the spec this was built against --
    invoking another LLM call just to classify every message would add a
    full round trip to every single turn, defeating the low-latency goal
    this whole pipeline exists for. Errs toward NOT searching: JARVIS's own
    ``web_search``/``fetch_url`` tools (already in the tool list every
    ChatProvider receives) are the fallback path for anything this misses,
    so a false negative here costs a tool-call round trip, not a wrong
    answer -- while a false positive costs latency on every ordinary turn.
    """

    #: Recency/current-events cues. Deliberately broad-but-cheap: substring
    #: matches on a lowercased turn, no NLP.
    _CUES = (
        "latest", "recent", "today", "current", "currently", "right now",
        "this week", "this month", "score", "news", "weather", "price of",
        "stock price", "who is the current", "who won", "released today",
        "search the web", "search online", "look up", "look this up",
    )
    _YEAR_RE = re.compile(r"\b20(2[5-9]|3\d)\b")  # 2025-2039: "in 2026" etc.

    @classmethod
    def needs_live_information(cls, text: str) -> bool:
        lowered = text.lower()
        if any(cue in lowered for cue in cls._CUES):
            return True
        return bool(cls._YEAR_RE.search(lowered))


class OpenRouterChat:
    """Talks to OpenRouter. Pooled client, one instance per process (via
    ``get_chat_provider``/``get_english_chat_provider`` when the cloud stack
    is active)."""

    name = "openrouter"

    def __init__(self) -> None:
        self.model = settings.openrouter_model
        self._result = ChatResult()

    async def aclose(self) -> None:
        await close_shared_client()

    def last_result(self) -> ChatResult:
        return self._result

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        incremental: bool = True,
        reasoning_effort: str | None = None,
        enable_web_search: bool | None = None,
    ) -> AsyncIterator[ChatChunk]:
        """``enable_web_search`` is an explicit override for callers that
        already know (e.g. ``run_turn`` calling ``WebSearchRouter`` on the
        user's text); when ``None`` the plugin is left off, since only a
        caller that has seen the actual user turn can decide correctly."""
        requested_model = model or self.model
        payload: dict[str, Any] = {
            "model": requested_model,
            "messages": list(messages),
            "stream": incremental,
            "max_tokens": max_tokens or settings.jarvis_max_tokens,
            # OpenAI-compatible streaming omits `usage` from every chunk
            # unless this is set -- without it, voice turns (which always
            # stream) got no usage back at all, so the per-turn token
            # logging added alongside this would have logged nothing.
            **({"stream_options": {"include_usage": True}} if incremental else {}),
            # Sticky routing to the provider holding this conversation's warm
            # KV cache -- see `_conversation_session_id`. Real voice turns were
            # measuring 5/4121 cached tokens without it, versus 1427/1428 on
            # back-to-back identical requests: the prefix was cacheable, the
            # turns were just landing on different provider instances.
            "session_id": _conversation_session_id(),
        }
        if tools:
            payload["tools"] = list(tools)
        if enable_web_search:
            payload["plugins"] = [
                {"id": "web", "max_results": settings.openrouter_web_max_results}
            ]

        self._result = ChatResult()

        if not incremental:
            try:
                response = await _post_with_retry(
                    "/chat/completions", payload, read_timeout=settings.openrouter_chat_timeout,
                )
            except httpx.HTTPError as exc:
                raise ProviderUnavailable(f"OpenRouter request failed ({_describe(exc)}).") from exc
            if response.status_code >= 400:
                _raise_for_status(response, response.content)
            body = response.json()
            choice = (body.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            text = message.get("content") or ""
            calls = [
                ToolCall(
                    id=c.get("id", ""),
                    name=(c.get("function") or {}).get("name", ""),
                    arguments=(c.get("function") or {}).get("arguments", ""),
                    index=i,
                )
                for i, c in enumerate(message.get("tool_calls") or [])
            ]
            self._result = ChatResult(
                content=text, tool_calls=calls,
                finish_reason=choice.get("finish_reason"),
                usage=_extract_usage(body.get("usage")),
            )
            if text:
                yield ChatChunk(kind="text", text=text)
            for call in calls:
                yield ChatChunk(kind="tool_call_started", tool_call=call)
            return

        # Up to two attempts, but the second only if NOTHING has reached the
        # caller yet: a retry after text was yielded would speak the start of
        # the answer twice. Before first output it is always safe -- a stalled
        # connect never sent the request, and a mid-flight drop before any
        # token costs at most a duplicate prompt charge, far better than the
        # dead 10-second turn the user heard live.
        attempt = 0
        while True:
            attempt += 1
            state = _StreamState()
            emitted = False
            try:
                async for chunk in self._stream_once(payload, state):
                    emitted = True
                    yield chunk
                break
            except (httpx.HTTPError, _RetryableStatus) as exc:
                if emitted or attempt >= 2:
                    if isinstance(exc, _RetryableStatus):
                        _raise_for_status(exc.response, exc.body)
                    raise ProviderUnavailable(
                        f"OpenRouter stream failed ({_describe(exc)})."
                    ) from exc
                logger.warning(
                    "OpenRouter chat stream failed before any output (%s); retrying once",
                    _describe(exc),
                )
                if isinstance(exc, _RetryableStatus):
                    await asyncio.sleep(0.4)

        calls = [
            ToolCall(id=s["id"], name=s["name"], arguments=s["arguments"], index=i)
            for i, s in sorted(state.partial.items())
            if s["name"]
        ]
        self._result = ChatResult(
            content="".join(state.content), tool_calls=calls,
            finish_reason=state.finish_reason, usage=state.usage,
        )

    async def _stream_once(
        self, payload: dict[str, Any], state: "_StreamState",
    ) -> AsyncIterator[ChatChunk]:
        """One streaming attempt; accumulates into `state`, yields only real
        chunks, so the caller's "anything yielded yet?" check is exact."""
        async with _http().stream(
            "POST", "/chat/completions", json=payload, headers=_headers(),
            timeout=_timeout(settings.openrouter_chat_timeout),
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                if response.status_code == 429 or response.status_code >= 500:
                    raise _RetryableStatus(response, response.content)
                _raise_for_status(response, response.content)

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
                    state.usage = _extract_usage(event["usage"])

                choices = event.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                if choice.get("finish_reason"):
                    state.finish_reason = choice["finish_reason"]
                delta = choice.get("delta") or {}

                if delta.get("content"):
                    text = str(delta["content"])
                    state.content.append(text)
                    yield ChatChunk(kind="text", text=text)

                for fragment in delta.get("tool_calls") or []:
                    index = int(fragment.get("index", 0))
                    slot = state.partial.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    if fragment.get("id"):
                        slot["id"] = fragment["id"]
                    function = fragment.get("function") or {}
                    if function.get("name"):
                        slot["name"] = function["name"]
                    if function.get("arguments"):
                        slot["arguments"] += function["arguments"]
                    if slot["name"] and index not in state.announced:
                        state.announced.add(index)
                        yield ChatChunk(
                            kind="tool_call_started",
                            tool_call=ToolCall(
                                id=slot["id"], name=slot["name"],
                                arguments="", index=index,
                            ),
                        )


class _StreamState:
    """What one streaming attempt accumulated; discarded wholesale on retry."""

    def __init__(self) -> None:
        self.content: list[str] = []
        self.partial: dict[int, dict[str, str]] = {}
        self.announced: set[int] = set()
        self.finish_reason: str | None = None
        self.usage: dict[str, int] = {}


class _RetryableStatus(Exception):
    """A 429/5xx on the stream -- a real server answer, but a transient one."""

    def __init__(self, response: httpx.Response, body: bytes) -> None:
        super().__init__(f"HTTP {response.status_code}")
        self.response = response
        self.body = body


# ---------------------------------------------------------------------------
# STT / TTS (OpenRouter's newer audio API)
# ---------------------------------------------------------------------------

class OpenRouterSTT:
    """``STTProvider`` — Whisper large-v3-turbo via OpenRouter's own
    ``/audio/transcriptions``, English/Hindi/Telugu.

    Confirmed live (2026-09-16), not assumed: ``openai/whisper-large-v3-turbo``
    is a real, working model id on this endpoint -- transcribed a real test
    clip successfully -- and came back cheaper than plain ``whisper-large-v3``
    for the same 1s clip ($0.00000333 vs $0.0000075, per the response's own
    ``usage.cost``). Turbo trades a small amount of accuracy for materially
    lower latency and cost on the distilled decoder; worth switching back if
    real-world transcription quality regresses, but nothing in the live test
    suggested that.
    """

    name = "openrouter"

    def __init__(self) -> None:
        self.model = settings.openrouter_stt_model

    async def aclose(self) -> None:
        await close_shared_client()

    async def transcribe(
        self,
        audio: bytes,
        filename: str = "audio.webm",
        content_type: str = "audio/webm",
        language_code: str | None = None,
    ) -> Transcript:
        import base64 as _b64

        fmt = filename.rsplit(".", 1)[-1] if "." in filename else "webm"
        payload: dict[str, Any] = {
            "model": self.model,
            "input_audio": {"data": _b64.b64encode(audio).decode("ascii"), "format": fmt},
        }
        if language_code:
            payload["language"] = language_code.split("-")[0]
        try:
            response = await _hedged(
                "STT",
                lambda: _post_with_retry(
                    "/audio/transcriptions", payload, read_timeout=settings.openrouter_audio_timeout,
                ),
                settings.openrouter_stt_hedge_seconds,
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(
                f"OpenRouter STT request failed ({_describe(exc)})."
            ) from exc
        _log_audio_timing("STT", response)
        if response.status_code >= 400:
            _raise_for_status(response, response.content)
        body = response.json()
        text = str(body.get("text", "")).strip()
        return Transcript(text=text, language_code=body.get("language"), confidence=None)


class OpenRouterTTS:
    """``TTSProvider`` over OpenRouter's own ``/audio/speech``.

    Parameterized by model/default-voice so one class serves two distinct
    roles in the registry: Kokoro-82M for English/Hindi (its 8 languages
    don't include Telugu), and OpenAI's ``gpt-4o-mini-tts`` for Telugu.

    The Telugu case is a real caveat, not a confirmed fit: OpenAI documents
    "50+ languages" for this model without an exhaustive list, and Telugu is
    not explicitly named one way or the other in their public docs (unlike
    Grok TTS, which explicitly excludes it). This is the best available
    option given no separate XAI_API_KEY and Soniox deferred by choice, but
    it has not been confirmed against real Telugu output quality -- listen
    to the first few real Telugu replies before trusting it unattended.
    """

    name = "openrouter"
    max_chars = 4000

    def __init__(self, model: str = "hexgrad/kokoro-82m", default_voice: str = "af_sky") -> None:
        self.model = model
        self._default_voice = default_voice

    async def aclose(self) -> None:
        await close_shared_client()

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
        # `speaker` here is the app's own voice id (Sarvam names like
        # "priya") from `current_voice()` -- a different namespace from this
        # model's own voices (Kokoro's "af_sky" etc., Grok's "eve"). Passing
        # it through was a real, 100%-reproducing bug: OpenRouter rejected
        # every request with a 400 ("Provider returned 400") because
        # "priya"/etc. isn't a voice this model knows, which is what was
        # actually behind every "speech was interrupted by a synthesis
        # error" in the field, not a network issue. There is also no UI path
        # to choose a real voice for these languages under the cloud stack
        # (VoiceMode hides "Speaking voice" for English/Hindi/Telugu), so
        # this model's own default is always correct here.
        payload: dict[str, Any] = {
            "model": self.model,
            "input": clean[: self.max_chars],
            "voice": self._default_voice,
            "response_format": "mp3",
            "speed": settings.openrouter_tts_speed,
        }
        try:
            response = await _hedged(
                "TTS",
                lambda: _post_with_retry(
                    "/audio/speech", payload, read_timeout=settings.openrouter_audio_timeout,
                ),
                settings.openrouter_tts_hedge_seconds,
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(
                f"OpenRouter TTS request failed ({_describe(exc)})."
            ) from exc
        _log_audio_timing("TTS", response)
        if response.status_code >= 400:
            _raise_for_status(response, response.content)
        return Speech(audio=response.content, content_type="audio/mpeg")
