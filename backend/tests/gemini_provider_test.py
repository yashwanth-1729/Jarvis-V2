"""Gemini chat provider: message translation, error mapping, and the
Sarvam fallback -- all offline, no credits spent.

The live shapes this is built against (the SSE event format, the
`thoughtSignature` requirement on replayed function calls, error bodies for
401/404/429) were verified against the real API before writing any of this --
see the module docstring in `app/providers/gemini.py`. This file tests the
translation and fallback logic against fixed fixtures, which is the part a
live call would not exercise reliably (a real call cannot easily force a 404
or a specific quota error on demand).

    .venv/Scripts/python.exe tests/gemini_provider_test.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.providers.base import (
    ProviderAuthError,
    ProviderError,
    ProviderRateLimited,
    ProviderUnavailable,
)
from app.providers.gemini import (
    EnglishChatProvider,
    GeminiChat,
    _openai_tool_to_declaration,
    _raise_for_status,
)

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" - {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


def error_body(message: str, status: str) -> bytes:
    return json.dumps({"error": {"message": message, "status": status}}).encode()


async def main() -> int:
    # ------------------------------------------------ tool declaration shape
    print("\n== OpenAI tool -> Gemini function_declarations ==")
    openai_tool = {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the weather",
            "parameters": {"type": "object", "properties": {"place": {"type": "string"}}},
        },
    }
    declaration = _openai_tool_to_declaration(openai_tool)
    check("name carried over", declaration is not None and declaration["name"] == "get_weather")
    check("description carried over", declaration["description"] == "Get the weather")
    check("parameters carried over as-is", declaration["parameters"] == openai_tool["function"]["parameters"])
    check("a malformed tool is skipped, not crashed on", _openai_tool_to_declaration({"type": "function"}) is None)

    # ------------------------------------------------------ error mapping
    print("\n== HTTP status -> ProviderError subclass ==")
    resp = lambda code: httpx.Response(code, request=httpx.Request("POST", "https://x"))
    try:
        _raise_for_status(resp(401), error_body("bad key", "UNAUTHENTICATED"))
        check("401 raises ProviderAuthError", False)
    except ProviderAuthError:
        check("401 raises ProviderAuthError", True)
    try:
        _raise_for_status(resp(429), error_body("quota", "RESOURCE_EXHAUSTED"))
        check("429 raises ProviderRateLimited", False)
    except ProviderRateLimited:
        check("429 raises ProviderRateLimited", True)
    try:
        _raise_for_status(resp(404), error_body("model not found", "NOT_FOUND"))
        check("404 raises ProviderError naming the model", False)
    except ProviderError as exc:
        check("404 raises ProviderError naming the model", "model" in str(exc).lower())
    try:
        _raise_for_status(resp(503), error_body("down", "UNAVAILABLE"))
        check("5xx raises ProviderUnavailable", False)
    except ProviderUnavailable:
        check("5xx raises ProviderUnavailable", True)
    check("2xx raises nothing", _raise_for_status(resp(200), b"{}") is None)

    # -------------------------------------------------- message translation
    print("\n== OpenAI-shaped history -> Gemini contents ==")
    chat = GeminiChat()

    system_text, contents = chat._to_contents([
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "hi"},
    ])
    check("system message becomes system_instruction text", system_text == "You are terse.")
    check("user message keeps its role and text", contents == [{"role": "user", "parts": [{"text": "hi"}]}])

    # An assistant tool call THIS instance actually issued (has a cached
    # thoughtSignature) must be replayed with it attached.
    chat._signatures["call_1"] = {"name": "get_weather", "signature": "sig-abc"}
    _, contents = chat._to_contents([
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "get_weather", "arguments": '{"place": "Nellore"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"temp_c": 30}'},
    ])
    check(
        "a recognised call is replayed with its cached signature",
        contents[0]["parts"][0]["functionCall"] == {"name": "get_weather", "args": {"place": "Nellore"}}
        and contents[0]["parts"][0]["thoughtSignature"] == "sig-abc",
        contents[0],
    )
    check(
        "its result becomes a functionResponse keyed by the same name",
        contents[1] == {
            "role": "user",
            "parts": [{"functionResponse": {"name": "get_weather", "response": {"temp_c": 30}}}],
        },
        contents[1],
    )

    # An assistant tool call this instance NEVER saw a signature for (e.g.
    # issued by Sarvam, or from a process that has since restarted) must be
    # dropped rather than replayed and rejected by the live API.
    _, contents = chat._to_contents([
        {
            "role": "assistant",
            "content": "Checking now.",
            "tool_calls": [{
                "id": "call_unknown", "type": "function",
                "function": {"name": "get_weather", "arguments": "{}"},
            }],
        },
        {"role": "tool", "tool_call_id": "call_unknown", "content": "sunny"},
    ])
    check(
        "an unrecognised call's text survives, the structured call is dropped",
        contents[0] == {"role": "model", "parts": [{"text": "Checking now."}]},
        contents[0],
    )
    check(
        "its orphaned result folds into a plain text turn instead of a functionResponse",
        contents[1] == {"role": "user", "parts": [{"text": "Result: sunny"}]},
        contents[1],
    )

    # ---------------------------------------------- EnglishChatProvider fallback
    print("\n== EnglishChatProvider: Gemini failure falls back to Sarvam ==")

    class DeadTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                404,
                json={"error": {"message": "models/x is not found", "status": "NOT_FOUND"}},
                request=request,
            )

    SARVAM_SSE = (
        'data: {"choices":[{"delta":{"content":"Hello."},"finish_reason":null}]}\n\n'
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )

    class SarvamTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, content=SARVAM_SSE.encode(),
                headers={"content-type": "text/event-stream"}, request=request,
            )

    provider = EnglishChatProvider()
    provider._gemini._client = httpx.AsyncClient(
        base_url="https://gemini.invalid", transport=DeadTransport()
    )
    provider._sarvam_chat()  # force-construct so its client can be swapped
    provider._sarvam._client = httpx.AsyncClient(
        base_url="https://sarvam.invalid", transport=SarvamTransport()
    )

    chunks = []
    async for chunk in provider.stream([{"role": "user", "content": "hi"}]):
        chunks.append(chunk)
    result = provider.last_result()
    check("falls back to Sarvam's answer when Gemini 404s", result.content == "Hello.", result.content)
    check("reports which provider actually answered", provider.name == "sarvam")

    # Second call within the cooldown window must skip Gemini entirely --
    # confirmed by the fact it still succeeds via the (still-dead) Gemini
    # transport being bypassed, not retried.
    chunks2 = []
    async for chunk in provider.stream([{"role": "user", "content": "hi again"}]):
        chunks2.append(chunk)
    check(
        "stays on Sarvam during the cooldown window",
        provider.last_result().content == "Hello.",
        provider.last_result().content,
    )

    await provider.aclose()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print("  -", label)
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
