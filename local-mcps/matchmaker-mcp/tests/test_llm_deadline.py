"""A stalled provider must not hang a tool call: OpenRouter's keep-alive bytes defeat the client's read timeout."""

import asyncio
import time

import pytest

from recruiter_mcp.config import get_settings
from recruiter_mcp.embeddings import OpenRouterEmbedder
from recruiter_mcp.errors import ToolFailure
from recruiter_mcp.llm import OpenRouterLLM
from recruiter_mcp.models import JobRequirements


async def _hang(*args, **kwargs):
    await asyncio.sleep(3600)


class _Stalled:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": type("C", (), {"create": staticmethod(_hang)})()})()
        self.embeddings = type("E", (), {"create": staticmethod(_hang)})()


@pytest.fixture
def settings():
    return get_settings().model_copy(update={"llm_api_key": "k", "embed_api_key": "k", "llm_timeout_seconds": 0.05,
                                             "embed_timeout_seconds": 0.05})


async def test_llm_call_has_a_hard_deadline(settings):
    llm = OpenRouterLLM(settings)
    llm.client = _Stalled()
    t0 = time.monotonic()
    with pytest.raises(ToolFailure) as e:
        await llm.structured("s", "u", JobRequirements, name="job_requirements")
    assert e.value.code == "llm_unavailable" and time.monotonic() - t0 < 1


async def test_embedding_call_has_a_hard_deadline(settings):
    emb = OpenRouterEmbedder(settings)
    emb.client = _Stalled()
    with pytest.raises(ToolFailure) as e:
        await emb.embed(["x"])
    assert e.value.code == "llm_unavailable"
