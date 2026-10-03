"""Per-process services and the checks every user request goes through.

``admit()`` is the front door for every user endpoint, in this order, cheapest
refusal first: bearer token -> account (created on first sight) -> per-plan
rate limit. Feature gates and the Aura reservation come after, in the
endpoint, once the body says what the request is.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from fastapi import Request

from app.accounts import Account, AuraBank, Clock
from app.auth import Principal, TokenVerifier
from app.config import Settings
from app.db import Database
from app.errors import GatewayError
from app.limits import RateLimiter
from app.metering import ModelCatalog, milli_to_aura
from app.plans import FEATURE_NAMES, FEATURES, PlanCatalog
from app.play import PlayVerifier


@dataclass
class Gateway:
    settings: Settings
    db: Database
    plans: PlanCatalog
    models: ModelCatalog
    bank: AuraBank
    limiter: RateLimiter
    tokens: TokenVerifier
    upstream: httpx.AsyncClient
    play: PlayVerifier
    clock: Clock


def gateway(request: Request) -> Gateway:
    return request.app.state.gw


async def authenticate(request: Request) -> Principal:
    gw = gateway(request)
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise GatewayError(
            401, "missing_token", "Sign in to continue: no access token was sent.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    principal = await gw.tokens.verify(token.strip())
    if principal.is_anonymous and not gw.settings.allow_anonymous_users:
        raise GatewayError(
            403, "anonymous_not_allowed", "Sign in with Google or your phone number to use this.",
        )
    return principal


async def admit(request: Request, *, rate_limited: bool = True) -> tuple[Principal, Account]:
    gw = gateway(request)
    principal = await authenticate(request)
    acct = await gw.bank.account(principal.user_id, email=principal.email)
    if rate_limited:
        plan = gw.plans.get(acct.plan)
        wait = gw.limiter.hit(principal.user_id, plan.rpm)
        if wait is not None:
            seconds = max(math.ceil(wait), 1)
            raise GatewayError(
                429, "rate_limited",
                f"Too many requests. Try again in {seconds} s.",
                headers={"Retry-After": str(seconds)},
                retry_after=seconds, requests_per_minute=plan.rpm,
            )
    return principal, acct


def features_for(gw: Gateway, acct: Account, now: datetime) -> set[str]:
    features = set(gw.plans.get(acct.plan).features)
    if acct.lockin_trial_active(now):
        features.add("lockin")
    return features


def require_feature(gw: Gateway, acct: Account, feature: str) -> None:
    if feature in features_for(gw, acct, gw.clock()):
        return
    plan = gw.plans.lowest_with(feature)
    raise GatewayError(
        403, "feature_locked", f"{FEATURE_NAMES.get(feature, feature)} unlocks on {plan.name}.",
        feature=feature, required_plan=plan.id, plan=acct.plan,
    )


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


async def account_view(gw: Gateway, acct: Account) -> dict[str, Any]:
    """The ``GET /v1/me`` body (also returned by trial and admin calls)."""
    now = gw.clock()
    plan = gw.plans.get(acct.plan)
    features = features_for(gw, acct, now)
    spent = await gw.bank.spent_today(acct.user_id)
    return {
        "user_id": acct.user_id,
        "app": gw.settings.app_name,
        "plan": {
            "id": plan.id,
            "name": plan.name,
            "price_inr": plan.price_inr,
            "monthly_aura": plan.monthly_aura,
            "source": acct.plan_source,
            "expires_at": _iso(acct.plan_expires_at),
        },
        "aura": {
            # balance = plan + topup - held (Aura already promised to calls in
            # flight). The *_milli integers are exact; the floats are for show.
            "balance": milli_to_aura(max(acct.balance_milli, 0)),
            "plan": milli_to_aura(acct.plan_milli),
            "topup": milli_to_aura(acct.topup_milli),
            "held": milli_to_aura(acct.held_milli),
            "balance_milli": acct.balance_milli,
            "plan_milli": acct.plan_milli,
            "topup_milli": acct.topup_milli,
            "held_milli": acct.held_milli,
        },
        "features": {name: name in features for name in FEATURES},
        "period": {"start": _iso(acct.period_start), "end": _iso(acct.period_end)},
        "trial": {
            "lockin": {
                "available": acct.trial_lockin_started_at is None,
                "active": acct.lockin_trial_active(now),
                "started_at": _iso(acct.trial_lockin_started_at),
                "ends_at": _iso(acct.trial_lockin_ends_at),
            },
        },
        "limits": {
            "requests_per_minute": plan.rpm,
            "daily_cap_aura": plan.daily_cap_aura,
            "spent_today_aura": milli_to_aura(spent),
        },
    }
