from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # MM_ names while the recruiter server (DATA_DIR, LLM_MODEL) shares this .env.
    # Everything lives in files: DATA_DIR/people/<person_id>/ and DATA_DIR/jobs/<job_id>/. No database.
    data_dir: Path = Field(Path("./data/matchmaker"), validation_alias=AliasChoices("MM_DATA_DIR"))
    # The bulk inbox the agent hands the user (DATA_DIR/inbox when unset).
    inbox_dir: Path | None = Field(None, validation_alias=AliasChoices("MM_INBOX_DIR"))

    # OpenRouter (OpenAI-compatible) for chat + embeddings. There is deliberately no API key setting: every model
    # call uses the caller's key from the X-OpenRouter-Api-Key header, never one of the server's own.
    llm_provider: Literal["openrouter"] = "openrouter"
    llm_base_url: str = "https://openrouter.ai/api/v1"
    # One call per document added (the profile). Judging uses judge_model.
    llm_model: str = Field("openai/gpt-5-nano", validation_alias=AliasChoices("MM_LLM_MODEL"))
    llm_timeout_seconds: float = 90.0
    llm_reasoning_effort: str | None = "low"

    embed_provider: Literal["openrouter"] = "openrouter"
    embed_base_url: str = "https://openrouter.ai/api/v1"
    embed_model: str = "openai/text-embedding-3-small"
    embed_dim: int = 1536
    embed_timeout_seconds: float = 30.0

    # Judging a page: a model that takes temperature 0 reads each candidate's full documents, one per call, so a
    # candidate's answers do not depend on who else is on the page. Reasoning models refuse a temperature. Chosen on
    # the benchmark: gemini-2.5-flash gave the same order run to run (rank agreement 0.998; gpt-4.1-mini 0.94,
    # gpt-5-mini 0.84) and the best order. ~$0.10 per page of 50.
    judge_model: str = Field("google/gemini-2.5-flash", validation_alias=AliasChoices("MM_JUDGE_MODEL"))
    judge_reasoning_effort: str | None = None
    judge_temperature: float | None = 0.0
    judge_seed: int | None = 7
    judge_batch: int = 1
    # The job's core (role type, core work, must-haves) decides every check, so a reasoning model reads it, once
    # per job.
    core_model: str = Field("openai/gpt-5-mini", validation_alias=AliasChoices("MM_CORE_MODEL"))
    core_reasoning_effort: str = "medium"

    # MCP transport. salts-tools runs it over HTTP with these set; stdio refuses paid tools (no key header).
    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    mcp_auth_token: str | None = None
    max_file_bytes: int = 10 * 1024 * 1024
    # How long a browser link (a person's files, the upload page) works.
    link_ttl_hours: int = Field(24, validation_alias=AliasChoices("MM_LINK_TTL_HOURS"))

    page_size: int = 50
    # Reciprocal rank fusion constant: rank r in either list adds 1 / (rrf_k + r).
    rrf_k: int = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
