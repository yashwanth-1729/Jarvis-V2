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

    # 6b. TTS hedge: a stuck first request is beaten by the duplicate.
    import time as _time
    from app.providers.openrouter import OpenRouterTTS

    settings.openrouter_tts_hedge_seconds = 0.2

    async def slow_first(request, n):
        if n == 1:
            await asyncio.sleep(3.0)
            return httpx.Response(200, content=b"slow-audio")
        return httpx.Response(200, content=b"fast-audio")

    seen = install(lambda r, n: slow_first(r, n))
    t0 = _time.perf_counter()
    speech = await OpenRouterTTS().synthesize("Got it, boss.")
    took = _time.perf_counter() - t0
    check("a stuck TTS request is beaten by the hedge", speech.audio == b"fast-audio" and took < 1.5,
          f"{speech.audio!r} in {took:.2f}s")
    check("exactly one hedge was sent", len(seen) == 2, f"{len(seen)} calls")

    # 6c. A normal-speed TTS answer never triggers a duplicate (no double billing).
    seen = install(lambda r, n: httpx.Response(200, content=b"audio"))
    await OpenRouterTTS().synthesize("Got it, boss.")
    await asyncio.sleep(0.4)
    check("a fast TTS answer sends no hedge", len(seen) == 1, f"{len(seen)} calls")

    # 6d. STT hedge works the same way.
    settings.openrouter_stt_hedge_seconds = 0.2

    async def slow_first_stt(request, n):
        if n == 1:
            await asyncio.sleep(3.0)
        return httpx.Response(200, json={"text": f"attempt {n}"})

    seen = install(lambda r, n: slow_first_stt(r, n))
    transcript = await OpenRouterSTT().transcribe(b"\x00" * 64, filename="a.wav")
    check("a stuck STT request is beaten by the hedge", transcript.text == "attempt 2", transcript.text)

    # 6e. Primary voice down (5xx after its retry) -> backup voice speaks.
    def grok_down(request, n):
        body = json.loads(request.content)
        if body["model"].startswith("x-ai/"):
            return httpx.Response(502, json={"error": {"message": "bad gateway"}})
        return httpx.Response(200, content=b"backup-audio")

    seen = install(grok_down)
    tts = OpenRouterTTS(model="x-ai/grok-voice-tts-1.0", default_voice="eve",
                        fallback=("hexgrad/kokoro-82m", "hf_alpha"))
    speech = await tts.synthesize("ठीक है बॉस")
    models = [json.loads(r.content)["model"] for r in seen]
    check("a Grok outage falls back to the backup voice", speech.audio == b"backup-audio", str(models))
    check("the backup used its own voice", json.loads(seen[-1].content)["voice"] == "hf_alpha")

    # 6f. A 4xx is a real rejection -> no fallback, the error surfaces.
    seen = install(lambda r, n: httpx.Response(400, json={"error": {"message": "bad voice"}}))
    try:
        await tts.synthesize("ठीक है बॉस")
        check("a 400 does not fall back", False, "no error raised")
    except Exception:  # noqa: BLE001
        check("a 400 does not fall back", all(json.loads(r.content)["model"].startswith("x-ai/") for r in seen),
              str([json.loads(r.content)["model"] for r in seen]))

    # 6g. Gemini fallback: asks for PCM, sends no speed, returns playable WAV.
    seen = install(lambda r, n: httpx.Response(502) if json.loads(r.content)["model"].startswith("x-ai/")
                   else httpx.Response(200, content=b"\x00\x00" * 2400))
    tts_te = OpenRouterTTS(model="x-ai/grok-voice-tts-1.0", default_voice="eve",
                           fallback=("google/gemini-3.1-flash-tts-preview", "Kore"))
    speech = await tts_te.synthesize("సరే బాస్")
    gem = json.loads(seen[-1].content)
    check("Gemini fallback asks for pcm without speed", gem["response_format"] == "pcm" and "speed" not in gem, str(gem))
    check("Gemini audio is wrapped as WAV", speech.content_type == "audio/wav" and speech.audio[:4] == b"RIFF",
          speech.content_type)

    # 6h. STT: language is passed through, and an xAI outage falls back to
    #     the other vendor's recognizer.
    settings.openrouter_stt_model = "x-ai/grok-stt-1.0"
    settings.openrouter_stt_fallback_model = "openai/gpt-transcribe"

    def xai_down(request, n):
        body = json.loads(request.content)
        if body["model"].startswith("x-ai/"):
            return httpx.Response(502, json={"error": {"message": "bad gateway"}})
        return httpx.Response(200, json={"text": "సరే బాస్"})

    seen = install(xai_down)
    transcript = await OpenRouterSTT().transcribe(b"\x00" * 64, filename="a.wav", language_code="te-IN")
    bodies = [json.loads(r.content) for r in seen]
    check("STT falls back to the other vendor on an outage", transcript.text == "సరే బాస్" and bodies[-1]["model"] == "openai/gpt-transcribe",
          str([b["model"] for b in bodies]))
    check("the selected language reaches every STT request", all(b.get("language") == "te" for b in bodies),
          str([b.get("language") for b in bodies]))

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

    # 9. Gemini keeps volatile system text out of its cached prefix and has thinking off;
    #    OpenAI-family requests are left as they were.
    msgs = [{"role": "system", "content": "persona"}, {"role": "user", "content": "hi"}]
    gem = openrouter._mark_cache_breakpoint("google/gemini-2.5-flash", msgs)
    check("Gemini persona stays a plain string (implicit caching, no breakpoint)",
          gem[0]["content"] == "persona", str(gem[0]))
    claude = openrouter._mark_cache_breakpoint("anthropic/claude-sonnet-5", msgs)
    check("Anthropic persona carries cache_control",
          claude[0]["content"][0].get("cache_control") == {"type": "ephemeral"}
          and claude[0]["content"][0]["text"] == "persona", str(claude[0]))
    check("the caller's messages are not mutated", msgs[0]["content"] == "persona")
    later = [{"role": "system", "content": "persona"}, {"role": "user", "content": "hi"},
             {"role": "system", "content": "Time: 12:01"}]
    moved = openrouter._mark_cache_breakpoint("google/gemini-2.5-flash", later)
    check("Gemini: later system messages become labelled user notes (clock out of the cache)",
          moved[2]["role"] == "user" and moved[2]["content"].endswith("Time: 12:01")
          and moved[2]["content"].startswith("[JARVIS system note"), str(moved[2]))
    check("the leading persona stays the system message", moved[0]["role"] == "system")
    check("OpenAI-family keeps later system messages as system",
          openrouter._mark_cache_breakpoint("openai/gpt-4.1-nano", later)[2]["role"] == "system")
    check("OpenAI-family messages stay plain strings",
          openrouter._mark_cache_breakpoint("openai/gpt-4.1-nano", msgs) == msgs)
    bodies = []
    def capture(request: httpx.Request, _n: int) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}),
                              headers={"content-type": "text/event-stream"})
    install(capture)
    await collect(OpenRouterChat(), model="google/gemini-2.5-flash")
    await collect(OpenRouterChat(), model="google/gemini-2.5-flash", reasoning_effort="high")
    await collect(OpenRouterChat(), model="openai/gpt-4.1-nano")
    check("Gemini ordinary turns disable thinking", bodies[0].get("reasoning") == {"max_tokens": 0}, str(bodies[0].get("reasoning")))
    check("Gemini reasoning turns keep their effort", bodies[1].get("reasoning") == {"effort": "high"}, str(bodies[1].get("reasoning")))
    check("nano requests carry no reasoning field", "reasoning" not in bodies[2])

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
