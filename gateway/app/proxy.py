"""The OpenRouter-shaped endpoints, mounted at ``/api/v1`` so the app only
changes its host.

The on-device backend (``backend/app/providers/openrouter.py``) sends exactly
these, and each is relayed as-is apart from the noted changes:

* ``POST /chat/completions`` -- JSON, ``stream`` true (SSE) or false. Forced on:
  usage accounting (``usage: {include: true}`` and, for streams,
  ``stream_options.include_usage``) so the body or the final SSE chunk always
  carries ``usage`` with cached tokens and OpenRouter's own ``cost``.
  Clamped: ``max_tokens``. Dropped unless allowed: the paid web plugin.
* ``POST /audio/transcriptions`` -- JSON ``{model, input_audio: {data: base64,
  format}, language?}``; forwarded unchanged. Not multipart: OpenRouter's
  audio API is JSON and so is the app.
* ``POST /audio/speech`` -- JSON ``{model, input, voice, response_format,
  speed, language?}``. ``language`` is the app's hint for the Telugu gate and
  is removed before forwarding. The audio is streamed back as it arrives.
* ``GET /key`` -- the backend's connection warm-up (``warm_connection``) reads
  OpenRouter's free ``/key``; answered locally so warming costs nothing.

Every metered call is: admit (token, account, rate limit) -> model allow-list
-> feature gate -> reserve -> forward with the server key -> settle. ``Charge``
guarantees the settle happens exactly once on every path, including a client
that hangs up mid-stream.
"""

from __future__ import annotations

import json
import logging
import time
from decimal import Decimal
from typing import Any, AsyncIterator, Awaitable, Callable

import anyio
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from starlette.types import Receive, Scope, Send

from app.accounts import Reservation
from app.context import Gateway, admit, authenticate, gateway, require_feature
from app.errors import GatewayError, error_response
from app.limits import read_json
from app.metering import (
    ChatUsage,
    ModelPrice,
    aura_to_milli,
    audio_seconds_estimate,
    chat_cost_usd,
    extract_chat_usage,
    is_telugu,
    stt_cost_usd,
    telugu_share,
    tts_cost_usd,
    usd_to_inr,
    usd_to_milli,
)
from app.plans import FEATURES

logger = logging.getLogger("holo.gateway.proxy")

router = APIRouter(prefix="/api/v1")


# ---------------------------------------------------------------------------
# Settling
# ---------------------------------------------------------------------------

class Charge:
    """One reserved call. ``settle`` runs at most once; later calls are no-ops,
    so every exit path can call it and the first (most specific) one wins.
    ``milli=None`` charges the reserve: the rule for a call that reached the
    provider but produced no usage to meter."""

    def __init__(
        self, gw: Gateway, reservation: Reservation, *, streamed: bool,
        language: Any = None,
    ) -> None:
        self.gw = gw
        self.reservation = reservation
        self.streamed = streamed
        self.language = str(language)[:16] if language else None
        self.started = time.perf_counter()
        self.settled = False

    async def settle(
        self, *, status: str, milli: int | None = None, cost_usd: Decimal = Decimal(0),
        upstream_cost: Decimal | None = None, http_status: int | None = None,
        **fields: Any,
    ) -> None:
        if self.settled:
            return
        self.settled = True
        charged = self.reservation.amount_milli if milli is None else milli
        record = {
            "status": status,
            "streamed": self.streamed,
            "http_status": http_status,
            "cost_usd": float(cost_usd),
            "upstream_cost_usd": float(upstream_cost) if upstream_cost is not None else None,
            "cost_inr": float(usd_to_inr(cost_usd, self.gw.settings)),
            "language": self.language,
            "duration_ms": int((time.perf_counter() - self.started) * 1000),
            **fields,
        }
        # Shielded: a client hanging up cancels this task, and the charge
        # must still be written.
        with anyio.CancelScope(shield=True):
            try:
                await self.gw.bank.settle(self.reservation, charged, record)
            except Exception:  # noqa: BLE001
                # The hold stays and the stale-hold sweep charges its reserve.
                logger.exception("settle failed for hold %s", self.reservation.id)
                return
        logger.info(
            "%s %s user=%s status=%s http=%s milli=%d cost=$%.7f %.0fms",
            self.reservation.endpoint, self.reservation.model, self.reservation.user_id,
            status, http_status, charged, cost_usd, record["duration_ms"],
        )


