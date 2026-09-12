"""Typed application settings, loaded once from the environment / .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/  — everything relative resolves against this.
BACKEND_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # `model_` is a protected prefix in pydantic; we never use it below.
        protected_namespaces=(),
    )

    # --- Provider selection -----------------------------------------------
    # v1 wires all three to Sarvam. v2 points STT/TTS elsewhere; v3 points chat
    # at Anthropic/OpenAI. Each is an independent switch.
    jarvis_chat_provider: str = Field(default="sarvam", alias="JARVIS_CHAT_PROVIDER")
    jarvis_stt_provider: str = Field(default="sarvam", alias="JARVIS_STT_PROVIDER")
    jarvis_tts_provider: str = Field(default="sarvam", alias="JARVIS_TTS_PROVIDER")

    # --- Sarvam ------------------------------------------------------------
    sarvam_api_key: str = Field(default="", alias="SARVAM_API_KEY")
    sarvam_base_url: str = Field(default="https://api.sarvam.ai", alias="SARVAM_BASE_URL")

    # Both paths now use the dialogue-tuned variant. `sarvam-105b` reasons
    # before answering, and a measured turn showed it spending that budget
    # restating the question ("We need to answer what is on now. The state
    # block says...") before producing anything the user sees. For an assistant
    # answering from a state block it is already given, that reasoning buys
    # nothing and costs latency on every turn.
    #
    # Set SARVAM_CHAT_MODEL=sarvam-105b in .env to get it back for work that
    # genuinely needs multi-step thought.
    sarvam_chat_model: str = Field(
        default="sarvam-105b-conversations", alias="SARVAM_CHAT_MODEL"
    )
    sarvam_stt_model: str = Field(default="saaras:v4", alias="SARVAM_STT_MODEL")
    sarvam_tts_model: str = Field(default="bulbul:v3", alias="SARVAM_TTS_MODEL")
    #: Fallback only — the live voice is a user preference (see `core.voices`).
    sarvam_tts_speaker: str = Field(default="priya", alias="SARVAM_TTS_SPEAKER")

    # Expressiveness. `temperature` is bulbul:v3's randomness/expressiveness
    # control — the API caps it at 1.0 despite the docs saying 2.0, so it is
    # clamped below. `pitch` and `loudness` are v2-only and are never sent.
    sarvam_tts_temperature: float = Field(default=0.95, alias="SARVAM_TTS_TEMPERATURE")
    #: Global nudge applied on top of each language's own pace, so the overall
    #: speed can be tuned from .env without editing the per-language table.
    sarvam_tts_pace: float = Field(default=1.0, alias="SARVAM_TTS_PACE")
    sarvam_tts_sample_rate: int = Field(default=24000, alias="SARVAM_TTS_SAMPLE_RATE")
    sarvam_language: str = Field(default="en-IN", alias="SARVAM_LANGUAGE")
    # Empty disables reasoning outright. Sarvam documents this as its fastest
    # mode, meant for ordinary conversational turns -- reasoning tokens cost
    # both latency and money, and most voice turns ("what's my Monday
    # schedule", "add a task") do not need them. Escalate per-turn (a
    # different value passed at call time) rather than raising this default,
    # if a class of turn turns out to need it.
    sarvam_reasoning_effort: Literal["", "low", "medium", "high"] = Field(
        default="", alias="SARVAM_REASONING_EFFORT"
    )
    sarvam_temperature: float = Field(default=0.2, alias="SARVAM_TEMPERATURE")
    sarvam_chat_timeout: float = Field(default=45.0, alias="SARVAM_CHAT_TIMEOUT")

    # --- Gemini (English chat only; Sarvam remains the whole stack for every
    # other language) ---------------------------------------------------
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    # gemini-3.5-flash-lite measured ~1.7s to first token / ~4s total on a
    # plain conversational prompt; gemini-3.6-flash measured ~9s / ~13s on
    # the same prompt (its "thinking" overhead is much larger and not fully
    # suppressible via thinking_config). For a voice-adjacent assistant the
    # lite tier is the only one of the two worth using by default.
    gemini_model: str = Field(default="gemini-3.5-flash-lite", alias="GEMINI_MODEL")
    gemini_chat_timeout: float = Field(default=30.0, alias="GEMINI_CHAT_TIMEOUT")
    #: Large typed prompts need longer for the provider's first output, especially
    #: after a tool cycle. This applies only when the current user message crosses
    #: ``jarvis_typed_stream_chars``; ordinary and voice turns keep the fast limit.
    sarvam_long_chat_timeout: float = Field(
        default=120.0, alias="SARVAM_LONG_CHAT_TIMEOUT"
    )
    sarvam_speech_timeout: float = Field(default=90.0, alias="SARVAM_SPEECH_TIMEOUT")

    # --- Agent loop --------------------------------------------------------
    # Reasoning tokens bill against this budget, so it must be generous: a small
    # ceiling returns an empty message with finish_reason "length".
    jarvis_max_tokens: int = Field(default=4000, alias="JARVIS_MAX_TOKENS")
    jarvis_max_tool_iterations: int = Field(default=8, alias="JARVIS_MAX_TOOL_ITERATIONS")
    jarvis_history_limit: int = Field(default=40, alias="JARVIS_HISTORY_LIMIT")
    #: Absolute ceiling for a typed agent turn, including all tool rounds. A
    #: local UI must always receive a terminal event even if the vendor stalls.
    jarvis_chat_turn_timeout: float = Field(default=240.0, alias="JARVIS_CHAT_TURN_TIMEOUT")
    #: Typed prompts at or above this size stream progressively. Short prompts
    #: retain the faster/cacheable one-shot completion path.
    jarvis_typed_stream_chars: int = Field(
        default=4000, alias="JARVIS_TYPED_STREAM_CHARS"
    )

    # --- Voice -------------------------------------------------------------
    jarvis_voice_enabled: bool = Field(default=True, alias="JARVIS_VOICE_ENABLED")
    #: Reject uploads larger than this before they reach the vendor (MB).
    jarvis_max_audio_mb: float = Field(default=15.0, alias="JARVIS_MAX_AUDIO_MB")

    #: Conversational mode runs the dialogue-tuned variant: it emits no
    #: reasoning tokens, which roughly halves time-to-first-word.
    sarvam_voice_model: str = Field(
        default="sarvam-105b-conversations", alias="SARVAM_VOICE_MODEL"
    )
    #: Spoken replies are two sentences by design. A tight ceiling caps a
    #: runaway monologue; the prompt does the real work.
    jarvis_voice_max_tokens: int = Field(default=500, alias="JARVIS_VOICE_MAX_TOKENS")
    #: Synthesize as soon as this many characters form a complete sentence.
    #: The first chunk uses a smaller threshold so audio starts sooner.
    jarvis_tts_chunk_chars: int = Field(default=90, alias="JARVIS_TTS_CHUNK_CHARS")

    # Streaming speech is negotiated per client; old clients still receive WAV.
    jarvis_streaming_tts: bool = Field(default=True, alias="JARVIS_STREAMING_TTS")

    # --- English TTS (Piper, local) ---------------------------------------
    #: Which engine speaks *English*. "piper" runs a local neural voice on the
    #: CPU (free, private, no per-call latency); "sarvam" sends English to the
    #: cloud like every other language. Non-English is always Sarvam regardless.
    #: Desktop defaults to Piper; the Android build overrides this to "sarvam"
    #: because Piper's ONNX stack has no arm64 Chaquopy wheel.
    jarvis_english_tts: Literal["piper", "sarvam"] = Field(
        default="piper", alias="JARVIS_ENGLISH_TTS"
    )
    #: Which model answers when the reply language is English. "gemini" tries
    #: Gemini first and falls over to Sarvam for that turn if it errors or
    #: times out (see `providers.gemini.EnglishChatProvider`); "sarvam" keeps
    #: English on the same stack as every other language. STT and TTS are
    #: unaffected either way — this only ever changes which model writes the
    #: reply text. Non-English replies always use Sarvam's whole stack,
    #: regardless of this setting.
    jarvis_english_llm: Literal["gemini", "sarvam"] = Field(
        default="gemini", alias="JARVIS_ENGLISH_LLM"
    )
    #: Path to the Piper .onnx voice, relative to backend/ or absolute. The
    #: high-quality "ryan" voice is the default; a .onnx.json of the same name
    #: must sit beside it. Not committed — see explanations.md to fetch it.
    jarvis_piper_model: str = Field(
        default="models/piper/en_US-ryan-high.onnx", alias="JARVIS_PIPER_MODEL"
    )
    #: Global speaking-rate nudge for Piper, multiplied onto the per-language
    #: pace (English 1.04). 1.0 leaves the voice at its natural speed.
    jarvis_piper_pace: float = Field(default=1.0, alias="JARVIS_PIPER_PACE")

    # --- Task board --------------------------------------------------------
    #: The board lists outstanding work, so finishing a task removes it. Set
    #: false to keep completed rows around instead.
    jarvis_clear_completed_tasks: bool = Field(
        default=True, alias="JARVIS_CLEAR_COMPLETED_TASKS"
    )

    # --- Storage -----------------------------------------------------------
    jarvis_db_path: str = Field(default="storage/jarvis_memory.db", alias="JARVIS_DB_PATH")
    jarvis_db_pool_size: int = Field(default=5, alias="JARVIS_DB_POOL_SIZE")

    #: True when the *client* owns the user's data and this backend is only
    #: the AI runtime -- IndexedDB is authoritative and SQLite is a disposable
    #: working copy. Enables the /api/local bridge, which drains the client's
    #: own change queue instead of a backend-side sync engine doing it.
    #:
    #: Originally an Android-only flag, and for a while the codebase used it
    #: as a stand-in for "is this Android" everywhere -- see
    #: ``system_tools_enabled``/``scheduler_enabled`` below for why that was
    #: wrong. It is purely about data ownership now: 2026-09-12, desktop
    #: adopted the same client-owned-data architecture mobile already used
    #: (one client-side sync engine, shared by both platforms, instead of a
    #: second engine living in this backend) -- ``jarvis_android`` is the
    #: platform signal now.
    jarvis_client_owned_data: bool = Field(
        default=False, alias="JARVIS_CLIENT_OWNED_DATA"
    )

    #: True only inside the Android APK's sandboxed Chaquopy process. Split out
    #: from ``jarvis_client_owned_data`` because desktop now sets that flag
    #: too (see above) but is not sandboxed and not foreground-only -- its
    #: shell/filesystem tools work fine and it can run a background scheduler
    #: all day. Set by the Android build's own entry point
    #: (``jarvis_server.py``), never by a human.
    jarvis_android: bool = Field(default=False, alias="JARVIS_ANDROID")

    #: Whether the agent may reach outside its own database -- shell, files,
    #: the network. Off makes JARVIS the command center it has always been; on
    #: makes it an agent that can act on the machine it runs on.
    #:
    #: Forced off on mobile regardless of this setting (see
    #: ``system_tools_enabled``): the same backend runs inside the Android APK,
    #: where a shell is confined to the app sandbox and is useless at best.
    jarvis_system_tools: bool = Field(default=True, alias="JARVIS_SYSTEM_TOOLS")

    #: Whether the timetable actually fires. Off and JARVIS goes back to
    #: knowing the schedule without ever acting on it.
    jarvis_scheduler_enabled: bool = Field(
        default=True, alias="JARVIS_SCHEDULER_ENABLED"
    )

    # --- Cross-device sync -------------------------------------------------
    #: Supabase is a mirror, not the database: SQLite above stays the source of
    #: truth so no read ever waits on the network. Leave the URL/key empty and
    #: sync turns itself off, which is the correct standalone behaviour.
    #:
    #: The service-role key bypasses row-level security, so it belongs in
    #: backend/.env on this machine and nowhere near the frontend bundle.
    supabase_url: str = Field(default="", alias="SUPABASE_URL")
    supabase_service_key: str = Field(default="", alias="SUPABASE_SERVICE_KEY")
    jarvis_sync_enabled: bool = Field(default=True, alias="JARVIS_SYNC_ENABLED")
    jarvis_sync_interval: int = Field(default=120, alias="JARVIS_SYNC_INTERVAL")

    # --- Server ------------------------------------------------------------
    jarvis_host: str = Field(default="127.0.0.1", alias="JARVIS_HOST")
    jarvis_port: int = Field(default=8000, alias="JARVIS_PORT")
    jarvis_cors_origins: str = Field(
        default="http://localhost:3000,http://127.0.0.1:3000",
        alias="JARVIS_CORS_ORIGINS",
    )
    #: Port the UI is served on, used to build the private-LAN CORS pattern.
    jarvis_frontend_port: int = Field(default=3000, alias="JARVIS_FRONTEND_PORT")

    # --- Derived -----------------------------------------------------------
    @property
    def db_file(self) -> Path:
        path = Path(self.jarvis_db_path)
        return path if path.is_absolute() else BACKEND_ROOT / path

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.jarvis_cors_origins.split(",") if o.strip()]

    @property
    def cors_origin_regex(self) -> str:
        """Origins allowed to call this backend.

        Two distinct shapes, because the app is served two different ways.

        A *browser* loads it from a dev server on the frontend port, on
        localhost or an RFC1918 address. The private ranges are covered so the
        origin does not need re-pinning every time DHCP hands out a new lease.

        A *packaged app* has no dev server: Tauri serves the bundle from its own
        internal origin — ``tauri.localhost`` on Android and Windows,
        ``tauri://localhost`` elsewhere — with no port at all. Omitting these
        blocks the phone from reaching the backend running inside its own
        process, which presents as "cannot reach the backend" while the server
        is demonstrably listening.
        """
        host = (
            r"(localhost|127\.0\.0\.1"
            r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
            r"|192\.168\.\d{1,3}\.\d{1,3}"
            r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})"
        )
        browser = rf"https?://{host}:{self.jarvis_frontend_port}"
        packaged = r"https?://(tauri\.localhost|localhost)|tauri://localhost"
        return rf"^({browser}|{packaged})$"

    @property
    def system_tools_enabled(self) -> bool:
        """Whether shell/filesystem/network tools are offered to the model.

        Two gates, not one. The setting is the operator's intent; ``jarvis_android``
        is the platform. Sandboxed inside the Android APK, a shell can reach
        nothing the user cares about, so offering it would spend tokens on
        every request to advertise a dead end. Desktop is not sandboxed --
        this stays on there even now that desktop is also client-owned-data,
        which is exactly why this is keyed on ``jarvis_android`` and not on
        ``jarvis_client_owned_data`` any more.
        """
        return self.jarvis_system_tools and not self.jarvis_android

    @property
    def scheduler_enabled(self) -> bool:
        """Whether the background scheduler runs.

        Same two-gate shape as ``system_tools_enabled``: the operator's setting,
        and the platform. Forced off in the Android build, which is
        foreground-only by design -- a timer there would be firing into a
        process the OS is about to freeze, and the announcements would arrive in
        a burst whenever the user next opened the app.
        """
        return self.jarvis_scheduler_enabled and not self.jarvis_android

    @property
    def has_api_key(self) -> bool:
        return bool(self.sarvam_api_key.strip())

    @property
    def has_gemini_key(self) -> bool:
        return bool(self.gemini_api_key.strip())

    @property
    def sync_configured(self) -> bool:
        return bool(self.supabase_url.strip() and self.supabase_service_key.strip())

    @property
    def max_audio_bytes(self) -> int:
        return int(self.jarvis_max_audio_mb * 1024 * 1024)

    @field_validator("jarvis_db_pool_size")
    @classmethod
    def _pool_size_sane(cls, value: int) -> int:
        return max(1, min(value, 32))

    @field_validator("jarvis_sync_interval")
    @classmethod
    def _sync_interval_sane(cls, value: int) -> int:
        # Below ~15s the loop spends more time on round trips than on real
        # change; above an hour the phone feels stale.
        return max(15, min(value, 3600))

    @field_validator("jarvis_max_tool_iterations")
    @classmethod
    def _iterations_sane(cls, value: int) -> int:
        return max(1, min(value, 50))

    @field_validator("sarvam_tts_temperature")
    @classmethod
    def _temperature_sane(cls, value: float) -> float:
        # bulbul:v3 rejects anything above 1.0 with a 400.
        return max(0.01, min(value, 1.0))

    @field_validator("sarvam_tts_pace")
    @classmethod
    def _pace_sane(cls, value: float) -> float:
        return max(0.5, min(value, 2.0))

    @field_validator("jarvis_max_tokens")
    @classmethod
    def _tokens_sane(cls, value: int) -> int:
        # Below ~1500 the reasoning pass alone can exhaust the budget and the
        # model returns no visible content at all.
        return max(1500, value)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
