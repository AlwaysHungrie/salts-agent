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

    # Judging a page: a stronger model reads each candidate's full documents, a few per call.
    judge_model: str = Field("openai/gpt-5-mini", validation_alias=AliasChoices("MM_JUDGE_MODEL"))
    judge_reasoning_effort: str = "medium"
    judge_batch: int = 5

    page_size: int = 50
    # Reciprocal rank fusion constant: rank r in either list adds 1 / (rrf_k + r).
    rrf_k: int = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
