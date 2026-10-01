"""search_candidates, record_feedback, delete_candidate, auth middleware, tool annotations."""

import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from recruiter_mcp import candidates as cand
from recruiter_mcp import match as matching
from recruiter_mcp.auth import BearerAuthMiddleware
from recruiter_mcp.errors import ToolFailure
from recruiter_mcp.ingest import ingest_resume
from recruiter_mcp.models import SearchFilters
from recruiter_mcp.search import search_candidates, skills_in_query
from recruiter_mcp.skills import SkillNormalizer, load_seed

from .conftest import FIXTURES, fixture_text, job_fixture

N = SkillNormalizer(load_seed())
BASE_IDS = sorted(p.stem for p in FIXTURES.glob("c*.txt") if not p.stem.endswith("_v2"))


async def ingest_all(svc, with_files=True):
    for fid in BASE_IDS:
        pdf = FIXTURES / f"{fid}.pdf"
        kw = {"file_path": str(pdf)} if with_files and pdf.exists() else {}
        await ingest_resume(svc, resume_text=fixture_text(fid), **kw)
    return {r["name"]: str(r["id"]) for r in await svc.pool.fetch("SELECT id, name FROM candidates")}


# ------------------------------------------------------------------ search


def test_skills_in_query():
    assert skills_in_query("Python devs in Pune with <30 day notice", N) == ["Python"]
    assert skills_in_query("react native and k8s people", N) == ["React Native", "Kubernetes"]
    assert skills_in_query("node js, postgres, Amazon Web Services", N) == ["Node.js", "PostgreSQL", "AWS"]
    assert skills_in_query("friendly people", N) == []


async def test_search_ranks_query_skills_first_and_applies_filters(svc):
    await ingest_all(svc)
    res = await search_candidates(svc, "Python backend developers", SearchFilters(locations=["Pune"]), 20)
    names = [c.name for c in res.candidates]
    assert res.query_skills == ["Python"]
    # Pune-area and Remote only; Python holders before anyone without Python.
    assert set(names) <= {"Priya Sharma", "Rohan Das", "Aditya Verma", "Tanvi Patil", "Sara Khan"}
    assert "Sara Khan" in names  # include_remote defaults to true
    with_python = [c for c in res.candidates if "Python" in c.matched_skills]
    assert res.candidates[: len(with_python)] == with_python
    assert {"Priya Sharma", "Rohan Das", "Tanvi Patil"} <= {c.name for c in with_python}
    assert res.total_matching == len(names)
    assert all(c.similarity is not None for c in res.candidates)

    res = await search_candidates(svc, "Python", SearchFilters(locations=["Pune"], include_remote=False,
                                                               max_notice_days=30, min_years=3), 20)
    assert "Sara Khan" not in {c.name for c in res.candidates}  # remote excluded
    assert "Rohan Das" not in {c.name for c in res.candidates}  # 2.25 years
    assert "Aditya Verma" not in {c.name for c in res.candidates}  # 60-day notice


async def test_search_required_skills_and_no_query(svc):
    await ingest_all(svc)
    res = await search_candidates(svc, None, SearchFilters(skills=["k8s", "terraform"]), 20)
    assert {c.name for c in res.candidates} == {"Aditya Verma", "Farah Ali"}
    assert res.query_skills == [] and all(c.similarity is None for c in res.candidates)
    assert res.candidates[0].headline and res.candidates[0].top_skills

    everyone = await search_candidates(svc, "", None, 100)
    assert everyone.total_matching == 20 and len(everyone.candidates) == 20
    with pytest.raises(ToolFailure):
        await search_candidates(svc, "x", None, 0)


# ------------------------------------------------------------------ feedback


