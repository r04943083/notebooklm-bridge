"""Application configuration via pydantic-settings v2.

All env vars are loaded from `.env` at process start; pydantic-settings also
overlays anything present in the real environment. Settings are cached so the
same object is reused across every request without re-parsing.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- Paths ---
    auth_json_path: Path = Field(alias="NOTEBOOKLM_AUTH_JSON")
    state_json: Path = Field(alias="STATE_JSON")

    # --- Network ---
    backend_host: str = Field(default="0.0.0.0", alias="BACKEND_HOST")
    backend_port: int = Field(default=8002, alias="BACKEND_PORT")
    internal_frontend_origin: str = Field(alias="INTERNAL_FRONTEND_ORIGIN")

    # --- Auth ---
    # X-User-Id is the only header we authenticate against now; see
    # backend/auth.py for the rationale on dropping X-Shared-Secret in v1.0.3.
    # A legacy INTERNAL_AUTH_SHARED_SECRET= line in .env is ignored harmlessly
    # because SettingsConfigDict has extra="ignore" below.

    # --- Behaviour ---
    notebooklm_keepalive_seconds: int = Field(default=1800, alias="NOTEBOOKLM_KEEPALIVE_SECONDS")
    rate_limit_per_minute: int = Field(default=10, alias="RATE_LIMIT_PER_MINUTE")
    rate_limit_burst: int = Field(default=3, alias="RATE_LIMIT_BURST")
    max_inflight_asks: int = Field(default=8, alias="MAX_INFLIGHT_ASKS")
    ask_timeout_seconds: int = Field(default=60, alias="ASK_TIMEOUT_SECONDS")
    circuit_breaker_cooldown: int = Field(default=30, alias="CIRCUIT_BREAKER_COOLDOWN")

    # --- Allowlist ---
    # CSV in env (e.g. "id1,id2"); empty string → no allowlist enforced. Stored as
    # a raw string here because pydantic-settings would otherwise try to JSON-decode
    # a list field's env value and choke on the empty default. Access via the
    # ``allowed_notebook_ids`` property below.
    allowed_notebook_ids_csv: str = Field(default="", alias="ALLOWED_NOTEBOOK_IDS")

    # --- Logging ---
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # env vars are already namespaced (NOTEBOOKLM_AUTH_JSON, BACKEND_PORT, …),
        # so no prefix here — fields use explicit `alias=` instead.
        env_prefix="",
    )

    @property
    def allowed_notebook_ids(self) -> list[str]:
        return [s.strip() for s in self.allowed_notebook_ids_csv.split(",") if s.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor.

    Tests call ``get_settings.cache_clear()`` after monkeypatching env values.
    """
    return Settings()  # type: ignore[call-arg]  # all required fields come from env
