"""Shared offline harness for the gateway tests.

Every test runs the real app (``create_app``) against:

* a scripted OpenRouter (``httpx.MockTransport``) that records each request,
* an auth transport that fails any Supabase call unless a test serves JWKS,
* ``FakePlayVerifier`` instead of Google,
* SQLite in a fresh temp directory, deleted afterwards,
* a controllable clock for periods, trials and expiry.

Nothing here can reach OpenRouter, Google or Supabase, and no real user data
is touched. Tokens are HS256 test tokens signed with a throwaway secret.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

GATEWAY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GATEWAY))

import httpx  # noqa: E402
import jwt  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.config import Settings  # noqa: E402
from app.db import Database, metadata  # noqa: E402
from app.main import create_app  # noqa: E402
from app.play import FakePlayVerifier  # noqa: E402

# A developer shell may export real gateway settings; the tests must never
# pick them up (a real OPENROUTER_API_KEY or DATABASE_URL above all).
for _name in Settings.model_fields:
    os.environ.pop(_name.upper(), None)

#: Optional: run the suites against Postgres instead of SQLite, e.g.
#: postgresql+asyncpg://holo:pw@localhost:5432/holo_test. Every gateway table
#: in it is DROPPED before each test, so the database name must contain
#: "test" -- never point this at a real gateway database.
TEST_DB = os.environ.get("GATEWAY_TEST_DATABASE_URL", "")
if TEST_DB and "test" not in TEST_DB.rsplit("/", 1)[-1]:
    raise SystemExit("GATEWAY_TEST_DATABASE_URL must name a throwaway database containing 'test'.")

SECRET = "gateway-test-secret-not-a-real-one-0123456789"
SERVER_KEY = "sk-or-test-server-key"
ADMIN = {"X-Admin-Token": "admin-test-token"}
START = datetime(2026, 10, 3, 6, 0, tzinfo=timezone.utc)

passed = 0
failed = 0


def check(label: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


def run(tests: list[Callable[[], Awaitable[None]]]) -> None:
    """Run each test, report, exit non-zero on any failure."""
    for test in tests:
        print(f"- {test.__name__}")
        try:
            asyncio.run(test())
        except Exception as exc:  # noqa: BLE001 - a crash is a failure, keep going
            import traceback

            traceback.print_exc()
            check(f"{test.__name__} ran without crashing", False, repr(exc))
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


def token(sub: str = "user-1", *, aud: str = "authenticated", exp_in: int = 3600,
          secret: str = SECRET, **claims: Any) -> str:
    now = int(time.time())
    payload = {"sub": sub, "aud": aud, "exp": now + exp_in, "iat": now,
               "role": "authenticated", **claims}
    return jwt.encode(payload, secret, algorithm="HS256")


def auth(sub: str = "user-1", **claims: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {token(sub, **claims)}"}


class Clock:
    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


class Upstream:
    """The scripted OpenRouter. ``handler`` gets each ``httpx.Request`` and
    returns a response (sync or async)."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.handler: Callable[[httpx.Request], Any] = lambda r: httpx.Response(
            500, json={"error": {"message": "no handler set"}},
        )

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        self.requests.append(request)
        result = self.handler(request)
        if inspect.isawaitable(result):
            result = await result
        return result

    def json(self, index: int = -1) -> dict[str, Any]:
        return json.loads(self.requests[index].content)


def _deny_auth_calls(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"unexpected auth/JWKS call to {request.url}")


# ---------------------------------------------------------------------------
# Canned OpenRouter bodies
# ---------------------------------------------------------------------------

