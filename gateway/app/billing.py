"""``POST /v1/billing/play``: Google Play real-time developer notifications.

Play publishes each notification to a Pub/Sub topic, and a push subscription
POSTs it here::

    {"message": {"data": "<base64 DeveloperNotification JSON>",
                 "messageId": "...", "publishTime": "..."},
     "subscription": "projects/<p>/subscriptions/<s>"}

Pub/Sub treats any 2xx as "delivered" and redelivers everything else with
backoff. So: 2xx once a notification is handled *or* can never be handled
(unknown product, purchase not found -- retrying cannot fix those, and they
are logged in ``play_events``); 503 only when verification is unavailable,
so the notification comes back later; 400 for an envelope that is not a
Pub/Sub message at all.

Auth is a shared token (``PLAY_PUSH_TOKEN``) on the push URL,
``https://<gateway>/v1/billing/play?token=<secret>``, or the
``X-Play-Push-Token`` header. TODO(play): verify the Pub/Sub OIDC JWT instead
(push subscription "Enable authentication"; check the Google-signed token's
``aud`` and service-account ``email`` against Google's certs), which avoids a
secret in the URL.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError

from app.context import Gateway, gateway
from app.db import play_events
from app.errors import GatewayError
from app.limits import read_json
from app.plans import FREE_PLAN
from app.play import PlayVerificationUnavailable, PurchaseNotFound

logger = logging.getLogger("holo.gateway.billing")

router = APIRouter()

#: ``subscriptionNotification.notificationType``.
SUBSCRIPTION_TYPES: dict[int, str] = {
    1: "RECOVERED", 2: "RENEWED", 3: "CANCELED", 4: "PURCHASED", 5: "ON_HOLD",
    6: "IN_GRACE_PERIOD", 7: "RESTARTED", 8: "PRICE_CHANGE_CONFIRMED", 9: "DEFERRED",
    10: "PAUSED", 11: "PAUSE_SCHEDULE_CHANGED", 12: "REVOKED", 13: "EXPIRED",
    17: "ITEMS_CHANGED", 18: "CANCELLATION_SCHEDULED", 19: "PRICE_CHANGE_UPDATED",
    20: "PENDING_PURCHASE_CANCELED", 22: "PRICE_STEP_UP_CONSENT_UPDATED",
}
#: Types that mean "a paid period starts now": fresh plan bucket.
_NEW_PERIOD = {1, 2, 4, 7}
#: ``oneTimeProductNotification.notificationType``.
_ONE_TIME_PURCHASED = 1


def _authorize_push(request: Request, expected: str) -> None:
    if not expected:
        raise GatewayError(503, "play_push_disabled", "Play notifications are not enabled.")
    given = request.query_params.get("token") or request.headers.get("x-play-push-token") or ""
    if not hmac.compare_digest(given.encode(), expected.encode()):
        raise GatewayError(401, "unauthorized", "Bad or missing push token.")


def _decode(envelope: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    message = envelope.get("message")
    if not isinstance(message, dict):
        raise GatewayError(400, "malformed_notification", "No Pub/Sub message.")
    message_id = str(message.get("messageId") or message.get("message_id") or "")
    if not message_id:
        raise GatewayError(400, "malformed_notification", "The message has no messageId.")
    try:
        notification = json.loads(base64.b64decode(str(message.get("data", "")), validate=True))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise GatewayError(400, "malformed_notification", "message.data is not base64 JSON.")
    if not isinstance(notification, dict):
        raise GatewayError(400, "malformed_notification", "message.data is not a JSON object.")
    return message_id, notification


@router.post("/v1/billing/play")
async def play_notification(request: Request) -> dict[str, Any]:
    gw = gateway(request)
    _authorize_push(request, gw.settings.play_push_token)
    message_id, notification = _decode(await read_json(request, gw.settings.max_body_bytes))

    async with gw.db.read() as conn:
        seen = (await conn.execute(
            select(play_events.c.outcome).where(play_events.c.message_id == message_id)
        )).first()
    if seen is not None:
        return {"ok": True, "outcome": "duplicate"}

    package = str(notification.get("packageName") or "")
    event: dict[str, Any] = {"kind": "other", "outcome": "ignored"}
    try:
        if gw.settings.play_package_name and package != gw.settings.play_package_name:
            event["outcome"] = "wrong_package"
        elif isinstance(notification.get("subscriptionNotification"), dict):
            event = await _subscription(gw, package, notification["subscriptionNotification"])
        elif isinstance(notification.get("oneTimeProductNotification"), dict):
            event = await _one_time(gw, package, notification["oneTimeProductNotification"])
        elif isinstance(notification.get("voidedPurchaseNotification"), dict):
            # TODO(play): claw back a refunded/charged-back purchase -- drop
            # the plan for a subscription token, debit (adjust) a top-up.
            voided = notification["voidedPurchaseNotification"]
            event = {"kind": "voided", "outcome": "voided_logged",
                     "purchase_token": voided.get("purchaseToken")}
        elif "testNotification" in notification:
            event = {"kind": "test", "outcome": "test"}
    except PlayVerificationUnavailable as exc:
        logger.warning("Play notification %s deferred: %s", message_id, exc)
        raise GatewayError(503, "play_verification_unavailable", str(exc))

    logger.info(
        "Play notification %s: %s %s -> %s", message_id, event.get("kind"),
        event.get("notification_type"), event["outcome"],
    )
    try:
        async with gw.db.tx() as conn:
            await conn.execute(insert(play_events).values(
                message_id=message_id, package_name=package or None,
                kind=event.get("kind", "other"),
                notification_type=event.get("notification_type"),
                product_id=event.get("product_id"),
                purchase_token=event.get("purchase_token"),
                user_id=event.get("user_id"), outcome=event["outcome"],
                received_at=gw.clock(),
            ))
    except IntegrityError:
        pass  # a concurrent redelivery recorded it first; the handling is idempotent
    return {"ok": True, "outcome": event["outcome"]}


async def _subscription(gw: Gateway, package: str, sn: dict[str, Any]) -> dict[str, Any]:
    token = str(sn.get("purchaseToken") or "")
    ntype = int(sn.get("notificationType") or 0)
    type_name = SUBSCRIPTION_TYPES.get(ntype, str(ntype))
    event: dict[str, Any] = {
        "kind": "subscription", "notification_type": ntype, "purchase_token": token or None,
        "product_id": sn.get("subscriptionId"),
    }
    if not token:
        return {**event, "outcome": "malformed"}
    try:
        verified = await gw.play.verify_subscription(package, token)
    except PurchaseNotFound:
        return {**event, "outcome": "purchase_not_found"}
    product = verified.product_id or str(sn.get("subscriptionId") or "")
    event["product_id"] = product
    plan = gw.settings.play_product_plans.get(product)
    if plan is None or not gw.plans.exists(plan):
        return {**event, "outcome": "unknown_product"}
    user_id = verified.account_id
    if not user_id:
        # The app launched the purchase without setObfuscatedAccountId.
        return {**event, "outcome": "unlinked_purchase"}
    event["user_id"] = user_id
    acct = await gw.bank.account(user_id)
    current = acct.play_purchase_token == token

    if verified.state in ("active", "grace"):
        if ntype in _NEW_PERIOD or acct.plan != plan or not current:
            await gw.bank.set_plan(
                user_id, plan, source="play", expires_at=verified.expires_at,
                purchase_token=token, ref=token, note=f"Play {type_name}: {plan}",
            )
            return {**event, "outcome": "plan_set"}
        await gw.bank.extend_plan(user_id, verified.expires_at)
        return {**event, "outcome": "expiry_updated"}
    if verified.state == "canceled":
        # Cancelled but paid up: access continues until expiry, then the
        # lazy expiry check drops the account to Spawn.
        if current:
            await gw.bank.extend_plan(user_id, verified.expires_at)
            return {**event, "outcome": "cancel_scheduled"}
        return {**event, "outcome": "ignored"}
    if verified.state in ("expired", "on_hold", "paused"):
        # Only the purchase that set the current plan can end it: after a
        # plan switch the old token's EXPIRED must not downgrade anyone.
        if current and acct.plan != FREE_PLAN:
            await gw.bank.set_plan(
                user_id, FREE_PLAN, source="default", ref=token,
                note=f"Play {type_name}: back to Spawn",
            )
            return {**event, "outcome": "downgraded"}
        return {**event, "outcome": "ignored"}
    return {**event, "outcome": verified.state}


async def _one_time(gw: Gateway, package: str, on: dict[str, Any]) -> dict[str, Any]:
    token = str(on.get("purchaseToken") or "")
    sku = str(on.get("sku") or "")
    ntype = int(on.get("notificationType") or 0)
    event: dict[str, Any] = {
        "kind": "one_time", "notification_type": ntype, "purchase_token": token or None,
        "product_id": sku or None,
    }
    if ntype != _ONE_TIME_PURCHASED:
        return {**event, "outcome": "ignored"}
    aura = gw.settings.play_topup_products.get(sku)
    if aura is None:
        return {**event, "outcome": "unknown_product"}
    if not token:
        return {**event, "outcome": "malformed"}
    try:
        verified = await gw.play.verify_product(package, sku, token)
    except PurchaseNotFound:
        return {**event, "outcome": "purchase_not_found"}
    if not verified.purchased:
        return {**event, "outcome": "not_purchased"}
    if not verified.account_id:
        return {**event, "outcome": "unlinked_purchase"}
    event["user_id"] = verified.account_id
    credited = await gw.bank.credit_purchase_once(
        verified.account_id, token, sku, aura * max(verified.quantity, 1),
    )
    return {**event, "outcome": "topup" if credited else "duplicate_purchase"}
