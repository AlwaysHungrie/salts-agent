"""Per-request API key, spend caps and provider error mapping."""

import json
import uuid

import httpx
import openai
import pytest

from recruiter_mcp import billing
from recruiter_mcp.billing import begin, end, preflight, provider_failure
from recruiter_mcp.bulk import bulk_ingest, find_files
from recruiter_mcp.errors import ToolFailure
from recruiter_mcp.llm import OpenRouterLLM

from .conftest import FIXTURES, fixture_text, job_fixture
from .test_bulk import FakeTranscriber
from .test_ingest_integration import mcp_client


def _status_error(cls, code: int, message: str):
    response = httpx.Response(code, request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"))
    return cls(message, response=response, body={"message": message, "code": code})


def test_headers_set_key_and_cap_case_insensitively(svc):
    tokens = begin("ingest_resume", {"X-OpenRouter-Api-Key": "sk-or-abc",
                                     "X-Cost-Approved-Resume-Ingestion": "$0.0005"}, svc.settings)
    try:
        assert billing.current_api_key() == "sk-or-abc"
        assert billing.current_budget().approved_usd == 0.0005
    finally:
        end(tokens)
    assert billing.current_api_key() is None and billing.current_budget() is None


def test_settings_cap_used_without_headers_and_bad_values_rejected(svc):
    settings = svc.settings.model_copy(update={"cost_approved_job_match": 0.05})
    tokens = begin("match_job", None, settings)
    assert billing.current_budget().approved_usd == 0.05
    end(tokens)
    for bad in ("abc", "-1", "nan"):
        with pytest.raises(ToolFailure) as e:
            begin("match_job", {"x-openrouter-api-key": "k", "x-cost-approved-job-match": bad}, settings)
        assert e.value.code == "invalid_input"


def test_http_requires_key_and_cap_headers(svc):
    # .env values are not a fallback over HTTP.
    settings = svc.settings.model_copy(update={"cost_approved_job_match": 0.05, "llm_api_key": "env-key"})
    for headers, missing in [({}, ["x-openrouter-api-key", "x-cost-approved-job-match"]),
                             ({"x-openrouter-api-key": "k"}, ["x-cost-approved-job-match"]),
                             ({"x-cost-approved-job-match": "0.05"}, ["x-openrouter-api-key"])]:
        with pytest.raises(ToolFailure) as e:
            begin("match_job", headers, settings)
        assert e.value.code == "missing_header" and all(m in e.value.message for m in missing)
    assert billing.current_api_key() is None and billing.current_budget() is None
    # Tools that never call a model need no headers.
    end(begin("get_candidate", {}, settings))


def test_header_key_gets_its_own_client(svc):
    svc._llm = None
    svc.settings = svc.settings.model_copy(update={"llm_api_key": None})
    tokens = begin("match_job", {"x-openrouter-api-key": "sk-or-from-header",
                                     "x-cost-approved-job-match": "1"}, svc.settings)
    try:
        llm = svc.llm
        assert isinstance(llm, OpenRouterLLM) and llm.client.api_key == "sk-or-from-header"
        assert svc.llm is llm
    finally:
        end(tokens)
    with pytest.raises(ToolFailure) as e:
        svc.llm  # noqa: B018
    assert e.value.code == "config_error" and "X-OpenRouter-Api-Key" in e.value.message


def test_provider_errors_are_explained():
    cases = [
        (openai.AuthenticationError, 401, "invalid_api_key"),
        (openai.APIStatusError, 402, "insufficient_credits"),
        (openai.PermissionDeniedError, 403, "key_forbidden"),
        (openai.RateLimitError, 429, "rate_limited"),
        (openai.InternalServerError, 502, "llm_unavailable"),
    ]
    for cls, code, expected in cases:
        f = provider_failure(_status_error(cls, code, "Insufficient credits" if code == 402 else "nope"))
        assert f.code == expected, code
    credits = provider_failure(_status_error(openai.APIStatusError, 402, "Insufficient credits"))
    assert "Insufficient credits" in credits.message
    assert provider_failure(ValueError("x")) is None


async def _seed_usage(svc, tool: str, cost: float, n: int = 3):
    for _ in range(n):
        await svc.pool.execute(
            "INSERT INTO usage (tool, request_id, kind, model, cost_usd) VALUES ($1, $2, 'llm', 'x', $3)",
            tool, uuid.uuid4(), cost)


async def test_preflight_uses_recent_spend(svc):
    await _seed_usage(svc, "ingest_resume", 0.005)
    tokens = begin("ingest_resume", {"x-openrouter-api-key": "k", "x-cost-approved-resume-ingestion": "0.0005"},
                   svc.settings)
    try:
        with pytest.raises(ToolFailure) as e:
            await preflight(svc.pool, "ingest_resume")
    finally:
        end(tokens)
    assert e.value.code == "cost_limit_exceeded"
    assert "$0.0050" in e.value.message and "$0.0005" in e.value.message and "last 3 runs" in e.value.message


async def test_resume_over_cap_rejected_before_any_model_call(svc):
    svc.settings = svc.settings.model_copy(update={"cost_approved_resume_ingestion": 0.0005})
    async with mcp_client(svc) as client:
        from recruiter_mcp import server

        server._services.settings = svc.settings
        calls = svc.llm.calls
        res = await client.call_tool("ingest_resume", {"resume_text": fixture_text("c01_priya_sharma")})
        assert res.is_error
        err = json.loads(res.content[0].text)["error"]
        assert err["code"] == "cost_limit_exceeded" and "not started" in err["message"]
        assert svc.llm.calls == calls
        assert await svc.pool.fetchval("SELECT count(*) FROM candidates") == 0


async def test_match_stops_when_actual_spend_reaches_cap(svc):
    from .test_match import ingest_all

    await ingest_all(svc)
    await _seed_usage(svc, "match_job", 0.0001)  # history says cheap, so preflight passes
    svc.settings = svc.settings.model_copy(update={"cost_approved_job_match": 0.0005})
    before = svc.llm.calls
    async with mcp_client(svc) as client:
        from recruiter_mcp import server

        server._services.settings = svc.settings
        res = await client.call_tool("match_job", {"jd_text": job_fixture("j1_senior_backend")["jd_text"]})
        assert res.is_error
        err = json.loads(res.content[0].text)["error"]
        assert err["code"] == "cost_limit_exceeded" and "stopped" in err["message"]
    # $0.0001 per fake call: parse + 4 rerank calls reach the cap; nothing after that starts.
    assert svc.llm.calls - before == 5


async def test_folder_run_stops_on_bad_key_without_burning_attempts(svc, tmp_path):
    folder = tmp_path / "pile"
    folder.mkdir()
    for fid in ("c01_priya_sharma", "c04_ananya_iyer", "c07_vikram_rao"):
        (folder / f"{fid}.pdf").write_bytes((FIXTURES / f"{fid}.pdf").read_bytes())

    async def bad_key(data, mime, filename):
        raise _status_error(openai.AuthenticationError, 401, "User not found.")

    r = await bulk_ingest(svc, find_files(folder), bad_key, concurrency=1)
    assert r.counts["stopped"] == 3 and r.stopped_reason.startswith("invalid_api_key")
    assert await svc.pool.fetchval("SELECT count(*) FROM source_files") == 0

    # Fixed key: everything goes through on the next run.
    r2 = await bulk_ingest(svc, find_files(folder), FakeTranscriber())
    assert r2.counts["created"] == 3


async def test_folder_cap(svc, tmp_path):
    folder = tmp_path / "pile"
    folder.mkdir()
    for fid in ("c01_priya_sharma", "c04_ananya_iyer", "c07_vikram_rao"):
        (folder / f"{fid}.pdf").write_bytes((FIXTURES / f"{fid}.pdf").read_bytes())
    svc.settings = svc.settings.model_copy(update={"cost_approved_folder_ingestion": 0.001})
    async with mcp_client(svc) as client:
        from recruiter_mcp import server

        server._services.settings = svc.settings
        server._services.settings = svc.settings.model_copy(update={"inbox_dir": folder})
        server._services._vision = type("V", (), {"transcribe": FakeTranscriber()})()
        res = await client.call_tool("ingest_folder", {})
        err = json.loads(res.content[0].text)["error"]
        assert res.is_error and err["code"] == "cost_limit_exceeded"
        assert "3 files" in err["message"]
    assert await svc.pool.fetchval("SELECT count(*) FROM candidates") == 0
