"""What Google Play requires of an AI app with accounts.

* ``POST /v1/report``: "report this reply". Generative-AI apps must let users
  flag offensive output from inside the app.
* ``DELETE /v1/me``: account deletion from inside the app. The gateway's rows
  go (usage is kept for cost accounting, but anonymised), and the Supabase
  login too when ``SUPABASE_SERVICE_ROLE_KEY`` is set.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request, Response
from sqlalchemy import delete, insert, update

from app.context import admit, gateway
from app.db import accounts, ledger, reports, reservations, usage
from app.errors import GatewayError
from app.limits import read_json

logger = logging.getLogger("holo.gateway.compliance")

router = APIRouter()

REASONS = {"harmful", "hateful", "sexual", "wrong", "other"}


@router.post("/v1/report", status_code=201)
async def report(request: Request) -> dict[str, Any]:
    gw = gateway(request)
    principal, _ = await admit(request)
    body = await read_json(request, gw.settings.max_body_bytes)
    reason = str(body.get("reason") or "other")
    if reason not in REASONS:
        reason = "other"
    excerpt = str(body.get("excerpt") or "").strip()[:4000]
    if not excerpt:
        raise GatewayError(400, "invalid_request", "Nothing to report: include the reply text.")
    note = str(body.get("note") or "").strip()[:1000] or None
    async with gw.db.tx() as conn:
        result = await conn.execute(insert(reports).values(
            user_id=principal.user_id, reason=reason, excerpt=excerpt, note=note, created_at=gw.clock(),
        ))
    logger.warning("reply reported by %s: %s", principal.user_id, reason)
    return {"ok": True, "id": int(result.inserted_primary_key[0])}


@router.delete("/v1/me", status_code=204)
async def delete_account(request: Request) -> Response:
    gw = gateway(request)
    principal, _ = await admit(request, rate_limited=False)
    user_id = principal.user_id
    async with gw.db.tx() as conn:
        await conn.execute(delete(reservations).where(reservations.c.user_id == user_id))
        await conn.execute(delete(ledger).where(ledger.c.user_id == user_id))
        await conn.execute(delete(reports).where(reports.c.user_id == user_id))
        await conn.execute(update(usage).where(usage.c.user_id == user_id).values(user_id="deleted"))
        await conn.execute(delete(accounts).where(accounts.c.user_id == user_id))
    removed_login = False
    key, base = gw.settings.supabase_service_role_key, gw.settings.supabase_url.rstrip("/")
    if key and base:
        response = await gw.tokens._http.delete(  # noqa: SLF001 - the gateway's one Supabase client
            f"{base}/auth/v1/admin/users/{user_id}",
            headers={"apikey": key, "authorization": f"Bearer {key}"},
        )
        removed_login = response.status_code in (200, 204, 404)
        if not removed_login:
            logger.error("Supabase login delete for %s failed: %s", user_id, response.status_code)
    logger.warning("account deleted: %s (login removed: %s)", user_id, removed_login)
    return Response(status_code=204, headers={"X-Login-Removed": "1" if removed_login else "0"})
