"""Per-tool-call token accounting. Providers append records; `track_usage` collects them for one call."""

import contextvars
from dataclasses import dataclass

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
    """`async with track_usage("save_profile") as t:` collects usage for the block; `t.cost_usd` after."""

    def __init__(self, tool: str) -> None:
        self.tool = tool
        self.records: list[UsageRecord] = []

    async def __aenter__(self) -> "track_usage":
        self._token = _records.set(self.records)
        return self

    async def __aexit__(self, *exc) -> None:
        _records.reset(self._token)

    @property
    def cost_usd(self) -> float:
        return sum(r.cost_usd or 0 for r in self.records)
