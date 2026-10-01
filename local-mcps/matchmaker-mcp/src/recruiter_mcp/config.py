from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://recruiter:recruiter@localhost:5432/recruiter"

    # Original resume files live under DATA_DIR/resumes/{candidate_id}/{Name}_Resume_{sha8}.pdf.
    data_dir: Path = Path("./data")
    # Bulk inbox: the user drops PDFs here and the agent ingests them with ingest_folder. Default DATA_DIR/inbox.
    inbox_dir: Path | None = None

    # OpenRouter (OpenAI-compatible) for chat + embeddings.
    llm_provider: Literal["openrouter"] = "openrouter"
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_model: str = "openai/gpt-5-mini"
    llm_api_key: str | None = None
    llm_timeout_seconds: float = 60.0
    # Passed to reasoning models via OpenRouter; empty to omit.
    llm_reasoning_effort: str | None = "low"
    # Transcribes PDFs for folder ingest (ingest_folder tool, scripts/bulk_ingest.py): no assistant in the loop.
    vision_model: str = "google/gemini-3.1-flash-lite"
    vision_timeout_seconds: float = 120.0

    embed_provider: Literal["openrouter"] = "openrouter"
    embed_base_url: str = "https://openrouter.ai/api/v1"
    embed_model: str = "openai/text-embedding-3-small"
    embed_dim: int = 1536
    embed_api_key: str | None = None
    embed_timeout_seconds: float = 30.0

    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    mcp_auth_token: str | None = None

    rerank_pool_size: int = 50
    rerank_concurrency: int = 10
    # Reasoning tokens bill as output; rerank is 50 calls per match, so keep it minimal.
    rerank_reasoning_effort: str | None = "minimal"
    # Candidates scoring below this are left out of match results rather than padding the list.
    min_match_score: int = 35
    # Scores vary a few points between runs. Candidates within this many points of a cutoff (min_match_score, or
    # the gap between rank `limit` and the next) are scored once more and averaged. 0 disables.
    rerank_borderline_margin: int = 8
    # Pool selection adds this x (fraction of must-haves in the candidate's skills) to cosine similarity, so
    # candidates with the required skills but a thin profile still get reranked. 0 = similarity only.
    pool_skill_boost: float = 0.1
    # Slack applied to years parsed from the JD (explicit filters are exact): "5-8 yrs" admits 4-10.
    years_slack_below: float = 1.0
    years_slack_above: float = 2.0
    max_file_bytes: int = 10 * 1024 * 1024
    # Folder ingest: files transcribed at once, and failures before a file is given up on.
    folder_concurrency: int = 4
    folder_max_attempts: int = 3
    # Default spend caps in USD when the client sends no X-Cost-Approved-* header (always the case on stdio).
    # Unset = no cap. See billing.py.
    cost_approved_resume_ingestion: float | None = None
    cost_approved_job_match: float | None = None
    cost_approved_search: float | None = None
    cost_approved_folder_ingestion: float | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
