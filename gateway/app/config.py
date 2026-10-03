"""Gateway configuration: every knob comes from the environment or ``gateway/.env``.

Secrets (``OPENROUTER_API_KEY``, ``SUPABASE_JWT_SECRET``, ``ADMIN_TOKEN``,
``PLAY_PUSH_TOKEN``) only ever live here, on the server. Nothing in this file
is sent to the phone.

Structured values (the price table, plan overrides, Play product maps) are JSON
in the environment, merged over the defaults below, so one model's price can be
changed without restating the whole table::

    MODEL_PRICES='{"openai/gpt-6-luna": {"completion": 0.0000006}}'
    PLAN_OVERRIDES='{"spawn": {"rpm": 20, "daily_cap_aura": 15}}'
"""

from __future__ import annotations

from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Provider prices in USD per unit, the basis of every Aura charge.
#:
#: * Chat: per token. GPT-6 Luna's OpenRouter list price, $0.10 in / $0.50 out
#:   / $0.01 cached input per 1M tokens: the rate the 186 measured phone turns
#:   in docs/public-edition.md were priced at.
#: * STT: per second of audio. Grok STT measured a median $0.0000277 per
#:   1.5-4 s utterance (2026-10-03), i.e. at most ~$0.0000185/s, and the backend
#:   config records it as ~$0.10/hour. $0.00003/s ($0.108/hour) sits above both
#:   on purpose. gpt-transcribe (the fallback) is priced at the gpt-4o-transcribe
#:   list rate, $0.006/min, until measured. ``min_seconds`` bills a short clip as
#:   at least that long, since providers round tiny clips up.
#: * TTS: per input character, measured from the phone's real calls through
#:   OpenRouter's generation endpoint: Kokoro ~$2.4/1M (median call $0.000025),
#:   Grok voice ~$57/1M input units treated as characters (median call
#:   $0.000375). Grok voice speaks Telugu and Hindi.
#:
#: When OpenRouter reports its own ``usage.cost`` the gateway charges whichever
#: is higher (``CHARGE_UPSTREAM_COST_IF_HIGHER``), so a stale price here or a
#: paid plugin can never make a call cost more than it is billed.
DEFAULT_MODEL_PRICES: dict[str, dict[str, Any]] = {
    "openai/gpt-6-luna": {
        "kind": "chat",
        "prompt": 0.10e-6,
        "cached_prompt": 0.01e-6,
        "completion": 0.50e-6,
    },
    "x-ai/grok-stt-1.0": {"kind": "stt", "per_second": 0.00003, "min_seconds": 1.0},
    "openai/gpt-transcribe": {"kind": "stt", "per_second": 0.0001, "min_seconds": 1.0},
    "hexgrad/kokoro-82m": {"kind": "tts", "per_char": 2.4e-6},
    "x-ai/grok-voice-tts-1.0": {"kind": "tts", "per_char": 57e-6},
}

#: Google Play subscription product ids -> plan. The app's Play Console
#: products must use these ids (or override with PLAY_PRODUCT_PLANS).
DEFAULT_PLAY_PRODUCT_PLANS: dict[str, str] = {
    "holo_side_quest": "side_quest",
    "holo_main_character": "main_character",
    "holo_final_boss": "final_boss",
    "holo_god_mode": "god_mode",
}

#: One-time (consumable) Play products -> Aura added to the top-up bucket.
#: The plan's top-up is Rs 49 for 150 Aura.
DEFAULT_PLAY_TOPUP_PRODUCTS: dict[str, int] = {"holo_aura_150": 150}

DEFAULT_CORS_ORIGINS = "http://tauri.localhost,tauri://localhost,https://tauri.localhost"


