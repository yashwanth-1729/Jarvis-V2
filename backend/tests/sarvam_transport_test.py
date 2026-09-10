"""Offline regression checks for voice-stream transport recovery.

No provider, database or user record is touched.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.providers.base import ChatChunk, ProviderUnavailable  # noqa: E402
from app.providers.sarvam import SarvamChat  # noqa: E402


class _Context:
    def __init__(self, response=None, error: Exception | None = None):
        self.response = response
        self.error = error

    async def __aenter__(self):
        if self.error is not None:
            raise self.error
        return self.response

    async def __aexit__(self, *_args):
        return False


class _Client:
    def __init__(self, context: _Context):
        self.context = context

    def stream(self, *_args, **_kwargs):
        return self.context


class _InterruptedResponse:
    status_code = 200

    async def aiter_lines(self):
        yield "data: " + json.dumps(
            {"choices": [{"delta": {"content": "Hello"}}]}
        )
        raise httpx.ReadError("")


async def main() -> None:
    before_output = SarvamChat()
    before_output._http = lambda: _Client(  # type: ignore[method-assign]
        _Context(error=httpx.ConnectTimeout(""))
    )

    fallback_calls = 0

    async def fallback(*_args, **_kwargs):
        nonlocal fallback_calls
        fallback_calls += 1
        yield ChatChunk(kind="text", text="Recovered")

    before_output._complete = fallback  # type: ignore[method-assign]
    recovered = [chunk.text async for chunk in before_output.stream([], incremental=True)]
    assert recovered == ["Recovered"]
    assert fallback_calls == 1

    after_output = SarvamChat()
    after_output._http = lambda: _Client(  # type: ignore[method-assign]
        _Context(response=_InterruptedResponse())
    )

    async def forbidden_fallback(*_args, **_kwargs):
        raise AssertionError("a partial stream must never be replayed")
        yield  # pragma: no cover

    after_output._complete = forbidden_fallback  # type: ignore[method-assign]
    partial: list[str] = []
    try:
        async for chunk in after_output.stream([], incremental=True):
            partial.append(chunk.text)
    except ProviderUnavailable as exc:
        assert "ReadError" in str(exc)
    else:
        raise AssertionError("an interrupted partial stream must report failure")
    assert partial == ["Hello"]

    print("sarvam transport recovery: 2 checks passed")


asyncio.run(main())
