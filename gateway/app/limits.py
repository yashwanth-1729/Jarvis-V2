"""Abuse limits that are not about money: request rate and body size.

The rate limiter is in memory, which is correct for the planned single
gateway process on one Mumbai VM. Running several processes or VMs would give
each its own window, multiplying the effective limit -- that needs a shared
store (Redis ``INCR``+``EXPIRE`` or a sorted-set window) behind the same
``hit()`` signature. The daily spend cap is *not* in memory: it is summed from
the usage table, so it holds across processes and restarts.
"""

from __future__ import annotations

import json
import time
from collections import deque
from typing import Any

from fastapi import Request

from app.errors import GatewayError


class RateLimiter:
    """Sliding one-minute window per key."""

    WINDOW = 60.0

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._calls = 0

    def hit(self, key: str, per_minute: int, now: float | None = None) -> float | None:
        """Count one request. Returns None if allowed, else seconds until the
        oldest request in the window ages out."""
        now = time.monotonic() if now is None else now
        window = self._hits.setdefault(key, deque())
        while window and now - window[0] >= self.WINDOW:
            window.popleft()
        if len(window) >= per_minute:
            return max(self.WINDOW - (now - window[0]), 0.001)
        window.append(now)
        self._calls += 1
        if self._calls % 1000 == 0:
            self._forget_idle(now)
        return None

    def _forget_idle(self, now: float) -> None:
        idle = [k for k, w in self._hits.items() if not w or now - w[-1] >= self.WINDOW]
        for key in idle:
            del self._hits[key]


async def read_json(request: Request, limit: int) -> dict[str, Any]:
    """The request body as a JSON object, refusing anything over ``limit``
    bytes *while* reading -- a declared Content-Length is checked first, and a
    chunked body that never declared one is cut off as soon as it passes."""
    content_type = request.headers.get("content-type", "")
    if content_type and "json" not in content_type.lower():
        raise GatewayError(
            415, "unsupported_media_type",
            "Send a JSON body (Content-Type: application/json).",
        )
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)
    parts: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _too_large(limit)
        parts.append(chunk)
    try:
        body = json.loads(b"".join(parts) or b"null")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise GatewayError(400, "invalid_json", "The request body is not valid JSON.")
    if not isinstance(body, dict):
        raise GatewayError(400, "invalid_json", "The request body must be a JSON object.")
    return body


def _too_large(limit: int) -> GatewayError:
    return GatewayError(
        413, "body_too_large", f"The request body is larger than {limit // 1024} KB.",
        limit_bytes=limit,
    )
