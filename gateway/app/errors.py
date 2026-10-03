"""One error shape for everything the gateway itself refuses.

    {"error": {"code": "insufficient_aura", "status": 402,
               "message": "Not enough Aura ...", ...extra fields}}

It deliberately matches OpenRouter's ``{"error": {"message": ...}}`` envelope:
the on-device backend's ``_raise_for_status`` reads ``error.message``, so a
gateway refusal surfaces as readable text with no client change. ``code`` is a
stable string the app can branch on (show the paywall, sign in again...);
``message`` is for people.

Upstream errors that are not about the user (400 from a bad payload, 429, 5xx)
are passed through in OpenRouter's own shape instead -- see
``proxy._upstream_error_response``.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


class GatewayError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        headers: dict[str, str] | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}
        self.extra = extra

    def response(self) -> JSONResponse:
        return error_response(
            self.status, self.code, self.message, headers=self.headers, **self.extra
        )


def error_body(status: int, code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": {"code": code, "status": status, "message": message, **extra}}


def error_response(
    status: int, code: str, message: str, *, headers: dict[str, str] | None = None,
    **extra: Any,
) -> JSONResponse:
    return JSONResponse(
        error_body(status, code, message, **extra), status_code=status, headers=headers,
    )
