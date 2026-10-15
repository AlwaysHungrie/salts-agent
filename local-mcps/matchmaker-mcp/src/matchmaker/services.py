"""Shared dependencies. Model clients are built per caller key (X-OpenRouter-Api-Key, set by billing.begin); the
server has no key of its own, so a model call outside a keyed request fails with missing_header. Clients assigned
directly (tests) are used as they are."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .billing import current_api_key
from .config import Settings
from .embeddings import Embedder, create_embedder
from .errors import ToolFailure
from .llm import LLM, create_llm

MAX_KEYED_CLIENTS = 32


@dataclass
class Services:
    settings: Settings
    _llm: LLM | None = field(default=None, repr=False)
    _embedder: Embedder | None = field(default=None, repr=False)
    _judge: LLM | None = field(default=None, repr=False)
    _core_reader: LLM | None = field(default=None, repr=False)
    _keyed: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    # The search index, rebuilt when a person's files change (see search.Index).
    index: Any = field(default=None, repr=False)

    def _client(self, attr: str, build: Callable[[Settings, str], Any]) -> Any:
        if (injected := getattr(self, attr)) is not None:
            return injected
        key = current_api_key()
        if key is None:
            raise ToolFailure("missing_header", "no OpenRouter key: send it in the X-OpenRouter-Api-Key header. "
                              "This server never uses a key of its own")
        if key not in self._keyed:
            if len(self._keyed) >= MAX_KEYED_CLIENTS:
                self._keyed.pop(next(iter(self._keyed)))
            self._keyed[key] = {}
        clients = self._keyed[key]
        if attr not in clients:
            clients[attr] = build(self.settings, key)
        return clients[attr]

    @property
    def llm(self) -> LLM:
        """Profile writing."""
        return self._client("_llm", create_llm)

    @property
    def judge(self) -> LLM:
        """Page judging, on judge_model."""
        return self._client("_judge", lambda settings, key: create_llm(
            settings, key, settings.judge_model, reasoning_effort=settings.judge_reasoning_effort,
            temperature=settings.judge_temperature, seed=settings.judge_seed))

    @property
    def core_reader(self) -> LLM:
        """Reads a job's core once, on core_model."""
        return self._client("_core_reader", lambda settings, key: create_llm(
            settings, key, settings.core_model, reasoning_effort=settings.core_reasoning_effort))

    @property
    def embedder(self) -> Embedder:
        """Profiles, jobs and queries, for the meaning half of search."""
        return self._client("_embedder", create_embedder)
