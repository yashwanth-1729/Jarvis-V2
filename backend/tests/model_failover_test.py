"""Per-request model override falls back to the configured default when the
override stops answering, and stays out of the way afterwards.

Written after 2026-09-11, when `sarvam-105b-conversations` (the voice model)
began timing out on every request while `sarvam-105b` answered the same prompt
in ~1.2s. Voice mode hung on every turn: the old failure path retried the
*same* unresponsive model, so each turn paid two full timeouts and still
failed.

Entirely offline -- the transport is stubbed, so this costs no credits and
does not depend on either model being up.

    .venv/Scripts/python.exe tests/model_failover_test.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.providers.base import ProviderUnavailable
from app.providers.sarvam import SarvamChat

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" - {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


OK_BODY = {
    "choices": [{"message": {"content": "All clear, boss.", "role": "assistant"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}

MESSAGES = [{"role": "user", "content": "what's on today?"}]


#: The same reply as OK_BODY, in the SSE shape the streaming parser expects.
#: A streaming request that got plain JSON would parse to empty content and
#: look like a failover bug rather than a fixture bug.
SSE_BODY = (
    'data: {"choices":[{"delta":{"content":"All clear, boss."},"finish_reason":null}]}\n\n'
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
    "data: [DONE]\n\n"
)


class FakeTransport(httpx.AsyncBaseTransport):
    """Times out for `dead_model`, answers instantly for anything else."""

    def __init__(self, dead_model: str) -> None:
        self.dead_model = dead_model
        self.attempts: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        import json as _json

        payload = _json.loads(request.content)
        model = payload["model"]
        self.attempts.append(model)
        if model == self.dead_model:
            raise httpx.ReadTimeout("simulated stall", request=request)
        if payload.get("stream"):
            return httpx.Response(
                200,
                content=SSE_BODY.encode(),
                headers={"content-type": "text/event-stream"},
                request=request,
            )
        return httpx.Response(200, json=OK_BODY, request=request)


def build(dead_model: str) -> tuple[SarvamChat, FakeTransport]:
    """A chat client whose transport survives the fallback's pool reopen.

    The production fallback calls `aclose()` before retrying -- reopening the
    connection pool is the point, since a half-dead pool is one of the things
    that can cause the original failure. That would drop an injected client
    and let the retry escape to the real API, so `_http` is patched to hand
    back the same stub every time and `aclose` is neutered for the test.
    """
    chat = SarvamChat()
    transport = FakeTransport(dead_model)
    client = httpx.AsyncClient(base_url="https://example.invalid", transport=transport)

    async def _noop_close() -> None:
        return None

    chat._http = lambda: client  # noqa: SLF001 - test seam
    chat.aclose = _noop_close  # type: ignore[method-assign]
    chat._real_close = client.aclose  # type: ignore[attr-defined]
    return chat, transport


async def drain(chat: SarvamChat, *, model: str | None, incremental: bool) -> str:
    async for _ in chat.stream(MESSAGES, None, model=model, incremental=incremental):
        pass
    return chat.last_result().content


async def main() -> int:
    default = SarvamChat().model
    voice = "sarvam-105b-conversations"
    assert voice != default, "test assumes the override differs from the default"

    for incremental in (True, False):
        label = "streaming" if incremental else "non-streaming"
        print(f"\n== {label}: override is down ==")
        chat, transport = build(dead_model=voice)

        content = await drain(chat, model=voice, incremental=incremental)
        check(f"{label}: turn still produces an answer", content == "All clear, boss.", repr(content))
        check(f"{label}: the dead override was tried", voice in transport.attempts)
        check(f"{label}: it failed over to the default", default in transport.attempts)
        check(
            f"{label}: the dead model was not retried before failing over",
            transport.attempts.count(voice) == 1,
            f"attempts={transport.attempts}",
        )

        # Second turn: the cooldown should route straight to the default.
        transport.attempts.clear()
        content = await drain(chat, model=voice, incremental=incremental)
        check(f"{label}: second turn still answers", content == "All clear, boss.")
        check(
            f"{label}: cooldown skips the dead model entirely",
            transport.attempts == [default],
            f"attempts={transport.attempts}",
        )
        await chat._real_close()

    print("\n== a healthy override is left alone ==")
    chat, transport = build(dead_model="something-else")
    await drain(chat, model=voice, incremental=True)
    check("healthy override is used", transport.attempts == [voice], f"attempts={transport.attempts}")
    check("no cooldown was armed", chat._override_down_until == 0.0)  # noqa: SLF001
    await chat._real_close()

    print("\n== the default failing is a real error, not a fallback loop ==")
    chat, transport = build(dead_model=SarvamChat().model)
    raised = None
    try:
        await drain(chat, model=None, incremental=False)
    except ProviderUnavailable as exc:
        raised = exc
    check("default failure surfaces ProviderUnavailable", raised is not None)
    check(
        "default kept its retry budget",
        transport.attempts.count(default) > 1,
        f"attempts={transport.attempts}",
    )
    await chat._real_close()

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for name in failures:
            print(f"  - {name}")
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
