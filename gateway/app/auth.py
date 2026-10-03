"""Verifying the Supabase access token the app sends as its bearer token.

Two key types, chosen by the token's own ``alg`` header:

* **HS256** -- the project's legacy shared secret (``SUPABASE_JWT_SECRET``),
  used as raw UTF-8 bytes the way Supabase signs with it.
* **RS256 / ES256 / EdDSA** -- the project's asymmetric signing keys, published
  at ``SUPABASE_URL/auth/v1/.well-known/jwks.json``. Fetched with the async
  client (PyJWT's own ``PyJWKClient`` does blocking urllib I/O on the event
  loop), cached for ``SUPABASE_JWKS_CACHE_SECONDS``, and refetched early when a
  token names a key id the cache has not seen -- that is what a key rotation
  looks like from here -- at most once per ``_UNKNOWN_KID_REFETCH`` so a stream
  of bogus kids cannot turn into a stream of fetches.

``alg: none`` and any algorithm not listed above are refused before any key is
looked up. Checked claims: signature, ``exp`` (with a small leeway for clock
skew), ``aud`` (default ``authenticated``), ``sub``, and ``iss`` when
``SUPABASE_URL`` is set.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt

from app.config import Settings
from app.errors import GatewayError

logger = logging.getLogger("holo.gateway.auth")

_ASYMMETRIC = ("RS256", "ES256", "EdDSA")
_UNKNOWN_KID_REFETCH = 30.0


@dataclass(frozen=True)
class Principal:
    user_id: str
    email: str | None
    is_anonymous: bool


def _unauthorized(code: str, message: str) -> GatewayError:
    return GatewayError(401, code, message, headers={"WWW-Authenticate": "Bearer"})


class TokenVerifier:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self.settings = settings
        self._http = http
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()
        base = settings.supabase_url.rstrip("/")
        self._jwks_url = f"{base}/auth/v1/.well-known/jwks.json" if base else ""
        self._issuer = f"{base}/auth/v1" if base else None

    async def verify(self, token: str) -> Principal:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise _unauthorized("invalid_token", "That sign-in token is malformed. Sign in again.")
        alg = header.get("alg")
        if alg == "HS256":
            if not self.settings.supabase_jwt_secret:
                raise _unauthorized("invalid_token", "HS256 tokens are not accepted here.")
            key: Any = self.settings.supabase_jwt_secret
        elif alg in _ASYMMETRIC:
            key = await self._public_key(header.get("kid"), alg)
        else:
            raise _unauthorized("invalid_token", f"Unsupported token algorithm {alg!r}.")

        try:
            claims = jwt.decode(
                token, key, algorithms=[alg],
                audience=self.settings.supabase_jwt_audience,
                issuer=self._issuer,
                leeway=self.settings.jwt_leeway_seconds,
                options={"require": ["exp", "sub", "aud"]},
            )
        except jwt.ExpiredSignatureError:
            raise _unauthorized("token_expired", "Your session expired. Sign in again.")
        except jwt.InvalidAudienceError:
            raise _unauthorized("invalid_token", "That token was not issued for this app.")
        except jwt.PyJWTError as exc:
            raise _unauthorized("invalid_token", f"That sign-in token is not valid ({exc}).")

        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub.strip() or len(sub) > 64:
            raise _unauthorized("invalid_token", "That token names no user.")
        email = claims.get("email") if isinstance(claims.get("email"), str) else None
        return Principal(
            user_id=sub, email=email or None, is_anonymous=bool(claims.get("is_anonymous")),
        )

    async def _public_key(self, kid: Any, alg: str) -> Any:
        if not self._jwks_url:
            raise _unauthorized("invalid_token", "Asymmetric tokens are not accepted here.")
        if not isinstance(kid, str):
            raise _unauthorized("invalid_token", "The token names no signing key.")
        now = time.monotonic()
        expired = now - self._fetched_at > self.settings.supabase_jwks_cache_seconds
        unknown = kid not in self._keys and now - self._fetched_at > _UNKNOWN_KID_REFETCH
        if expired or unknown:
            await self._refresh()
        jwk = self._keys.get(kid)
        if jwk is None:
            raise _unauthorized("invalid_token", "The token's signing key is unknown.")
        if jwk.algorithm_name != alg:
            raise _unauthorized("invalid_token", "The token's algorithm does not match its key.")
        return jwk.key

    async def _refresh(self) -> None:
        async with self._lock:
            if time.monotonic() - self._fetched_at < 1.0:
                return  # another request refreshed while this one waited
            try:
                response = await self._http.get(self._jwks_url, timeout=10.0)
                response.raise_for_status()
                keys: dict[str, jwt.PyJWK] = {}
                for raw in response.json().get("keys", []):
                    try:
                        jwk = jwt.PyJWK(raw)
                    except jwt.PyJWTError:
                        continue  # a key type this PyJWT build cannot use
                    if jwk.key_id:
                        keys[jwk.key_id] = jwk
            except (httpx.HTTPError, ValueError) as exc:
                # Keep serving the last good keys; a JWKS blip must not sign
                # every user out.
                logger.warning("JWKS refresh failed (%s: %s)", type(exc).__name__, exc)
                self._fetched_at = time.monotonic()
                return
            self._keys = keys
            self._fetched_at = time.monotonic()
