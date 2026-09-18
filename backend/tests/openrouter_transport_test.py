"""OpenRouter transport resilience, against a fake network (no live requests,
no credits, no database).

Pins down the 2026-09-18 fix for "OpenRouter stream failed ()": a stalled
connect is retried on a fresh connection, a transient 429/5xx is retried,
but a failure *after* output reached the caller is never retried (that would
speak the start of an answer twice). Also checks every stage shares one
connection pool with a real keep-alive, errors name their exception type,
and the conversation `session_id` is sent and stable.

    .venv/Scripts/python.exe tests/openrouter_transport_test.py
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import httpx  # noqa: E402

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


def sse(*events: dict) -> bytes:
    lines = [f"data: {json.dumps(e)}\n\n" for e in events] + ["data: [DONE]\n\n"]
    return "".join(lines).encode()


GOOD_STREAM = sse(
    {"choices": [{"delta": {"content": "Hello "}}]},
    {"choices": [{"delta": {"content": "boss."}, "finish_reason": "stop"}]},
    {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 2,
                              "prompt_tokens_details": {"cached_tokens": 90}}},
)


class _DropsAfterFirstToken(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        raise httpx.ReadError("connection dropped mid-answer")


def install(handler) -> list[httpx.Request]:
    """Route the shared client through `handler`; returns the request log."""
    from app.providers import openrouter

    seen: list[httpx.Request] = []

    def logged(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request, len(seen))

    openrouter._test_transport = httpx.MockTransport(logged)
    openrouter._client = None  # force a rebuild onto the fake transport
    return seen


async def collect(provider, **kw) -> str:
    out = []
    async for chunk in provider.stream([{"role": "user", "content": "hi"}], **kw):
        if chunk.kind == "text":
            out.append(chunk.text)
    return "".join(out)


async def main() -> int:
    from app.core.config import settings
    from app.providers import openrouter
    from app.providers.base import ProviderUnavailable
    from app.providers.openrouter import OpenRouterChat, OpenRouterSTT

    settings.openrouter_api_key = "sk-or-test-not-real"
    chat = OpenRouterChat()

    # 1. Stalled connect on the first attempt -> retried, answer arrives once.
    def stall_then_ok(request, n):
        if n == 1:
            raise httpx.ConnectTimeout("handshake stalled", request=request)
        return httpx.Response(200, content=GOOD_STREAM)

    seen = install(stall_then_ok)
    text = await collect(chat)
    check("stalled connect is retried and the answer arrives", text == "Hello boss.", repr(text))
    check("exactly two attempts were made", len(seen) == 2, str(len(seen)))
    usage = chat.last_result().usage
    check("usage (incl. cached_tokens) survives the retry", usage.get("cached_tokens") == 90, str(usage))

    body = json.loads(seen[-1].content)
    check("session_id is sent with the chat request", str(body.get("session_id", "")).startswith("jarvis-"), str(body.get("session_id")))
    check("auth header is sent per request", seen[-1].headers.get("authorization") == "Bearer sk-or-test-not-real")

    # 2. Transient 503 -> retried after backoff.
    seen = install(lambda r, n: httpx.Response(503, json={"error": {"message": "busy"}}) if n == 1
                   else httpx.Response(200, content=GOOD_STREAM))
    text = await collect(chat)
    check("a 503 before any output is retried", text == "Hello boss." and len(seen) == 2, f"{text!r}, {len(seen)} calls")

    # 3. Drop AFTER the first token -> must NOT retry (would repeat speech).
    seen = install(lambda r, n: httpx.Response(200, stream=_DropsAfterFirstToken()))
    got: list[str] = []
    raised = None
    try:
        async for chunk in chat.stream([{"role": "user", "content": "hi"}]):
            if chunk.kind == "text":
                got.append(chunk.text)
    except ProviderUnavailable as exc:
        raised = exc
    check("a drop after output is not retried", len(seen) == 1, f"{len(seen)} calls")
    check("the partial output was delivered exactly once", got == ["Hello"], str(got))
    check("the error names the exception type", raised is not None and "ReadError" in str(raised), str(raised))

    # 4. Two stalls in a row -> one clear, typed error (not "failed ()").
    install(lambda r, n: (_ for _ in ()).throw(httpx.ConnectTimeout("", request=r)))
    try:
        await collect(chat)
        check("two stalls raise ProviderUnavailable", False, "no error raised")
    except ProviderUnavailable as exc:
        check("two stalls raise a typed, readable error", "ConnectTimeout" in str(exc), str(exc))

    # 5. A 400 is a real rejection -> never retried.
    seen = install(lambda r, n: httpx.Response(400, json={"error": {"message": "bad model"}}))
    try:
        await collect(chat)
    except Exception:  # noqa: BLE001
        pass
    check("a 400 is not retried", len(seen) == 1, f"{len(seen)} calls")

    # 6. STT: stalled connect retried on the shared pool.
    seen = install(lambda r, n: (_ for _ in ()).throw(httpx.ConnectTimeout("", request=r)) if n == 1
                   else httpx.Response(200, json={"text": "remind me at nine"}))
    transcript = await OpenRouterSTT().transcribe(b"\x00" * 64, filename="a.wav")
    check("STT stalled connect is retried", transcript.text == "remind me at nine" and len(seen) == 2,
          f"{transcript.text!r}, {len(seen)} calls")

    # 7. One pool for every stage, with a real keep-alive.
    openrouter._test_transport = None
    openrouter._client = None
    first = openrouter._http()
    check("every stage gets the same pooled client", openrouter._http() is first)
    pool_expiry = first._transport._pool._keepalive_expiry
    check("keep-alive is far longer than httpx's 5s default",
          pool_expiry == settings.openrouter_keepalive_seconds and pool_expiry >= 30, str(pool_expiry))
    check("connect timeout is the short setting", first.timeout.connect == settings.openrouter_connect_timeout,
          str(first.timeout.connect))

    # 8. session_id is stable across turns.
    a, b = openrouter._conversation_session_id(), openrouter._conversation_session_id()
    check("session_id is stable between turns", a == b, f"{a} vs {b}")

    await openrouter.close_shared_client()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
