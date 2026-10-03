"""Chat proxying: SSE pass-through, metering from usage, allow-list, errors.

The upstream is a scripted OpenRouter (httpx.MockTransport). The no-buffering
test drives the ASGI app directly so it sees each chunk when it is sent.

    .venv/Scripts/python.exe tests/chat_test.py
"""

from __future__ import annotations

import asyncio
import json

from _support import (
    SERVER_KEY,
    Harness,
    asgi_call,
    auth,
    chat_body,
    chat_json,
    chat_stream_chunks,
    check,
    run,
    stream_response,
    token,
    usage_block,
)

import httpx

from app.db import accounts, ledger, reservations, usage

# 10,000 prompt tokens of which 8,000 cached, 200 completion, at GPT-6 Luna's
# $0.10 / $0.01 cached / $0.50 per 1M:
#   2,000 x 1e-7 + 8,000 x 1e-8 + 200 x 5e-7 = $0.00038
#   x 88 Rs/$ / Rs 0.10 per Aura x 1000 = 334.4 -> 335 milli-Aura (rounded up)
USAGE = usage_block(10_000, 200, cached=8_000, cost=0.0003)
EXPECTED_MILLI = 335


async def test_streaming_passthrough_and_settle() -> None:
    chunks = chat_stream_chunks(["Hel", "lo ", "there"], USAGE)
    async with Harness() as h:
        h.upstream.handler = lambda r: stream_response(chunks)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(max_tokens=999_999))
        check("stream -> 200", r.status_code == 200, r.text)
        check("content-type is text/event-stream",
              r.headers.get("content-type", "").startswith("text/event-stream"), r.headers)
        check("body is byte-identical to upstream, chunks in order",
              r.content == b"".join(chunks), r.content[:300])

        sent = h.upstream.requests[-1]
        check("forwarded with the server key, not the user's token",
              sent.headers["authorization"] == f"Bearer {SERVER_KEY}", sent.headers)
        payload = h.upstream.json()
        check("usage accounting forced on", payload.get("usage") == {"include": True}, payload)
        check("stream_options.include_usage forced on",
              payload.get("stream_options", {}).get("include_usage") is True, payload)
        check("max_tokens clamped to MAX_OUTPUT_TOKENS (4096)", payload["max_tokens"] == 4096, payload)
        check("upstream path is /chat/completions", sent.url.path.endswith("/chat/completions"),
              sent.url)

        rows = await h.rows(usage)
        check("one usage row", len(rows) == 1, rows)
        row = rows[0]
        check("usage row: endpoint/model/streamed/status",
              (row["endpoint"], row["model"], row["streamed"], row["status"])
              == ("chat", "openai/gpt-6-luna", True, "ok"), row)
        check("usage row: token counts from the final chunk",
              (row["prompt_tokens"], row["cached_tokens"], row["completion_tokens"])
              == (10_000, 8_000, 200), row)
        check("usage row: cost from the price table ($0.00038)",
              abs(row["cost_usd"] - 0.00038) < 1e-12, row["cost_usd"])
        check("usage row: OpenRouter's reported cost kept", row["upstream_cost_usd"] == 0.0003, row)
        check("usage row: cost in INR (x88)", abs(row["cost_inr"] - 0.03344) < 1e-9, row["cost_inr"])
        check("usage row: charged 335 milli-Aura", row["milli_aura"] == EXPECTED_MILLI, row)
        check("usage row: reserve recorded (1 Aura)", row["reserve_milli"] == 1000, row)
        check("usage row: generation id captured", row["generation_id"] == "gen-test-1", row)

        spends = [l for l in await h.rows(ledger) if l["kind"] == "spend"]
        check("one spend ledger row linked to the usage row",
              len(spends) == 1 and spends[0]["usage_id"] == row["id"], spends)
        check("spend came from the plan bucket",
              spends[0]["plan_delta_milli"] == -EXPECTED_MILLI
              and spends[0]["topup_delta_milli"] == 0
              and spends[0]["plan_after_milli"] == 50_000 - EXPECTED_MILLI, spends)
        acct = (await h.rows(accounts))[0]
        check("balance settled and hold released",
              acct["plan_milli"] == 50_000 - EXPECTED_MILLI and acct["held_milli"] == 0, acct)
        check("no reservation left open", await h.rows(reservations) == [])


