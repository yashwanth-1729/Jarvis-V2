"""Google Play purchase verification, behind an interface.

A real-time developer notification only says "something happened to purchase
token X". It does not carry the user, and it is not proof of payment. The
gateway therefore asks Google about the token -- ``purchases.subscriptionsv2.get``
for a subscription, ``purchases.products.get`` for a top-up -- and acts only on
that answer. The user is linked through ``obfuscatedExternalAccountId``: the
app must set ``BillingFlowParams.setObfuscatedAccountId(<Supabase user id>)``
when it launches a purchase.

TODO(play): ``GooglePlayVerifier`` -- the real implementation:
  * service-account credentials with the ``androidpublisher`` scope, the
    service account invited in Play Console with financial-data access;
  * ``GET https://androidpublisher.googleapis.com/androidpublisher/v3/
    applications/{package}/purchases/subscriptionsv2/tokens/{token}``, mapping
    ``subscriptionState`` (SUBSCRIPTION_STATE_ACTIVE -> "active",
    _IN_GRACE_PERIOD -> "grace", _ON_HOLD, _PAUSED, _CANCELED, _EXPIRED,
    _PENDING) and ``lineItems[0].{productId, expiryTime}`` and
    ``externalAccountIdentifiers.obfuscatedExternalAccountId``;
  * ``.../purchases/products/{productId}/tokens/{token}`` for top-ups
    (``purchaseState == 0`` is purchased), then ``:acknowledge`` both kinds --
    Play refunds unacknowledged purchases after three days -- and ``:consume``
    the top-up so it can be bought again;
  * 404/410 from Google -> ``PurchaseNotFound``; network errors ->
    ``PlayVerificationUnavailable`` so Pub/Sub redelivers.
Until it exists the gateway runs ``UnconfiguredPlayVerifier``, which answers
503 so Pub/Sub keeps the notifications and retries them later. Tests use
``FakePlayVerifier``. No code here calls Google.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

#: Normalized subscription states (from Google's ``subscriptionState``).
SUBSCRIPTION_STATES = (
    "active", "grace", "on_hold", "paused", "canceled", "expired", "pending", "unknown",
)


@dataclass(frozen=True)
class VerifiedSubscription:
    product_id: str
    #: ``obfuscatedExternalAccountId``: the Supabase user id the app set.
    account_id: str | None
    state: str
    expires_at: datetime | None


@dataclass(frozen=True)
class VerifiedProduct:
    product_id: str
    account_id: str | None
    purchased: bool
    quantity: int = 1


class PlayVerificationUnavailable(Exception):
    """Google could not be asked right now; the notification should be retried."""


class PurchaseNotFound(Exception):
    """Google does not know this token (forged, or for another app)."""


class PlayVerifier(Protocol):
    async def verify_subscription(
        self, package_name: str, purchase_token: str,
    ) -> VerifiedSubscription: ...

    async def verify_product(
        self, package_name: str, product_id: str, purchase_token: str,
    ) -> VerifiedProduct: ...


class UnconfiguredPlayVerifier:
    async def verify_subscription(self, package_name: str, purchase_token: str) -> VerifiedSubscription:
        raise PlayVerificationUnavailable("Play verification is not configured on this gateway.")

    async def verify_product(
        self, package_name: str, product_id: str, purchase_token: str,
    ) -> VerifiedProduct:
        raise PlayVerificationUnavailable("Play verification is not configured on this gateway.")


@dataclass
class FakePlayVerifier:
    """Answers from dicts keyed by purchase token. For tests only."""

    subscriptions: dict[str, VerifiedSubscription] = field(default_factory=dict)
    products: dict[str, VerifiedProduct] = field(default_factory=dict)
    unavailable: bool = False

    async def verify_subscription(self, package_name: str, purchase_token: str) -> VerifiedSubscription:
        if self.unavailable:
            raise PlayVerificationUnavailable("fake outage")
        try:
            return self.subscriptions[purchase_token]
        except KeyError:
            raise PurchaseNotFound(purchase_token) from None

    async def verify_product(
        self, package_name: str, product_id: str, purchase_token: str,
    ) -> VerifiedProduct:
        if self.unavailable:
            raise PlayVerificationUnavailable("fake outage")
        try:
            return self.products[purchase_token]
        except KeyError:
            raise PurchaseNotFound(purchase_token) from None
