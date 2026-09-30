"""Embedding provider interface."""

from typing import Protocol

from openai import AsyncOpenAI

from .billing import ensure_budget
from .config import Settings
from .errors import ToolFailure
from .usage import UsageRecord, record


class Embedder(Protocol):
    dim: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenRouterEmbedder:
    def __init__(self, settings: Settings) -> None:
        if not settings.embed_api_key:
            raise ToolFailure(
                "config_error", "no OpenRouter API key: send the X-OpenRouter-Api-Key header or set EMBED_API_KEY"
            )
        self.model = settings.embed_model
        self.dim = settings.embed_dim
        self.client = AsyncOpenAI(
            base_url=settings.embed_base_url,
            api_key=settings.embed_api_key,
            timeout=settings.embed_timeout_seconds,
            max_retries=2,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        kwargs: dict = {}
        # OpenAI v3 models can be shortened to the configured dimension.
        if "text-embedding-3" in self.model:
            kwargs["dimensions"] = self.dim
        ensure_budget()
        resp = await self.client.embeddings.create(model=self.model, input=texts, **kwargs)
        vectors = [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
        if any(len(v) != self.dim for v in vectors):
            raise ToolFailure(
                "config_error",
                f"embedding model returned {len(vectors[0])} dims, EMBED_DIM is {self.dim}",
            )
        if resp.usage is not None:
            record(
                UsageRecord(
                    kind="embedding",
                    model=self.model,
                    input_tokens=resp.usage.prompt_tokens or 0,
                    cost_usd=getattr(resp.usage, "cost", None),
                )
            )
        return vectors


def create_embedder(settings: Settings) -> Embedder:
    if settings.embed_provider == "openrouter":
        return OpenRouterEmbedder(settings)
    raise ToolFailure("config_error", f"unknown EMBED_PROVIDER {settings.embed_provider}")