async def test_stream_is_not_buffered() -> None:
    """The upstream pauses after its first chunk until the gateway has already
    sent that chunk on. A buffering relay would never send it, the upstream
    would never resume, and the call would time out."""
    gate = asyncio.Event()
    chunks = chat_stream_chunks(["first", "second"], USAGE)
    first = chunks[0]

    def on_chunk(data: bytes) -> None:
        if first in data:
            gate.set()

    async with Harness() as h:
        h.upstream.handler = lambda r: stream_response(chunks, gate=gate, gate_after=1)
        try:
            status, got = await asgi_call(
                h.app, "POST", "/api/v1/chat/completions",
                headers={"authorization": f"Bearer {token()}",
                         "content-type": "application/json"},
                body=json.dumps(chat_body()).encode(), on_chunk=on_chunk, timeout=5.0,
            )
        except asyncio.TimeoutError:
            check("first chunk relayed before the upstream finished", False, "timed out: buffered")
            return
        check("first chunk relayed before the upstream finished", gate.is_set())
        check("relayed as separate body messages, not one blob", len(got) >= len(chunks), len(got))
        check("all chunks arrive in order", b"".join(got) == b"".join(chunks))
        check("settled after the stream", (await h.rows(usage))[0]["milli_aura"] == EXPECTED_MILLI)


async def test_non_streamed_chat() -> None:
    body = chat_json("Hello!", usage_block(1_000, 1_000))
    async with Harness() as h:
        h.upstream.handler = lambda r: httpx.Response(200, json=body)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(stream=False))
        check("non-streamed -> 200 with the upstream JSON", r.status_code == 200 and r.json() == body,
              r.text)
        payload = h.upstream.json()
        check("usage forced on, no stream_options added",
              payload.get("usage") == {"include": True} and "stream_options" not in payload, payload)
        row = (await h.rows(usage))[0]
        # 1,000 x 1e-7 + 1,000 x 5e-7 = $0.0006 -> 528 milli
        check("metered from the body's usage (528 milli)",
              row["milli_aura"] == 528 and row["streamed"] is False and row["status"] == "ok", row)


async def test_model_allow_list() -> None:
    async with Harness() as h:
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(model="openai/gpt-5-pro"))
        error = r.json().get("error", {})
        check("unlisted model -> 400 model_not_allowed",
              r.status_code == 400 and error.get("code") == "model_not_allowed", r.text)
        check("400 lists the allowed chat models", error.get("allowed") == ["openai/gpt-6-luna"], error)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(model="hexgrad/kokoro-82m"))
        check("a TTS model on the chat endpoint -> 400", r.status_code == 400, r.text)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(model="openai/gpt-6-luna:online"))
        check("a model variant suffix is not on the list -> 400", r.status_code == 400, r.text)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(models=["openai/gpt-6-luna", "x/other"]))
        check("fallback model lists refused -> 400", r.status_code == 400, r.text)
        check("nothing was forwarded upstream", h.upstream.requests == [])
        check("nothing reserved or charged", await h.rows(usage) == [] and await h.rows(reservations) == [])


async def test_upstream_errors() -> None:
    async with Harness() as h:
        refusal = {"error": {"code": 400, "message": "bad tools schema"}}
        h.upstream.handler = lambda r: httpx.Response(400, json=refusal)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(), json=chat_body())
        check("upstream 400 passed through unchanged", r.status_code == 400 and r.json() == refusal,
              r.text)
        row = (await h.rows(usage))[-1]
        check("refused call charged nothing", row["status"] == "upstream_error"
              and row["milli_aura"] == 0 and row["http_status"] == 400, row)
        check("hold released", (await h.rows(accounts))[0]["held_milli"] == 0)

        h.upstream.handler = lambda r: httpx.Response(401, json={"error": {"message": "bad key"}})
        r = await h.client.post("/api/v1/chat/completions", headers=auth(), json=chat_body())
        check("upstream 401 (gateway key) -> 502 upstream_auth, not a user 401",
              r.status_code == 502 and r.json()["error"]["code"] == "upstream_auth", r.text)

        h.upstream.handler = lambda r: httpx.Response(402, json={"error": {"message": "credits"}})
        r = await h.client.post("/api/v1/chat/completions", headers=auth(),
                                json=chat_body(stream=False))
        check("upstream 402 (gateway credit) -> 503, never the user's 402",
              r.status_code == 503 and r.json()["error"]["code"] == "upstream_out_of_credit", r.text)

        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("stalled handshake")

        h.upstream.handler = unreachable
        r = await h.client.post("/api/v1/chat/completions", headers=auth(), json=chat_body())
        check("connect failure -> 502 upstream_unreachable",
              r.status_code == 502 and r.json()["error"]["code"] == "upstream_unreachable", r.text)
        check("every failed call left the balance whole",
              (await h.rows(accounts))[0]["plan_milli"] == 50_000)


