"""App factory. Run with::

    uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8080

One process: the rate limiter is in memory (see limits.py). The factory takes
injectable transports, a Play verifier and a clock so the tests run the real
app offline -- no OpenRouter, Google or Supabase call is possible from them.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import account_routes, billing, compliance, planner, proxy
from app.accounts import AuraBank, Clock
from app.auth import TokenVerifier
from app.config import Settings
from app.context import Gateway
from app.db import Database, utcnow
from app.errors import GatewayError, error_response
from app.limits import RateLimiter
from app.metering import ModelCatalog
from app.plans import PlanCatalog
from app.play import PlayVerifier, UnconfiguredPlayVerifier

logger = logging.getLogger("holo.gateway")


def create_app(
    settings: Settings | None = None,
    *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    auth_transport: httpx.AsyncBaseTransport | None = None,
    play_verifier: PlayVerifier | None = None,
    clock: Clock | None = None,
) -> FastAPI:
    settings = settings or Settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not settings.supabase_jwt_secret and not settings.supabase_url:
        raise ValueError("Set SUPABASE_JWT_SECRET and/or SUPABASE_URL: no way to verify users.")
    # Validated now, not on the first request: a bad price table or plan
    # override should stop the deploy, not 500 every call.
    plans = PlanCatalog(settings.plan_overrides)
    models = ModelCatalog(settings)
    unknown = sorted(p for p in settings.play_product_plans.values() if not plans.exists(p))
    if unknown:
        raise ValueError(f"PLAY_PRODUCT_PLANS maps to unknown plans: {unknown}")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.database_url)
        await db.init()
        upstream = httpx.AsyncClient(
            base_url=settings.openrouter_base_url,
            timeout=httpx.Timeout(
                settings.openrouter_chat_timeout, connect=settings.openrouter_connect_timeout,
            ),
            # Long keep-alive for the same reason as the backend's pool: a
            # fresh TLS handshake per turn is the slowest part of a voice reply.
            limits=httpx.Limits(
                max_connections=200, max_keepalive_connections=50, keepalive_expiry=60.0,
            ),
            transport=upstream_transport,
        )
        auth_http = httpx.AsyncClient(timeout=10.0, transport=auth_transport)
        bank = AuraBank(db, settings, plans, clock or utcnow)
        app.state.gw = Gateway(
            settings=settings, db=db, plans=plans, models=models, bank=bank,
            limiter=RateLimiter(), tokens=TokenVerifier(settings, auth_http),
            upstream=upstream, play=play_verifier or UnconfiguredPlayVerifier(),
            clock=clock or utcnow,
        )
        swept = await bank.sweep_stale()
        if swept:
            logger.warning("charged stale holds for %d account(s) at startup", swept)
        if not settings.openrouter_api_key:
            logger.warning("OPENROUTER_API_KEY is not set: AI endpoints will answer 503")
        logger.info(
            "%s gateway up: models %s", settings.app_name,
            {k: models.allowed(k) for k in ("chat", "stt", "tts")},
        )
        try:
            yield
        finally:
            await upstream.aclose()
            await auth_http.aclose()
            await db.close()

    app = FastAPI(
        title=f"{settings.app_name} gateway",
        lifespan=lifespan,
        docs_url="/docs" if settings.enable_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list(),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Holo-Language", "X-Holo-Feature"],
        allow_credentials=False,
        max_age=600,
    )

    @app.exception_handler(GatewayError)
    async def _gateway_error(_: Request, exc: GatewayError) -> JSONResponse:
        return exc.response()

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return error_response(exc.status_code, code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(400, "invalid_request", "The request is not valid.")

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error")
        return error_response(500, "internal_error", "Something went wrong on our side.")

    app.include_router(proxy.router)
    app.include_router(account_routes.router)
    app.include_router(billing.router)
    app.include_router(compliance.router)
    app.include_router(planner.router)
    return app
