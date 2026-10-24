"""Test setup: a temp DATA_DIR and fake model clients, so tests run offline.

What people write in tests uses a tiny line format the fake LLM reads:
  Name: / Headline: / Location: / Skill: AI agents
"""

import hashlib
import math
import re
import tempfile
from pathlib import Path

import pytest

from find_humans.billing import ensure_budget
from find_humans.config import Settings, get_settings
from find_humans.identity import mint
from find_humans.services import Services
from find_humans.usage import UsageRecord, record


def _fields(text: str, name: str) -> list[str]:
    return [m.strip() for m in re.findall(rf"^{name}:\s*(.+)$", text, re.M)]


def _last(text: str, name: str) -> str | None:
    found = _fields(text, name)
    return found[-1] if found else None


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.prompts: list[str] = []

    async def structured(self, system, user, schema, *, name, reasoning_effort=None):
        ensure_budget()
        self.calls.append(name)
        self.prompts.append(system + "\n" + user)
        record(UsageRecord(kind="llm", model="fake", input_tokens=len(system + user) // 4, output_tokens=100,
                           cost_usd=0.0001))
        return schema.model_validate(getattr(self, "_" + name)(user))

    def _person_profile(self, user):
        headline = _last(user, "Headline") or "Unknown"
        return {"name": _last(user, "Name"), "headline": headline, "location": _last(user, "Location"),
                "skills": list(dict.fromkeys(_fields(user, "Skill"))), "summary": f"Works as {headline}."}


class FakeEmbedder:
    """Hashed bag-of-words vectors, so texts sharing words get similar vectors."""

    def __init__(self, dim: int = 64) -> None:
        self.dim = dim
        self.calls = 0

    async def embed(self, texts):
        ensure_budget()
        self.calls += 1
        record(UsageRecord(kind="embedding", model="fake", input_tokens=10, cost_usd=0.00001))
        out = []
        for t in texts:
            v = [0.0] * self.dim
            for tok in re.findall(r"[a-z0-9+#]+", t.lower()):
                h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n for x in v])
        return out


SIGNING_KEY = "test-signing-key-0123456789abcdefghij"


def secret(secret_id: str) -> str:
    """A secret minted for `secret_id` with the tests' signing key."""
    return mint(SIGNING_KEY, secret_id)


@pytest.fixture(autouse=True)
def test_settings(monkeypatch):
    """Tests use their own signing key and no server OpenRouter key, whatever the local .env says."""
    monkeypatch.setenv("SECRET_SIGNING_KEY", SIGNING_KEY)
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def svc():
    settings = Settings().model_copy(update={"data_dir": Path(tempfile.mkdtemp(prefix="fh-test-")),
                                             "page_size": 2, "embed_dim": 64})
    s = Services(settings=settings)
    s._llm = FakeLLM()
    s._embedder = FakeEmbedder(64)
    return s


def about(name: str, headline: str, skills: str, location: str | None = None) -> str:
    """skills: "AI agents, Python"."""
    lines = [f"Name: {name}", f"Headline: {headline}"] + ([f"Location: {location}"] if location else [])
    return "\n".join(lines + [f"Skill: {s.strip()}" for s in skills.split(",") if s.strip()]) + "\n"
