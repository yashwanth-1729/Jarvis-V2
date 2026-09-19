"""Connector endpoints: configure, Google sign-in, MCP server test.

Every route here carries or returns secrets, so each one refuses any caller
that is not on this device's loopback interface -- a desktop backend can be
reachable on the LAN (see main.py's CORS note), and a token must never be
handed to another machine that merely found the port.
"""

from __future__ import annotations

import html
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse

from app.connectors import google as g
from app.connectors import registry
from app.core.config import settings

router = APIRouter(prefix="/api/connectors", tags=["connectors"])

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _local_only(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Connector endpoints are local to this device.")


@router.post("/configure", summary="Hand the runtime its connectors (definitions + secrets)")
async def configure(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Replace every live connector with the client's set. Secrets stay in
    memory for this process only and are never logged or written to disk."""
    _local_only(request)
    return await registry.configure(payload)


@router.get("/status", summary="What is connected and which tools it offers")
async def connector_status(request: Request) -> dict[str, Any]:
    _local_only(request)
    return registry.status()


@router.post("/google/start", summary="Begin Google sign-in (returns the consent URL)")
async def google_start(payload: dict[str, Any], request: Request) -> dict[str, str]:
    _local_only(request)
    port = request.url.port or 8000
    # Google's "Desktop app" clients accept any loopback port; 127.0.0.1 (not
    # "localhost") is what Google's own installed-app guide recommends.
    redirect_uri = f"http://127.0.0.1:{port}/api/connectors/google/callback"
    try:
        state, url = g.start_sign_in(
            str(payload.get("client_id") or ""), str(payload.get("client_secret") or ""),
            redirect_uri, list(payload.get("services") or g.SCOPES),
        )
    except g.GoogleError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    opened = False
    if not settings.jarvis_android:
        # The desktop webview cannot be trusted to hand a URL to the real
        # browser, and Google refuses sign-in inside embedded webviews anyway,
        # so the backend -- a normal process on this machine -- opens it.
        import webbrowser

        opened = webbrowser.open(url)
    return {"state": state, "auth_url": url, "opened": opened}


_PAGE = """<!doctype html><meta charset="utf-8"><title>JARVIS</title>
<style>body{{font:16px system-ui;background:#0f1115;color:#e8e8e8;display:grid;place-items:center;height:100vh;margin:0}}
div{{max-width:28rem;text-align:center}}h1{{font-size:1.3rem}}</style>
<div><h1>{title}</h1><p>{body}</p></div>"""


@router.get("/google/callback", response_class=HTMLResponse, include_in_schema=False)
async def google_callback(request: Request, state: str = "", code: str | None = None,
                          error: str | None = None) -> HTMLResponse:
    """Google redirects the browser here after consent."""
    _local_only(request)
    try:
        await g.finish_sign_in(state, code, error)
    except g.GoogleError as exc:
        return HTMLResponse(_PAGE.format(title="Sign-in expired", body=html.escape(str(exc))), status_code=400)
    return HTMLResponse(_PAGE.format(
        title="Google connected",
        body="You can close this tab and go back to JARVIS.",
    ))


@router.get("/google/result", summary="Collect the outcome of a sign-in (once)")
async def google_result(state: str, request: Request) -> dict[str, Any]:
    _local_only(request)
    outcome = g.collect_sign_in(state)
    if outcome is None:
        return {"status": "pending"}
    if isinstance(outcome, str):
        return {"status": "error", "error": outcome}
    return {"status": "done", "refresh_token": outcome.refresh_token,
            "email": outcome.email, "services": outcome.services}


@router.post("/mcp/test", summary="Connect to one MCP server and list its tools")
async def mcp_test(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    _local_only(request)
    return await registry.probe_server(payload)
