"""Shared dependencies for tool handlers. LLM/embedder are built lazily so the server starts
(and `ping` works) without API keys. A key sent with the request gets its own clients."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from .billing import current_api_key
from .config import Settings
from .embeddings import Embedder, create_embedder
from .llm import LLM, OpenRouterVision, create_llm
from .skills import SkillNormalizer
from .storage import LocalStorage

MAX_KEYED_CLIENTS = 32


@dataclass
class Services:
    settings: Settings
    pool: asyncpg.Pool
    storage: LocalStorage
    normalizer: SkillNormalizer
    _llm: LLM | None = field(default=None, repr=False)
    _embedder: Embedder | None = field(default=None, repr=False)
    _vision: OpenRouterVision | None = field(default=None, repr=False)
    # Clients for API keys sent per request (X-OpenRouter-Api-Key), by key.
    _keyed: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)

    def _client(self, attr: str, build: Callable[[Settings], Any]) -> Any:
        key = current_api_key()
        if key is None:
            if getattr(self, attr) is None:
                setattr(self, attr, build(self.settings))
            return getattr(self, attr)
        if key not in self._keyed:
            if len(self._keyed) >= MAX_KEYED_CLIENTS:
                self._keyed.pop(next(iter(self._keyed)))
            self._keyed[key] = {}
        clients = self._keyed[key]
        if attr not in clients:
            clients[attr] = build(self.settings.model_copy(update={"llm_api_key": key, "embed_api_key": key}))
        return clients[attr]

    @property
    def llm(self) -> LLM:
        return self._client("_llm", create_llm)

    @property
    def embedder(self) -> Embedder:
        return self._client("_embedder", create_embedder)

    @property
    def vision(self) -> OpenRouterVision:
        """Transcribes PDFs for folder ingest, where no assistant reads the files."""
        return self._client("_vision", OpenRouterVision)


async def load_normalizer(pool: asyncpg.Pool) -> SkillNormalizer:
    rows = await pool.fetch("SELECT alias, canonical FROM skill_synonyms")
    return SkillNormalizer({r["alias"]: r["canonical"] for r in rows})
