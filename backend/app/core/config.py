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

    # sarvam-105b reasons before answering; sarvam-105b-conversations is
    # post-trained for real-time dialogue and emits no reasoning tokens, which
    # makes it markedly lower latency for the voice path.
    sarvam_chat_model: str = Field(default="sarvam-105b", alias="SARVAM_CHAT_MODEL")
    sarvam_stt_model: str = Field(default="saaras:v4", alias="SARVAM_STT_MODEL")
    sarvam_tts_model: str = Field(default="bulbul:v3", alias="SARVAM_TTS_MODEL")
    sarvam_tts_speaker: str = Field(default="anushka", alias="SARVAM_TTS_SPEAKER")
    sarvam_language: str = Field(default="en-IN", alias="SARVAM_LANGUAGE")
    sarvam_reasoning_effort: Literal["", "low", "medium", "high"] = Field(
        default="low", alias="SARVAM_REASONING_EFFORT"
    )
    sarvam_temperature: float = Field(default=0.2, alias="SARVAM_TEMPERATURE")
    sarvam_chat_timeout: float = Field(default=180.0, alias="SARVAM_CHAT_TIMEOUT")
    sarvam_speech_timeout: float = Field(default=90.0, alias="SARVAM_SPEECH_TIMEOUT")

    # --- Agent loop --------------------------------------------------------
    # Reasoning tokens bill against this budget, so it must be generous: a small
    # ceiling returns an empty message with finish_reason "length".
    jarvis_max_tokens: int = Field(default=4000, alias="JARVIS_MAX_TOKENS")
    jarvis_max_tool_iterations: int = Field(default=8, alias="JARVIS_MAX_TOOL_ITERATIONS")
    jarvis_history_limit: int = Field(default=40, alias="JARVIS_HISTORY_LIMIT")

    # --- Voice -------------------------------------------------------------
    jarvis_voice_enabled: bool = Field(default=True, alias="JARVIS_VOICE_ENABLED")
    #: Reject uploads larger than this before they reach the vendor (MB).
    jarvis_max_audio_mb: float = Field(default=15.0, alias="JARVIS_MAX_AUDIO_MB")

    # --- Storage -----------------------------------------------------------
    jarvis_db_path: str = Field(default="storage/jarvis_memory.db", alias="JARVIS_DB_PATH")
    jarvis_db_pool_size: int = Field(default=5, alias="JARVIS_DB_POOL_SIZE")

    # --- Server ------------------------------------------------------------
    jarvis_host: str = Field(default="127.0.0.1", alias="JARVIS_HOST")
    jarvis_port: int = Field(default=8000, alias="JARVIS_PORT")
    jarvis_cors_origins: str = Field(
        default="http://localhost:3000,http://127.0.0.1:3000",
        alias="JARVIS_CORS_ORIGINS",
    )

    # --- Derived -----------------------------------------------------------
    @property
    def db_file(self) -> Path:
        path = Path(self.jarvis_db_path)
        return path if path.is_absolute() else BACKEND_ROOT / path

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.jarvis_cors_origins.split(",") if o.strip()]

    @property
    def has_api_key(self) -> bool:
        return bool(self.sarvam_api_key.strip())

    @property
    def max_audio_bytes(self) -> int:
        return int(self.jarvis_max_audio_mb * 1024 * 1024)

    @field_validator("jarvis_db_pool_size")
    @classmethod
    def _pool_size_sane(cls, value: int) -> int:
        return max(1, min(value, 32))

    @field_validator("jarvis_max_tool_iterations")
    @classmethod
    def _iterations_sane(cls, value: int) -> int:
        return max(1, min(value, 50))

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
