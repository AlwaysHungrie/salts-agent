"""Real OpenRouter calls. Skipped unless LLM_API_KEY is set (env or .env). Costs well under $0.01."""

import pytest

from recruiter_mcp.config import Settings
from recruiter_mcp.ingest import ingest_resume

from .conftest import FIXTURES, fixture_text


@pytest.fixture
async def live_svc(svc, live_key):
    svc.settings = Settings(llm_api_key=live_key, embed_api_key=Settings().embed_api_key or live_key)
    svc._llm = None
    svc._embedder = None
    return svc


async def test_live_extraction_matches_fixture(live_svc):
    res = await ingest_resume(
        live_svc,
        resume_text=fixture_text("c19_karan_malhotra"),
        file_path=None,
    )
    assert res.status == "created"
    assert res.name == "Karan Malhotra"
    assert res.location and "Gurugram" in res.location
    # 2018-07..present with overlaps merged.
    assert res.years_exp is not None and res.years_exp >= 8.0
    row = await live_svc.pool.fetchrow("SELECT email, phone_key, skills FROM candidates")
    assert row["email"] == "karan.m@example.com" and row["phone_key"] == "9876000001"
    assert {"Node.js", "TypeScript", "AWS"} <= set(row["skills"])
    usage = await live_svc.pool.fetch("SELECT kind FROM usage")
    assert usage == [] or {u["kind"] for u in usage} <= {"llm", "embedding"}


def test_fixture_count():
    assert len(list(FIXTURES.glob("*.txt"))) == 22


async def test_live_vision_transcribes_pdf(live_key):
    from recruiter_mcp.llm import OpenRouterVision

    vision = OpenRouterVision(Settings(llm_api_key=live_key))
    pdf = FIXTURES / "c07_vikram_rao.pdf"
    text = await vision.transcribe(pdf.read_bytes(), "application/pdf", pdf.name)
    assert "Vikram Rao" in text or "VIKRAM RAO" in text
    assert "vikram.rao@example.com" in text and "HealthAI" in text and "2019" in text
    assert not text.startswith("```")