def _usage_fields(usage: ChatUsage) -> dict[str, int]:
    return {
        "prompt_tokens": usage.prompt_tokens,
        "cached_tokens": usage.cached_tokens,
        "cache_write_tokens": usage.cache_write_tokens,
        "completion_tokens": usage.completion_tokens,
        "reasoning_tokens": usage.reasoning_tokens,
    }


def _higher_of(gw: Gateway, table_cost: Decimal, upstream_cost: Decimal | None) -> Decimal:
    if (
        gw.settings.charge_upstream_cost_if_higher
        and upstream_cost is not None
        and upstream_cost > table_cost
    ):
        return upstream_cost
    return table_cost


async def _settle_chat(
    gw: Gateway, price: ModelPrice, charge: Charge, raw_usage: Any, *,
    status: str, http_status: int, generation_id: Any = None,
) -> None:
    usage = extract_chat_usage(raw_usage)
    if usage is None:
        # Reached the provider, nothing to meter (a stream cut before its
        # final chunk): charge the reserve.
        await charge.settle(
            status="no_usage" if status == "ok" else status, http_status=http_status,
        )
        return
    cost = _higher_of(gw, chat_cost_usd(price, usage), usage.upstream_cost)
    await charge.settle(
        status=status, milli=usd_to_milli(cost, gw.settings), cost_usd=cost,
        upstream_cost=usage.upstream_cost, http_status=http_status,
        generation_id=str(generation_id)[:128] if generation_id else None,
        **_usage_fields(usage),
    )


# ---------------------------------------------------------------------------
# Upstream plumbing
# ---------------------------------------------------------------------------

def _upstream_headers(gw: Gateway, *, sse: bool = False) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {gw.settings.openrouter_api_key}",
        # OpenRouter's attribution headers, as the backend sends them.
        "HTTP-Referer": gw.settings.openrouter_referer,
        "X-Title": gw.settings.app_name,
    }
    if sse:
        # No compression on the event stream: every chunk is relayed the
        # moment it lands, and a gzip layer would only add buffering.
        headers["Accept"] = "text/event-stream"
        headers["Accept-Encoding"] = "identity"
    return headers


def _timeout(gw: Gateway, read: float) -> httpx.Timeout:
    return httpx.Timeout(read, connect=gw.settings.openrouter_connect_timeout)


def _require_upstream(gw: Gateway) -> None:
    if not gw.settings.openrouter_api_key:
        raise GatewayError(503, "gateway_not_configured", "The AI service is not configured yet.")


def _unreachable(exc: BaseException) -> GatewayError:
    logger.warning("OpenRouter unreachable (%s: %s)", type(exc).__name__, exc)
    return GatewayError(502, "upstream_unreachable", "Couldn't reach the AI provider. Try again.")


def _upstream_error_response(status: int, body: bytes, content_type: str | None) -> Response:
    """Pass a provider refusal through in OpenRouter's own shape -- except the
    ones about the *gateway's* account. Relayed as-is, a 401 would tell the
    app its user token is bad and a 402 would show the user an Aura paywall
    for the operator's empty OpenRouter balance."""
    if status in (401, 403):
        logger.error("OpenRouter rejected the gateway's API key (%d)", status)
        return error_response(
            502, "upstream_auth", "The AI provider rejected the gateway. Try again later.",
        )
    if status == 402:
        logger.error("OpenRouter says the gateway's account is out of credit")
        return error_response(
            503, "upstream_out_of_credit", "The AI provider is unavailable. Try again later.",
        )
    return Response(content=body, status_code=status, media_type=content_type or "application/json")


