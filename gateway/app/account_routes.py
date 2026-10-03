"""Account endpoints: ``/v1/me``, the Lock-in trial, admin grants and health."""

from __future__ import annotations

import hmac
import logging
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.context import account_view, admit, gateway
from app.errors import GatewayError
from app.limits import read_json
from app.metering import aura_to_milli

logger = logging.getLogger("holo.gateway.account")

router = APIRouter()


@router.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    gw = gateway(request)
    try:
        await gw.db.ping()
    except Exception as exc:  # noqa: BLE001 - any DB failure is "unhealthy"
        logger.error("health check: database unreachable (%s)", type(exc).__name__)
        return JSONResponse({"ok": False, "database": "unreachable"}, status_code=503)
    return JSONResponse({
        "ok": True,
        "database": "ok",
        "upstream_key": bool(gw.settings.openrouter_api_key),
        "models": {kind: gw.models.allowed(kind) for kind in ("chat", "stt", "tts")},
    })


@router.get("/v1/me")
async def me(request: Request) -> dict[str, Any]:
    gw = gateway(request)
    _, acct = await admit(request)
    return await account_view(gw, acct)


@router.post("/v1/trial/lockin")
async def start_lockin_trial(request: Request) -> JSONResponse:
    """Start the 3-day Lock-in trial: once per account, ever. 409 the second
    time, with the account body so the app can show the trial's state."""
    gw = gateway(request)
    principal, _ = await admit(request)
    acct, started = await gw.bank.start_lockin_trial(principal.user_id)
    view = await account_view(gw, acct)
    if not started:
        raise GatewayError(
            409, "trial_used", "The Lock-in trial has already been used on this account.",
            trial=view["trial"]["lockin"],
        )
    logger.info("Lock-in trial started for %s", principal.user_id)
    return JSONResponse(view, status_code=200)


@router.post("/v1/admin/grant")
async def admin_grant(request: Request) -> dict[str, Any]:
    """Manual testing and support: set a plan and/or add Aura.

    Header ``X-Admin-Token: <ADMIN_TOKEN>``. Body::

        {"user_id": "<supabase sub>",
         "plan": "side_quest",       # optional; starts a fresh period
         "days": 30,                 # optional; the plan ends after this
         "topup_aura": 150,          # optional; ledger kind "topup"
         "refund_aura": 5,           # optional; ledger kind "refund"
         "note": "why"}

    The account is created if the user has never called the gateway.
    """
    gw = gateway(request)
    expected = gw.settings.admin_token
    if not expected:
        raise GatewayError(503, "admin_disabled", "Admin endpoints are not enabled.")
    given = request.headers.get("x-admin-token", "")
    if not hmac.compare_digest(given.encode(), expected.encode()):
        raise GatewayError(401, "unauthorized", "Bad or missing admin token.")

    body = await read_json(request, gw.settings.max_body_bytes)
    user_id = body.get("user_id")
    if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 64:
        raise GatewayError(400, "invalid_request", "user_id is required.")
    note = str(body.get("note") or "admin grant")[:200]
    plan = body.get("plan")
    days = body.get("days")
    if plan is not None and (not isinstance(plan, str) or not gw.plans.exists(plan)):
        raise GatewayError(400, "invalid_request", f"Unknown plan {plan!r}.")
    if days is not None and (not isinstance(days, int) or isinstance(days, bool) or days <= 0):
        raise GatewayError(400, "invalid_request", "days must be a positive integer.")
    amounts: list[tuple[str, int]] = []
    for field, kind in (("topup_aura", "topup"), ("refund_aura", "refund")):
        value = body.get(field)
        if value is None:
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise GatewayError(400, "invalid_request", f"{field} must be a positive number.")
        amounts.append((kind, aura_to_milli(value)))
    if plan is None and not amounts:
        raise GatewayError(400, "invalid_request", "Nothing to grant: give plan or an Aura amount.")

    acct = await gw.bank.account(user_id)
    if plan is not None:
        expires = gw.clock() + timedelta(days=days) if days else None
        acct = await gw.bank.set_plan(
            user_id, plan, source="admin", expires_at=expires, note=f"admin: {note}",
        )
    for kind, milli in amounts:
        acct = await gw.bank.add_aura(user_id, milli, kind=kind, note=f"admin: {note}")
    logger.info("admin grant for %s: plan=%s amounts=%s", user_id, plan, amounts)
    return await account_view(gw, acct)
