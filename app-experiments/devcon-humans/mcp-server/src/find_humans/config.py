from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Everything lives in files: DATA_DIR/people/<person_id>/. No database.
    data_dir: Path = Path("./data")

    # OpenRouter (OpenAI-compatible) for chat + embeddings. A caller's X-OpenRouter-Api-Key header pays for their
    # calls; without one, the server's own key below does. Unset: callers must send theirs.
    openrouter_api_key: str | None = None
    llm_provider: Literal["openrouter"] = "openrouter"
    llm_base_url: str = "https://openrouter.ai/api/v1"
    # One call per saved profile.
    llm_model: str = "openai/gpt-5-nano"
    llm_timeout_seconds: float = 90.0
    llm_reasoning_effort: str | None = "low"

    embed_provider: Literal["openrouter"] = "openrouter"
    embed_base_url: str = "https://openrouter.ai/api/v1"
    embed_model: str = "openai/text-embedding-3-small"
    embed_dim: int = 1536
    embed_timeout_seconds: float = 30.0

    # MCP transport. Over HTTP every caller sends their own headers; stdio refuses paid tools and has no secret.
    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    # Callers' secrets are minted with this key (see identity.py). Required, and at least MIN_SIGNING_KEY_BYTES:
    # there is no other way in, so no shared token sits in any caller's settings.
    secret_signing_key: str | None = None

    # What one person may cost the server's own OpenRouter key, in US dollars per UTC day and month (0 = no limit).
    # Calls paid with the caller's own X-OpenRouter-Api-Key do not count.
    person_daily_limit_usd: float = 0.0
    person_monthly_limit_usd: float = 0.0

    # What one person may add: entries (each text or link is one) and the length of each.
    max_entries: int = 100
    max_text_chars: int = 4000
    max_link_chars: int = 500

    page_size: int = 10
    # Reciprocal rank fusion constant: rank r in either list adds 1 / (rrf_k + r).
    rrf_k: int = 60


MIN_SIGNING_KEY_BYTES = 32


def signing_key_problem(settings: Settings) -> str | None:
    """Why the server must not start with these settings, or None."""
    if not settings.secret_signing_key:
        return "SECRET_SIGNING_KEY is required"
    if len(settings.secret_signing_key.encode()) < MIN_SIGNING_KEY_BYTES:
        return f"SECRET_SIGNING_KEY must be at least {MIN_SIGNING_KEY_BYTES} bytes (openssl rand -base64 48)"
    return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