def _model_not_allowed(gw: Gateway, model: Any, kind: str) -> GatewayError:
    return GatewayError(
        400, "model_not_allowed", f"Model {model!r} is not available for this endpoint.",
        allowed=gw.models.allowed(kind),
    )


class RelayResponse(StreamingResponse):
    """A StreamingResponse that always cleans up after its relay.

    When the client hangs up, Starlette stops iterating but does not close
    the generator, so its ``finally`` (close upstream, settle) would wait for
    garbage collection. Closing it here runs that ``finally`` at once.
    ``finalize`` covers the one case a generator's ``finally`` cannot: a
    generator that never started (the client was gone before the first
    byte). It must be idempotent -- ``Charge.settle`` and ``aclose`` are.
    """

    def __init__(
        self, content: AsyncIterator[bytes], *,
        finalize: Callable[[], Awaitable[None]] | None = None, **kwargs: Any,
    ) -> None:
        super().__init__(content, **kwargs)
        self._finalize = finalize

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                closer = getattr(self.body_iterator, "aclose", None)
                if closer is not None:
                    await closer()
                if self._finalize is not None:
                    await self._finalize()


class SSEMeter:
    """Watches a relayed SSE byte stream for the fields billing needs without
    holding up a single byte: ``feed`` parses complete lines after the chunk
    has already been passed on."""

    _MAX_PENDING = 1 << 20

    def __init__(self) -> None:
        self._pending = b""
        self.usage: Any = None
        self.generation_id: str | None = None
        self.error: Any = None

    def feed(self, chunk: bytes) -> None:
        self._pending += chunk
        while (newline := self._pending.find(b"\n")) >= 0:
            line, self._pending = self._pending[:newline], self._pending[newline + 1:]
            self._line(line.rstrip(b"\r"))
        if len(self._pending) > self._MAX_PENDING:
            self._pending = b""  # not SSE; stop accumulating

    def close(self) -> None:
        if self._pending:
            self._line(self._pending.rstrip(b"\r"))
            self._pending = b""

    def _line(self, line: bytes) -> None:
        if not line.startswith(b"data:"):
            return  # blank separators and ": OPENROUTER PROCESSING" comments
        data = line[5:].strip()
        if not data or data == b"[DONE]":
            return
        try:
            event = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        if not isinstance(event, dict):
            return
        if event.get("usage"):
            self.usage = event["usage"]
        if event.get("id") and not self.generation_id:
            self.generation_id = str(event["id"])
        if event.get("error"):
            self.error = event["error"]


def _sse_error(message: str) -> bytes:
    """A mid-stream failure in OpenRouter's own convention (an SSE event with
    an ``error`` object), so the client sees why its stream ended early."""
    return b"data: " + json.dumps({"error": {"code": 502, "message": message}}).encode() + b"\n\n"


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