async def test_record_feedback(svc):
    ids = await ingest_all(svc)
    res = await matching.match_job(svc, jd_text=job_fixture("j1_senior_backend")["jd_text"])
    top = res.candidates[0].candidate_id

    fb = await matching.record_feedback(svc, res.job_id, top, "shortlisted", "strong payments background")
    assert fb.in_match_results and fb.previous_label is None
    fb = await matching.record_feedback(svc, res.job_id, top, "interviewed")
    assert fb.previous_label == "shortlisted"

    # A candidate the recruiter found elsewhere: Rohan (2 yrs) is filtered out of this 5-8 yr job.
    outsider = ids["Rohan Das"]
    fb = await matching.record_feedback(svc, res.job_id, outsider, "rejected")
    assert not fb.in_match_results
    row = await svc.pool.fetchrow("SELECT score, rank, feedback_label FROM matches WHERE job_id=$1::uuid "
                                  "AND candidate_id=$2::uuid", res.job_id, outsider)
    assert row["score"] is None and row["rank"] is None and row["feedback_label"] == "rejected"

    again = await matching.get_job(svc, res.job_id)
    assert again.candidates[0].feedback_label == "interviewed"
    assert (await matching.list_jobs(svc)).jobs[0].feedback_count == 2

    for args, code in [
        (("nope", top), "invalid_input"),
        (("00000000-0000-0000-0000-000000000000", top), "not_found"),
        ((res.job_id, "00000000-0000-0000-0000-000000000000"), "not_found"),
    ]:
        with pytest.raises(ToolFailure) as e:
            await matching.record_feedback(svc, *args, "placed")
        assert e.value.code == code


# ------------------------------------------------------------------ delete


async def test_delete_candidate_removes_everything(svc):
    await ingest_all(svc)
    v2 = FIXTURES / "c01_priya_sharma_v2.pdf"
    upd = await ingest_resume(svc, resume_text=fixture_text("c01_priya_sharma_v2"), file_path=str(v2))
    assert upd.status == "updated"
    cid = upd.candidate_id
    res = await matching.match_job(svc, jd_text=job_fixture("j1_senior_backend")["jd_text"])
    assert cid in {c.candidate_id for c in res.candidates}
    folder = svc.storage.path(f"resumes/{cid}")
    assert len(list(folder.iterdir())) == 2

    out = await cand.delete_candidate(svc, cid)
    assert (out.deleted, out.versions_deleted, out.matches_deleted, out.files_deleted) == (True, 1, 1, 2)
    assert not folder.exists()
    for table, col in [("candidates", "id"), ("candidate_versions", "candidate_id"), ("matches", "candidate_id")]:
        assert await svc.pool.fetchval(f"SELECT count(*) FROM {table} WHERE {col} = $1::uuid", cid) == 0
    got = await cand.get_candidate(svc, cid, None)
    assert got.status == "not_found"
    # The job survives; its remaining matches are intact.
    assert (await matching.get_job(svc, res.job_id)).candidates

    with pytest.raises(ToolFailure) as e:
        await cand.delete_candidate(svc, cid)
    assert e.value.code == "not_found"


async def test_delete_retry_cleans_leftover_files(svc):
    r = await ingest_resume(svc, resume_text=fixture_text("c04_ananya_iyer"),
                            file_path=str(FIXTURES / "c04_ananya_iyer.pdf"))
    # Simulate a crash after the DB delete committed but before files were removed.
    await svc.pool.execute("DELETE FROM candidates WHERE id = $1::uuid", r.candidate_id)
    out = await cand.delete_candidate(svc, r.candidate_id)
    assert out.deleted and out.files_deleted == 1
    assert not svc.storage.path(f"resumes/{r.candidate_id}").exists()


# ------------------------------------------------------------------ auth


def _auth_client(token="secret"):
    app = Starlette(routes=[Route("/mcp", lambda r: PlainTextResponse("ok"), methods=["GET", "POST"]),
                            Route("/healthz", lambda r: PlainTextResponse("healthy"))])
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=BearerAuthMiddleware(app, token)),
                             base_url="http://test")


async def test_bearer_auth():
    async with _auth_client() as c:
        assert (await c.post("/mcp")).status_code == 401
        assert (await c.post("/mcp", headers={"Authorization": "Bearer wrong"})).status_code == 401
        assert (await c.post("/mcp", headers={"Authorization": "secret"})).status_code == 401
        r = await c.post("/mcp", headers={"Authorization": "Bearer secret"})
        assert r.status_code == 200 and r.text == "ok"
        assert (await c.get("/healthz")).status_code == 200
        body = (await c.post("/mcp")).json()
        assert body["error"]["code"] == "unauthorized"


def test_http_app_requires_token(monkeypatch):
    from recruiter_mcp import server
    from recruiter_mcp.config import Settings

    monkeypatch.setattr(server, "get_settings", lambda: Settings(mcp_auth_token=""))
    with pytest.raises(SystemExit):
        server.build_http_app()


# ------------------------------------------------------------------ MCP layer


@asynccontextmanager
async def mcp_client(svc):
    from mcp import Client

    from recruiter_mcp import server

    async with Client(server.mcp) as c:
        server._services._llm = svc.llm
        server._services._embedder = svc.embedder
        server._services.storage = svc.storage
        yield c


