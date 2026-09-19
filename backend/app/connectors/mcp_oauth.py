"""One-click sign-in for remote MCP servers (the MCP authorization spec).

Follows https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization:

1. Ask the server; a 401's ``WWW-Authenticate`` names its protected-resource
   metadata (RFC 9728). Fall back to the ``.well-known`` locations.
2. Read the authorization server's metadata (RFC 8414 / OpenID discovery).
3. Register JARVIS with it (RFC 7591 dynamic registration) -- no developer
   keys, no copy-pasting.
4. Browser sign-in: PKCE S256, ``state``, and the ``resource`` parameter
   (RFC 8707) on both the authorize and token requests; the redirect is this
   backend on 127.0.0.1.
5. Access tokens refresh automatically; a rotated refresh token is surfaced
   so the client can re-seal and sync it.

Everything returned to the client is a secret and is sealed there before it
leaves the device (frontend/src/lib/connectorCrypto.ts).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

logger = logging.getLogger("jarvis.connectors.mcp_oauth")

CLIENT_NAME = "JARVIS"


class OAuthError(RuntimeError):
    """Sign-in could not start or finish; the message is meant for the user."""


def canonical_resource(url: str) -> str:
    """RFC 8707 canonical form: lowercase scheme/host, no fragment, no trailing slash."""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/") if parts.path not in ("", "/") else ""
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{path}{query}"


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _path(url: str) -> str:
    path = urlsplit(url).path
    return "" if path in ("", "/") else path.rstrip("/")


def _challenge_params(header: str) -> dict[str, str]:
    return {k.lower(): v for k, v in re.findall(r'([A-Za-z_]+)="([^"]*)"', header or "")}


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any] | None:
    try:
        response = await client.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


@dataclass(slots=True)
class Discovery:
    resource: str
    authorization_endpoint: str
    token_endpoint: str
    registration_endpoint: str
    scope: str
    issuer: str


async def discover(server_url: str, client: httpx.AsyncClient) -> Discovery:
    """Find where to sign in for ``server_url``. Raises OAuthError if it needs none."""
    resource = canonical_resource(server_url)
    challenge: dict[str, str] = {}
    try:
        probe = await client.post(
            server_url,
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": "3"}}},
            headers={"Accept": "application/json, text/event-stream"},
        )
    except httpx.HTTPError as exc:
        raise OAuthError(f"Could not reach the server ({type(exc).__name__}).") from exc
    if probe.status_code == 401:
        challenge = _challenge_params(probe.headers.get("www-authenticate", ""))
    elif probe.status_code < 400:
        raise OAuthError("This server does not ask for sign-in; add it without connecting.")

    prm: dict[str, Any] | None = None
    candidates = [challenge["resource_metadata"]] if challenge.get("resource_metadata") else []
    candidates += [
        f"{_origin(server_url)}/.well-known/oauth-protected-resource{_path(server_url)}",
        f"{_origin(server_url)}/.well-known/oauth-protected-resource",
    ]
    for url in candidates:
        prm = await _get_json(client, url)
        if prm and prm.get("authorization_servers"):
            break
        prm = None
    # Servers written against the 2025-03-26 revision have no resource
    # metadata; there the MCP server's own origin is the authorization server.
    issuer = str((prm or {}).get("authorization_servers", [_origin(server_url)])[0]).rstrip("/")
    if prm and prm.get("resource"):
        resource = canonical_resource(str(prm["resource"]))

    issuer_path = _path(issuer)
    base = _origin(issuer)
    metadata_urls = (
        [f"{base}/.well-known/oauth-authorization-server{issuer_path}",
         f"{base}/.well-known/openid-configuration{issuer_path}",
         f"{issuer}/.well-known/openid-configuration"]
        if issuer_path else
        [f"{base}/.well-known/oauth-authorization-server",
         f"{base}/.well-known/openid-configuration"]
    )
    meta = None
    for url in metadata_urls:
        meta = await _get_json(client, url)
        if meta and meta.get("authorization_endpoint") and meta.get("token_endpoint"):
            break
        meta = None
    if meta is None:
        raise OAuthError("The server's sign-in details could not be found (no OAuth metadata).")
    if "S256" not in (meta.get("code_challenge_methods_supported") or ["S256"]):
        raise OAuthError("The server's sign-in does not support PKCE, which JARVIS requires.")

    scope = challenge.get("scope") or " ".join((prm or {}).get("scopes_supported") or [])
    return Discovery(
        resource=resource,
        authorization_endpoint=str(meta["authorization_endpoint"]),
        token_endpoint=str(meta["token_endpoint"]),
        registration_endpoint=str(meta.get("registration_endpoint") or ""),
        scope=scope,
        issuer=str(meta.get("issuer") or issuer),
    )


async def register(found: Discovery, redirect_uri: str, client: httpx.AsyncClient) -> tuple[str, str]:
    """(client_id, client_secret) via dynamic client registration."""
    if not found.registration_endpoint:
        raise OAuthError(
            "This server needs a developer-registered app (no automatic registration). "
            "Add it with an API key instead."
        )
    response = await client.post(found.registration_endpoint, json={
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        **({"scope": found.scope} if found.scope else {}),
    })
    if response.status_code >= 400:
        raise OAuthError(f"The server refused to register JARVIS ({response.status_code}).")
    body = response.json()
    if not body.get("client_id"):
        raise OAuthError("The server's registration returned no client id.")
    return str(body["client_id"]), str(body.get("client_secret") or "")


@dataclass(slots=True)
class _Pending:
    verifier: str
    redirect_uri: str
    token_endpoint: str
    client_id: str
    client_secret: str
    resource: str
    created: float = field(default_factory=time.monotonic)


_pending: dict[str, _Pending] = {}
_results: dict[str, dict[str, Any] | str] = {}


async def start(server_url: str, redirect_uri: str,
                transport: httpx.AsyncBaseTransport | None = None) -> tuple[str, str]:
    """(state, authorization URL) for ``server_url``."""
    async with httpx.AsyncClient(timeout=20.0, transport=transport, follow_redirects=True) as client:
        found = await discover(server_url, client)
        client_id, client_secret = await register(found, redirect_uri, client)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    for key in [k for k, v in _pending.items() if time.monotonic() - v.created > 900]:
        _pending.pop(key, None)
    _pending[state] = _Pending(verifier, redirect_uri, found.token_endpoint, client_id,
                               client_secret, found.resource)
    params = {
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
        "resource": found.resource,
    }
    if found.scope:
        params["scope"] = found.scope
    separator = "&" if "?" in found.authorization_endpoint else "?"
    return state, found.authorization_endpoint + separator + urlencode(params)


def _token_bundle(body: dict[str, Any], pending_or_prev: dict[str, Any]) -> dict[str, Any]:
    return {
        "client_id": pending_or_prev["client_id"],
        "client_secret": pending_or_prev.get("client_secret", ""),
        "token_endpoint": pending_or_prev["token_endpoint"],
        "resource": pending_or_prev["resource"],
        "access_token": body["access_token"],
        # Servers that do not rotate refresh tokens omit the field on refresh.
        "refresh_token": body.get("refresh_token") or pending_or_prev.get("refresh_token", ""),
        # Wall clock, not monotonic: the bundle syncs to other devices.
        "expires_at": time.time() + float(body.get("expires_in", 3600)),
    }


async def finish(state: str, code: str | None, error: str | None,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
    pending = _pending.pop(state, None)
    if pending is None:
        raise OAuthError("This sign-in link has expired. Start again from JARVIS settings.")
    if error or not code:
        _results[state] = f"Sign-in was not completed ({error or 'no code'})."
        return
    form = {
        "grant_type": "authorization_code", "code": code, "redirect_uri": pending.redirect_uri,
        "client_id": pending.client_id, "code_verifier": pending.verifier,
        "resource": pending.resource,
    }
    if pending.client_secret:
        form["client_secret"] = pending.client_secret
    async with httpx.AsyncClient(timeout=20.0, transport=transport) as client:
        response = await client.post(pending.token_endpoint, data=form,
                                     headers={"Accept": "application/json"})
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400 or not body.get("access_token"):
        _results[state] = f"The server refused the sign-in: {body.get('error_description') or body.get('error') or response.status_code}."
        return
    _results[state] = _token_bundle(body, {
        "client_id": pending.client_id, "client_secret": pending.client_secret,
        "token_endpoint": pending.token_endpoint, "resource": pending.resource,
    })


def collect(state: str) -> dict[str, Any] | str | None:
    """The token bundle, an error message, or None while waiting. Handed out once."""
    return _results.pop(state, None)


async def refresh(bundle: dict[str, Any], client: httpx.AsyncClient) -> dict[str, Any]:
    """A fresh bundle from ``bundle``'s refresh token. Raises OAuthError on failure."""
    if not bundle.get("refresh_token"):
        raise OAuthError("The sign-in expired and cannot renew itself. Connect the server again.")
    form = {
        "grant_type": "refresh_token", "refresh_token": bundle["refresh_token"],
        "client_id": bundle["client_id"], "resource": bundle["resource"],
    }
    if bundle.get("client_secret"):
        form["client_secret"] = bundle["client_secret"]
    try:
        response = await client.post(bundle["token_endpoint"], data=form,
                                     headers={"Accept": "application/json"})
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise OAuthError(f"Could not renew the sign-in ({type(exc).__name__}).") from exc
    if response.status_code >= 400 or not body.get("access_token"):
        raise OAuthError("The sign-in expired or was revoked. Connect the server again.")
    return _token_bundle(body, bundle)
