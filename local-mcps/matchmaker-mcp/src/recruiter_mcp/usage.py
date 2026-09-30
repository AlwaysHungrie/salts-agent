"""Per-tool-call token accounting. Providers append records; the tool wrapper flushes them."""

import contextvars
import uuid
from dataclasses import dataclass

import asyncpg

from .billing import charge


@dataclass
class UsageRecord:
    kind: str  # llm | embedding
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cost_usd: float | None = None


_records: contextvars.ContextVar[list[UsageRecord] | None] = contextvars.ContextVar(
    "usage_records", default=None
)


def record(rec: UsageRecord) -> None:
    charge(rec.cost_usd)
    bucket = _records.get()
    if bucket is not None:
        bucket.append(rec)


class track_usage:
    """`async with track_usage(pool, "ingest_resume"):` collects and persists usage for the block."""

    def __init__(self, pool: asyncpg.Pool | None, tool: str) -> None:
        self.pool, self.tool = pool, tool
        self.request_id = uuid.uuid4()
        self.records: list[UsageRecord] = []

    async def __aenter__(self) -> "track_usage":
        self._token = _records.set(self.records)
        return self

    async def __aexit__(self, *exc) -> None:
        _records.reset(self._token)
        if self.pool is None or not self.records:
            return
        await self.pool.executemany(
            "INSERT INTO usage (tool, request_id, kind, model, input_tokens, output_tokens,"
            " cache_read_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
                (self.tool, self.request_id, r.kind, r.model, r.input_tokens, r.output_tokens,
                 r.cache_read_tokens, r.cost_usd)
                for r in self.records
            ],
        )

    @property
    def cost_usd(self) -> float:
        return sum(r.cost_usd or 0 for r in self.records)


def current_records() -> list[UsageRecord]:
    """Usage recorded so far in the active track_usage block (empty outside one)."""
    return list(_records.get() or [])