async def test_supporting_tools_over_mcp(svc):
    ids = await ingest_all(svc)
    async with mcp_client(svc) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        assert {"search_candidates", "record_feedback", "delete_candidate"} <= tools.keys()
        assert tools["delete_candidate"].annotations.destructive_hint is True
        assert tools["search_candidates"].annotations.read_only_hint is True
        assert tools["ingest_resume"].annotations.idempotent_hint is True

        res = await client.call_tool("search_candidates", {"query": "react typescript",
                                                           "filters": {"locations": ["Mumbai"]}, "limit": 3})
        assert not res.is_error and res.structured_content["candidates"][0]["name"] in {
            "Ananya Iyer", "Meera Joshi", "Kabir Shah"}

        m = await client.call_tool("match_job", {"jd_text": job_fixture("j5_finance_manager")["jd_text"]})
        job_id = m.structured_content["job_id"]
        top = m.structured_content["candidates"][0]["candidate_id"]
        fb = await client.call_tool("record_feedback", {"job_id": job_id, "candidate_id": top, "label": "placed"})
        assert fb.structured_content["label"] == "placed"
        bad = await client.call_tool("record_feedback", {"job_id": job_id, "candidate_id": top, "label": "maybe"})
        assert bad.is_error

        d = await client.call_tool("delete_candidate", {"candidate_id": ids["Divya Menon"]})
        assert d.structured_content["deleted"] is True
        d = await client.call_tool("delete_candidate", {"candidate_id": ids["Divya Menon"]})
        assert d.is_error and json.loads(d.content[0].text)["error"]["code"] == "not_found"

        tools_logged = {r["tool"] for r in await svc.pool.fetch("SELECT DISTINCT tool FROM usage")}
        assert "match_job" in tools_logged


async def test_crash_logs_exclude_exception_message(svc, caplog):
    async with mcp_client(svc) as client:
        from recruiter_mcp import server

        async def boom(*a, **k):
            raise RuntimeError("priya.sharma@example.com leaked")

        server._services._llm.structured = boom
        with caplog.at_level("INFO"):
            res = await client.call_tool("ingest_resume", {"resume_text": fixture_text("c03_neha_kulkarni")})
    assert json.loads(res.content[0].text)["error"]["code"] == "internal_error"
    assert "RuntimeError" in caplog.text and "priya.sharma@example.com" not in caplog.text


async def test_ingest_by_upload_id(svc):
    from recruiter_mcp.ingest import save_upload, upload_key

    pdf = (FIXTURES / "c04_ananya_iyer.pdf").read_bytes()
    up = save_upload(svc, pdf)
    assert svc.storage.exists(upload_key(up.sha256))
    res = await ingest_resume(svc, resume_text=fixture_text("c04_ananya_iyer"), upload_id=up.sha256)
    got = await cand.get_resume_file(svc, res.candidate_id, None)
    assert got.status == "found" and Path(got.path).read_bytes() == pdf
    assert not svc.storage.exists(upload_key(up.sha256))  # claimed and cleaned up

    for bad in ("../../etc/passwd", "0" * 64):
        with pytest.raises(ToolFailure) as e:
            await ingest_resume(svc, resume_text=fixture_text("c04_ananya_iyer"), upload_id=bad)
        assert e.value.code == "file_not_found" and "Do not look for, read or encode" in e.value.message
    with pytest.raises(ToolFailure) as e:
        save_upload(svc, b"PK not a pdf")
    assert e.value.code == "invalid_input"


def test_resume_file_names_are_readable():
    from recruiter_mcp.storage import LocalStorage

    sha = "56a1c733" + "0" * 56
    assert LocalStorage.resume_key("cid", sha, "pdf", "Dhairya Shah") == "resumes/cid/Dhairya_Shah_Resume_56a1c733.pdf"
    assert LocalStorage.resume_key("cid", sha, "pdf", "José O'Brien-Núñez") == \
        "resumes/cid/Jose_O_Brien_Nunez_Resume_56a1c733.pdf"
    assert LocalStorage.resume_key("cid", sha, "pdf", None) == "resumes/cid/Candidate_Resume_56a1c733.pdf"
    assert LocalStorage.resume_key("cid", sha, "pdf", "../../etc") == "resumes/cid/etc_Resume_56a1c733.pdf"