async def test_stream_dropped_midway() -> None:
    chunks = chat_stream_chunks(["partial ", "answer"], USAGE)
    async with Harness() as h:
        h.upstream.handler = lambda r: stream_response(chunks, fail_after=2)
        r = await h.client.post("/api/v1/chat/completions", headers=auth(), json=chat_body())
        check("client got the chunks that made it", r.content.startswith(b"".join(chunks[:2])),
              r.content[:200])
        check("then an SSE error event", b'"error"' in r.content[len(b"".join(chunks[:2])):],
              r.content[-200:])
        row = (await h.rows(usage))[0]
        check("no usage seen -> charged the reserve (1 Aura)",
              row["status"] == "upstream_dropped" and row["milli_aura"] == 1000, row)
        check("hold released", (await h.rows(accounts))[0]["held_milli"] == 0)


async def test_upstream_cost_higher_wins() -> None:
    # Table cost of 1,000/1,000 tokens is $0.0006, but OpenRouter reports
    # $0.02 (say a paid plugin ran): charge the higher, $0.02 = 17,600 milli.
    body = chat_json("hi", usage_block(1_000, 1_000, cost=0.02))
    async with Harness(plan_overrides={"spawn": {"daily_cap_aura": 1000}}) as h:
        h.upstream.handler = lambda r: httpx.Response(200, json=body)
        await h.client.post("/api/v1/chat/completions", headers=auth(), json=chat_body(stream=False))
        row = (await h.rows(usage))[0]
        check("upstream-reported cost charged when higher",
              row["milli_aura"] == 17_600 and row["cost_usd"] == 0.02, row)


async def test_payload_guards() -> None:
    async with Harness() as h:
        h.upstream.handler = lambda r: httpx.Response(200, json=chat_json("ok", usage_block(10, 10)))
        await h.client.post(
            "/api/v1/chat/completions", headers=auth(),
            json=chat_body(stream=False, plugins=[{"id": "web", "max_results": 5}]),
        )
        check("paid web plugin dropped by default", "plugins" not in h.upstream.json(), h.upstream.json())
        body = chat_body(stream=False)
        body.pop("max_tokens")
        await h.client.post("/api/v1/chat/completions", headers=auth(), json=body)
        check("max_tokens set when the client sent none", h.upstream.json().get("max_tokens") == 4096)

        r = await h.client.post("/api/v1/chat/completions",
                                headers={**auth(), "X-Holo-Feature": "lockin"}, json=chat_body())
        check("X-Holo-Feature: lockin on spawn -> 403 feature_locked",
              r.status_code == 403 and r.json()["error"]["required_plan"] == "side_quest", r.text)


async def test_body_limit() -> None:
    async with Harness(max_body_bytes=2048) as h:
        big = chat_body(messages=[{"role": "user", "content": "x" * 5000}])
        r = await h.client.post("/api/v1/chat/completions", headers=auth(), json=big)
        check("body over MAX_BODY_BYTES -> 413 body_too_large",
              r.status_code == 413 and r.json()["error"]["code"] == "body_too_large", r.text)
        check("nothing forwarded", h.upstream.requests == [])


if __name__ == "__main__":
    run([
        test_streaming_passthrough_and_settle,
        test_stream_is_not_buffered,
        test_non_streamed_chat,
        test_model_allow_list,
        test_upstream_errors,
        test_stream_dropped_midway,
        test_upstream_cost_higher_wins,
        test_payload_guards,
        test_body_limit,
    ])