class Settings(BaseSettings):
    """Field names map to upper-case env vars (``openrouter_api_key`` <-
    ``OPENROUTER_API_KEY``)."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore",
    )

    #: The working title, kept in one value (docs/public-edition.md).
    app_name: str = "HOLO"
    log_level: str = "INFO"
    #: Serve /docs and /openapi.json. Off by default on a public host.
    enable_docs: bool = False

    # --- Upstream (OpenRouter) ------------------------------------------------
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    #: Sent as OpenRouter's attribution headers (HTTP-Referer / X-Title).
    openrouter_referer: str = "https://github.com/yashwanth-1729/Jarvis-V2"
    openrouter_connect_timeout: float = 5.0
    #: Read timeout between bytes. For a stream that is the longest silence
    #: between two chunks, not the whole answer.
    openrouter_chat_timeout: float = 120.0
    openrouter_audio_timeout: float = 60.0

    # --- Storage ----------------------------------------------------------------
    #: ``sqlite+aiosqlite:///./gateway.db`` for dev; production is Postgres,
    #: e.g. ``postgresql+asyncpg://holo:pw@db:5432/holo`` (``postgres://`` and
    #: ``postgresql://`` are accepted and switched to asyncpg).
    database_url: str = "sqlite+aiosqlite:///./gateway.db"

    # --- Auth (Supabase) --------------------------------------------------------
    #: Enables asymmetric keys via ``<url>/auth/v1/.well-known/jwks.json`` and the
    #: issuer check. Either this or the secret (or both) must be set.
    supabase_url: str = ""
    #: The project's legacy HS256 JWT secret.
    supabase_jwt_secret: str = ""
    supabase_jwt_audience: str = "authenticated"
    supabase_jwks_cache_seconds: int = 600
    #: Clock skew allowed on ``exp``.
    jwt_leeway_seconds: int = 30
    #: Supabase anonymous sign-ins carry ``is_anonymous: true``. Refused by
    #: default: a throwaway session per request would farm the free plan.
    allow_anonymous_users: bool = False

    # --- Aura ---------------------------------------------------------------------
    #: 1 Aura = Rs 0.10 of provider cost.
    aura_inr: float = 0.10
    usd_inr: float = 88.0
    #: Comma-separated allow-list. Empty = every model in the price table.
    allowed_models: str = ""
    #: JSON object merged over DEFAULT_MODEL_PRICES, per model.
    model_prices: dict[str, dict[str, Any]] = Field(default_factory=dict)
    #: JSON object merged over the plan table in plans.py, per plan.
    plan_overrides: dict[str, dict[str, Any]] = Field(default_factory=dict)
    #: Minimum balance a request needs before it is forwarded, in Aura. Audio
    #: reserves the larger of this and its up-front estimate. A chat stream
    #: that dies with no usage is charged this amount.
    reserve_aura_chat: float = 1.0
    reserve_aura_stt: float = 0.1
    reserve_aura_tts: float = 0.1
    #: A hold older than this belongs to a request that never settled (the
    #: process died mid-call). It is charged at its reserve and released.
    reservation_ttl_seconds: int = 900
    #: The most Aura ALL free (Spawn) users together may spend in one day
    #: (same IST day as the daily caps). The wallet guarantee for the free
    #: plan: free usage can never cost more than this x Rs 0.10 a day, however
    #: many people sign up. When it runs out, free AI waits for midnight (paid
    #: plans are unaffected). 0 turns the pool off.
    free_pool_daily_aura: int = 500
    charge_upstream_cost_if_higher: bool = True

    # --- Abuse limits -------------------------------------------------------------
    max_body_bytes: int = 8 * 1024 * 1024
    #: Ceiling on ``max_tokens`` / ``max_completion_tokens``; also set when the
    #: client sends neither.
    max_output_tokens: int = 4096
    #: OpenRouter's paid web plugin (~10x a normal turn; the backend has kept it
    #: off since 2026-09-19). When false, ``plugins: [{"id": "web"}]`` is dropped.
    allow_web_plugin: bool = False
    tts_max_chars: int = 4000
    #: Telugu-script share of a TTS input's letters at which it counts as Telugu
    #: even without a language field, so a modified client cannot skip the
    #: gate. 0 disables. A few Telugu words in English text stay allowed.
    telugu_script_gate_ratio: float = 0.5
    #: Bytes per second assumed for compressed audio, whose length cannot be
    #: read without decoding. Deliberately low, so the estimate errs long. WAV
    #: (what the app sends) is measured exactly from its header.
    stt_assumed_bytes_per_second: int = 4000
    #: The daily spend cap's day boundary. 330 = IST.
    daily_cap_utc_offset_minutes: int = 330

    # --- Plans and trial ----------------------------------------------------------
    trial_lockin_days: int = 3
    #: How long a store subscription may sit past its expiry, waiting for the
    #: renewal notification, before the account drops to Spawn.
    plan_expiry_grace_minutes: int = 60

    # --- Admin and billing --------------------------------------------------------
    #: Protects POST /v1/admin/grant. Empty disables the endpoint.
    admin_token: str = ""
    #: Shared secret for POST /v1/billing/play (``?token=`` on the Pub/Sub push
    #: URL, or the ``X-Play-Push-Token`` header). Empty disables the endpoint.
    play_push_token: str = ""
    #: When set, notifications for any other package are ignored.
    play_package_name: str = ""
    play_product_plans: dict[str, str] = Field(
        default_factory=lambda: dict(DEFAULT_PLAY_PRODUCT_PLANS)
    )
    play_topup_products: dict[str, int] = Field(
        default_factory=lambda: dict(DEFAULT_PLAY_TOPUP_PRODUCTS)
    )

    # --- HTTP -------------------------------------------------------------------------
    #: The app's WebView origins. The on-device backend calls the gateway
    #: server-to-server (no CORS), but a browser caller gets a sane policy.
    cors_origins: str = DEFAULT_CORS_ORIGINS

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def allowed_model_list(self) -> list[str]:
        return [m.strip() for m in self.allowed_models.split(",") if m.strip()]