def _chat_payload(gw: Gateway, body: dict[str, Any], stream: bool) -> dict[str, Any]:
    payload = dict(body)
    # Usage accounting, forced on: the body (or the final SSE chunk) then
    # carries `usage` with prompt_tokens_details.cached_tokens and `cost`.
    payload["usage"] = {"include": True}
    if stream:
        payload["stream_options"] = {**(payload.get("stream_options") or {}), "include_usage": True}
    cap = gw.settings.max_output_tokens
    present = False
    for key in ("max_tokens", "max_completion_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            present = True
            payload[key] = min(max(value, 1), cap)
    if not present:
        payload["max_tokens"] = cap
    if not gw.settings.allow_web_plugin and isinstance(payload.get("plugins"), list):
        kept = [p for p in payload["plugins"] if not (isinstance(p, dict) and p.get("id") == "web")]
        if kept:
            payload["plugins"] = kept
        else:
            payload.pop("plugins")
    return payload


@router.post("/chat/completions")
async def chat_completions(request: Request) -> Response:
    gw = gateway(request)
    principal, acct = await admit(request)
    body = await read_json(request, gw.settings.max_body_bytes)
    price = gw.models.get(body.get("model"), "chat")
    if price is None:
        raise _model_not_allowed(gw, body.get("model"), "chat")
    if "models" in body:
        # OpenRouter fallback lists would route to models this table cannot price.
        raise GatewayError(400, "model_not_allowed", "Fallback model lists are not supported.")
    # Optional: the app names the feature a chat call serves (lockin, news,
    # autonomy...) and the plan is checked server-side.
    feature = request.headers.get("x-holo-feature", "").strip().lower()
    if feature in FEATURES:
        require_feature(gw, acct, feature)
    _require_upstream(gw)

    stream = body.get("stream") is True
    payload = _chat_payload(gw, body, stream)
    reservation = await gw.bank.reserve(
        principal.user_id, "chat", price.model, aura_to_milli(gw.settings.reserve_aura_chat),
    )
    charge = Charge(gw, reservation, streamed=stream)
    if stream:
        return await _chat_stream(gw, price, payload, charge)
    return await _chat_once(gw, price, payload, charge)


async def _chat_once(
    gw: Gateway, price: ModelPrice, payload: dict[str, Any], charge: Charge,
) -> Response:
    try:
        try:
            upstream = await gw.upstream.post(
                "/chat/completions", json=payload, headers=_upstream_headers(gw),
                timeout=_timeout(gw, gw.settings.openrouter_chat_timeout),
            )
        except httpx.HTTPError as exc:
            await charge.settle(status="upstream_unreachable", milli=0)
            raise _unreachable(exc) from exc
        content_type = upstream.headers.get("content-type")
        if upstream.status_code >= 400:
            await charge.settle(status="upstream_error", milli=0, http_status=upstream.status_code)
            return _upstream_error_response(upstream.status_code, upstream.content, content_type)
        try:
            data = upstream.json()  # tolerates OpenRouter's leading keep-alive whitespace
        except ValueError:
            data = None
        data = data if isinstance(data, dict) else {}
        await _settle_chat(
            gw, price, charge, data.get("usage"), status="ok",
            http_status=upstream.status_code, generation_id=data.get("id"),
        )
        return Response(
            content=upstream.content, status_code=upstream.status_code,
            media_type=content_type or "application/json",
        )
    finally:
        await charge.settle(status="aborted")  # no-op unless an exit above skipped it


async def _chat_stream(
    gw: Gateway, price: ModelPrice, payload: dict[str, Any], charge: Charge,
) -> Response:
    request = gw.upstream.build_request(
        "POST", "/chat/completions", json=payload, headers=_upstream_headers(gw, sse=True),
        timeout=_timeout(gw, gw.settings.openrouter_chat_timeout),
    )
    try:
        upstream = await gw.upstream.send(request, stream=True)
    except httpx.HTTPError as exc:
        await charge.settle(status="upstream_unreachable", milli=0)
        raise _unreachable(exc) from exc
    except BaseException:
        await charge.settle(status="aborted")
        raise

    if upstream.status_code >= 400:
        try:
            body = await upstream.aread()
        except httpx.HTTPError:
            body = b""
        finally:
            await upstream.aclose()
        await charge.settle(status="upstream_error", milli=0, http_status=upstream.status_code)
        return _upstream_error_response(
            upstream.status_code, body, upstream.headers.get("content-type"),
        )

    meter = SSEMeter()

    async def relay() -> AsyncIterator[bytes]:
        # Each chunk is yielded the moment it arrives; the meter reads it
        # afterwards. Nothing is buffered on the way through.
        status = "client_aborted"
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
                meter.feed(chunk)
            meter.close()
            status = "ok"
        except httpx.HTTPError as exc:
            status = "upstream_dropped"
            logger.warning("chat stream dropped upstream (%s: %s)", type(exc).__name__, exc)
            yield _sse_error("The AI provider's stream was interrupted.")
        finally:
            with anyio.CancelScope(shield=True):
                await upstream.aclose()
            await _settle_chat(
                gw, price, charge, meter.usage, status=status,
                http_status=upstream.status_code, generation_id=meter.generation_id,
            )

    async def finalize() -> None:
        await upstream.aclose()
        await charge.settle(status="client_aborted", http_status=upstream.status_code)

    return RelayResponse(
        relay(), finalize=finalize, status_code=upstream.status_code,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def _voice_gate(gw: Gateway, acct: Any, *, telugu: bool) -> None:
    require_feature(gw, acct, "voice_en")
    if telugu:
        require_feature(gw, acct, "voice_te")


@router.post("/audio/transcriptions")
async def transcriptions(request: Request) -> Response:
    gw = gateway(request)
    principal, acct = await admit(request)
    body = await read_json(request, gw.settings.max_body_bytes)
    price = gw.models.get(body.get("model"), "stt")
    if price is None:
        raise _model_not_allowed(gw, body.get("model"), "stt")
    # `language` is a real OpenRouter field here: read for the gate, forwarded.
    language = body.get("language") or request.headers.get("x-holo-language")
    _voice_gate(gw, acct, telugu=is_telugu(language))
    audio = body.get("input_audio")
    if not isinstance(audio, dict) or not isinstance(audio.get("data"), str) or not audio["data"]:
        raise GatewayError(400, "invalid_request", "input_audio.data (base64 audio) is required.")
    seconds = audio_seconds_estimate(audio["data"], str(audio.get("format") or "wav"), gw.settings)
    estimate = usd_to_milli(stt_cost_usd(price, seconds), gw.settings)
    _require_upstream(gw)

    reservation = await gw.bank.reserve(
        principal.user_id, "stt", price.model,
        max(aura_to_milli(gw.settings.reserve_aura_stt), estimate),
    )
    charge = Charge(gw, reservation, streamed=False, language=language)
    try:
        try:
            upstream = await gw.upstream.post(
                "/audio/transcriptions", json=body, headers=_upstream_headers(gw),
                timeout=_timeout(gw, gw.settings.openrouter_audio_timeout),
            )
        except httpx.HTTPError as exc:
            await charge.settle(status="upstream_unreachable", milli=0)
            raise _unreachable(exc) from exc
        content_type = upstream.headers.get("content-type")
        if upstream.status_code >= 400:
            await charge.settle(status="upstream_error", milli=0, http_status=upstream.status_code)
            return _upstream_error_response(upstream.status_code, upstream.content, content_type)
        try:
            data = upstream.json()
        except ValueError:
            data = None
        reported = data.get("usage") if isinstance(data, dict) else None
        upstream_cost: Decimal | None = None
        if isinstance(reported, dict):
            # The provider's own duration and cost beat the local estimate.
            measured = reported.get("seconds")
            if isinstance(measured, (int, float)) and not isinstance(measured, bool) and measured > 0:
                seconds = float(measured)
            cost_value = reported.get("cost")
            if isinstance(cost_value, (int, float)) and not isinstance(cost_value, bool) and cost_value >= 0:
                upstream_cost = Decimal(str(cost_value))
        cost = _higher_of(gw, stt_cost_usd(price, seconds), upstream_cost)
        await charge.settle(
            status="ok", milli=usd_to_milli(cost, gw.settings), cost_usd=cost,
            upstream_cost=upstream_cost, http_status=upstream.status_code,
            audio_seconds=round(seconds, 3),
        )
        return Response(
            content=upstream.content, status_code=upstream.status_code,
            media_type=content_type or "application/json",
        )
    finally:
        await charge.settle(status="aborted", audio_seconds=round(seconds, 3))


@router.post("/audio/speech")
async def speech(request: Request) -> Response:
    gw = gateway(request)
    principal, acct = await admit(request)
    body = await read_json(request, gw.settings.max_body_bytes)
    price = gw.models.get(body.get("model"), "tts")
    if price is None:
        raise _model_not_allowed(gw, body.get("model"), "tts")
    # The app's language hint. Not an OpenRouter field: removed before forwarding.
    language = body.pop("language", None) or request.headers.get("x-holo-language")
    text = body.get("input")
    if not isinstance(text, str) or not text.strip():
        raise GatewayError(400, "invalid_request", "input (the text to speak) is required.")
    if len(text) > gw.settings.tts_max_chars:
        raise GatewayError(
            400, "input_too_long", f"input is over {gw.settings.tts_max_chars} characters.",
        )
    ratio = gw.settings.telugu_script_gate_ratio
    telugu = is_telugu(language) or (ratio > 0 and telugu_share(text) >= ratio)
    _voice_gate(gw, acct, telugu=telugu)
    chars = len(text)
    cost = tts_cost_usd(price, chars)
    milli = usd_to_milli(cost, gw.settings)
    _require_upstream(gw)

    reservation = await gw.bank.reserve(
        principal.user_id, "tts", price.model,
        max(aura_to_milli(gw.settings.reserve_aura_tts), milli),
    )
    charge = Charge(gw, reservation, streamed=True, language=language or ("te" if telugu else None))
    upstream_request = gw.upstream.build_request(
        "POST", "/audio/speech", json=body, headers=_upstream_headers(gw),
        timeout=_timeout(gw, gw.settings.openrouter_audio_timeout),
    )
    try:
        upstream = await gw.upstream.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        await charge.settle(status="upstream_unreachable", milli=0, chars=chars)
        raise _unreachable(exc) from exc
    except BaseException:
        await charge.settle(status="aborted", milli=milli, cost_usd=cost, chars=chars)
        raise

    if upstream.status_code >= 400:
        try:
            error_body = await upstream.aread()
        except httpx.HTTPError:
            error_body = b""
        finally:
            await upstream.aclose()
        await charge.settle(
            status="upstream_error", milli=0, http_status=upstream.status_code, chars=chars,
        )
        return _upstream_error_response(
            upstream.status_code, error_body, upstream.headers.get("content-type"),
        )

    async def relay() -> AsyncIterator[bytes]:
        status = "client_aborted"
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
            status = "ok"
        except httpx.HTTPError as exc:
            # Audio has no in-band error: cut the response so the client
            # sees a failed download (and falls back) rather than playing
            # a clip that stops mid-word.
            status = "upstream_dropped"
            logger.warning("TTS stream dropped upstream (%s: %s)", type(exc).__name__, exc)
            raise
        finally:
            with anyio.CancelScope(shield=True):
                await upstream.aclose()
            # Once the provider answered 2xx it synthesized -- and bills --
            # the whole input, whether or not every byte reached the phone.
            await charge.settle(
                status=status, milli=milli, cost_usd=cost,
                http_status=upstream.status_code, chars=chars,
            )

    async def finalize() -> None:
        await upstream.aclose()
        await charge.settle(
            status="client_aborted", milli=milli, cost_usd=cost,
            http_status=upstream.status_code, chars=chars,
        )

    return RelayResponse(
        relay(), finalize=finalize, status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type") or "audio/mpeg",
    )


# ---------------------------------------------------------------------------
# Warm-up
# ---------------------------------------------------------------------------

@router.get("/key")
async def key_info(request: Request) -> dict[str, Any]:
    """Stands in for OpenRouter's ``GET /key``, which the backend calls every
    few seconds during a voice session to keep a pooled TLS connection warm.
    Token check only: no database, no rate limit, no upstream call."""
    gw = gateway(request)
    await authenticate(request)
    return {"data": {"label": f"{gw.settings.app_name} gateway", "usage": 0, "limit": None,
                     "is_free_tier": False}}