def usage_block(prompt: int, completion: int, cached: int = 0, cost: float | None = None) -> dict:
    block: dict[str, Any] = {
        "prompt_tokens": prompt, "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_tokens_details": {"cached_tokens": cached, "cache_write_tokens": 0},
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    if cost is not None:
        block["cost"] = cost
    return block


def sse_event(event: dict[str, Any]) -> bytes:
    return b"data: " + json.dumps(event).encode() + b"\n\n"


def chat_stream_chunks(parts: list[str], usage: dict | None) -> list[bytes]:
    """What OpenRouter streams: a processing comment, content deltas, the
    finish chunk, the usage chunk (empty choices), then [DONE]."""
    chunks = [b": OPENROUTER PROCESSING\n\n"]
    for part in parts:
        chunks.append(sse_event({
            "id": "gen-test-1", "provider": "OpenAI", "model": "openai/gpt-6-luna",
            "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
        }))
    chunks.append(sse_event({
        "id": "gen-test-1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }))
    if usage is not None:
        chunks.append(sse_event({"id": "gen-test-1", "choices": [], "usage": usage}))
    chunks.append(b"data: [DONE]\n\n")
    return chunks


def stream_response(chunks: list[bytes], *, gate: asyncio.Event | None = None,
                    gate_after: int = 1, fail_after: int | None = None) -> httpx.Response:
    """An SSE response whose body arrives chunk by chunk. ``gate`` pauses
    after ``gate_after`` chunks until the test releases it; ``fail_after``
    drops the connection after that many chunks."""

    async def body():
        for i, chunk in enumerate(chunks):
            if fail_after is not None and i == fail_after:
                raise httpx.ReadError("connection reset by peer")
            if gate is not None and i == gate_after:
                await gate.wait()
            yield chunk

    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body())


def chat_json(text: str, usage: dict) -> dict[str, Any]:
    return {
        "id": "gen-test-2", "model": "openai/gpt-6-luna", "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "stop"}],
        "usage": usage,
    }


def wav_bytes(seconds: float, rate: int = 16000) -> bytes:
    import io
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(rate)
        clip.writeframes(bytes(int(rate * seconds) * 2))
    return buffer.getvalue()


def chat_body(*, stream: bool = True, model: str = "openai/gpt-6-luna", **extra: Any) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "hi"}],
            "stream": stream, "max_tokens": 800, **extra}


# ---------------------------------------------------------------------------
# The harness
# ---------------------------------------------------------------------------

class Harness:
    def __init__(self, *, auth_handler: Callable | None = None, **overrides: Any) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="holo-gateway-test-"))
        values: dict[str, Any] = dict(
            _env_file=None,
            openrouter_api_key=SERVER_KEY,
            supabase_jwt_secret=SECRET,
            supabase_url="",
            database_url=TEST_DB or f"sqlite+aiosqlite:///{(self.tmp / 'gateway.db').as_posix()}",
            admin_token=ADMIN["X-Admin-Token"],
            play_push_token="push-test-token",
            # Expected refusals log at WARNING/ERROR; keep test output to
            # PASS/FAIL lines. A crash still prints its traceback via run().
            log_level="CRITICAL",
        )
        values.update(overrides)
        self.settings = Settings(**values)
        self.clock = Clock(START)
        self.upstream = Upstream()
        self.play = FakePlayVerifier()
        self.app = create_app(
            self.settings,
            upstream_transport=httpx.MockTransport(self.upstream),
            auth_transport=httpx.MockTransport(auth_handler or _deny_auth_calls),
            play_verifier=self.play,
            clock=self.clock,
        )

    async def __aenter__(self) -> "Harness":
        if TEST_DB:
            scratch = Database(TEST_DB)
            async with scratch.engine.begin() as conn:
                await conn.run_sync(metadata.drop_all)
            await scratch.close()
        self._lifespan = self.app.router.lifespan_context(self.app)
        await self._lifespan.__aenter__()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://gateway",
        )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.client.aclose()
        await self._lifespan.__aexit__(*exc)
        shutil.rmtree(self.tmp, ignore_errors=True)

    @property
    def gw(self):
        return self.app.state.gw

    async def rows(self, table, **where: Any) -> list[dict[str, Any]]:
        query = select(table)
        for column, value in where.items():
            query = query.where(table.c[column] == value)
        if "id" in table.c:
            query = query.order_by(table.c.id)
        async with self.gw.db.read() as conn:
            return [dict(r) for r in (await conn.execute(query)).mappings().all()]

    async def me(self, sub: str = "user-1") -> dict[str, Any]:
        response = await self.client.get("/v1/me", headers=auth(sub))
        assert response.status_code == 200, response.text
        return response.json()

    async def grant(self, user_id: str = "user-1", **body: Any) -> httpx.Response:
        return await self.client.post(
            "/v1/admin/grant", headers=ADMIN, json={"user_id": user_id, **body},
        )


async def asgi_call(app, method: str, path: str, *, headers: dict[str, str], body: bytes,
                    on_chunk: Callable[[bytes], None] | None = None,
                    timeout: float = 5.0) -> tuple[int | None, list[bytes]]:
    """Drive the ASGI app directly and see each body message the moment it
    is sent. (httpx's ASGITransport collects the whole body before returning,
    which would hide buffering.)"""
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": method, "scheme": "http", "path": path,
        "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000), "server": ("gateway", 80),
    }
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(3600)  # the client stays connected
        return {"type": "http.disconnect"}

    status: int | None = None
    chunks: list[bytes] = []

    async def send(message: dict[str, Any]) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body" and message.get("body"):
            chunks.append(message["body"])
            if on_chunk is not None:
                on_chunk(message["body"])

    await asyncio.wait_for(app(scope, receive, send), timeout)
    return status, chunks
