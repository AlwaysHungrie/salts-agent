"""Ingest -> get_candidate on the fixture resumes, against a real Postgres, with fake LLM/embedder."""

import json
from contextlib import asynccontextmanager
from pathlib import Path

from recruiter_mcp import candidates as cand
from recruiter_mcp.ingest import ingest_resume
from recruiter_mcp.usage import track_usage

from .conftest import FIXTURES, fixture_text

BASE_IDS = sorted(p.stem for p in FIXTURES.glob("c*.txt") if not p.stem.endswith("_v2"))


async def ingest_fixture(svc, fid, *, with_file=True):
    pdf = FIXTURES / f"{fid}.pdf"
    kwargs = {"file_path": str(pdf)} if with_file and pdf.exists() else {}
    return await ingest_resume(svc, resume_text=fixture_text(fid), source="upload", **kwargs)


async def test_ingest_all_fixtures(svc):
    results = {fid: await ingest_fixture(svc, fid) for fid in BASE_IDS}
    assert len(BASE_IDS) == 20
    assert all(r.status == "created" for r in results.values())
    assert await svc.pool.fetchval("SELECT count(*) FROM candidates") == 20

    priya = results["c01_priya_sharma"]
    assert priya.name == "Priya Sharma" and priya.location == "Pune" and priya.notice_days == 30
    assert {"Python", "AWS"} <= set(priya.top_skills)
    assert priya.headline.startswith("Senior Backend Engineer, ")

    # Skill aliases normalized at ingest.
    arjun = await svc.pool.fetchrow("SELECT skills FROM candidates WHERE id=$1::uuid",
                                    results["c02_arjun_mehta"].candidate_id)
    assert "Kubernetes" in arjun["skills"] and "Apache Kafka" in arjun["skills"]
    assert "k8s" not in arjun["skills"]

    # Overlapping roles merged: 2018-07..present.
    karan = results["c19_karan_malhotra"]
    assert karan.years_exp is not None and karan.years_exp >= 8.0

    # Warnings.
    assert "no email found" in results["c06_meera_joshi"].warnings
    assert results["c20_lata_pillai"].years_exp is None
    assert any("years_exp unknown" in w for w in results["c20_lata_pillai"].warnings)
    assert any("no original file" in w for w in results["c02_arjun_mehta"].warnings)
    assert not any("no original file" in w for w in priya.warnings)

    # Original stored at resumes/{id}/{sha}.pdf with the right bytes.
    row = await svc.pool.fetchrow("SELECT * FROM candidates WHERE id=$1::uuid", priya.candidate_id)
    assert row["file_key"] == f"resumes/{priya.candidate_id}/Priya_Sharma_Resume_{row['content_sha256'][:8]}.pdf"
    assert svc.storage.get(row["file_key"]) == (FIXTURES / "c01_priya_sharma.pdf").read_bytes()
    assert row["raw_extraction"] and row["resume_text"].startswith("PRIYA SHARMA")


async def test_same_file_is_duplicate_and_skips_llm(svc):
    first = await ingest_fixture(svc, "c01_priya_sharma")
    calls = svc.llm.calls
    again = await ingest_fixture(svc, "c01_priya_sharma")
    assert again.status == "duplicate_file" and again.candidate_id == first.candidate_id
    assert svc.llm.calls == calls

    # Text-only: identical transcript, even re-spaced, is a duplicate too.
    a = await ingest_fixture(svc, "c02_arjun_mehta")
    b = await ingest_resume(svc, resume_text="  " + fixture_text("c02_arjun_mehta").replace("\n", "\n\n"))
    assert b.status == "duplicate_file" and b.candidate_id == a.candidate_id


async def test_updated_resume_matched_by_email_keeps_history(svc):
    v1 = await ingest_fixture(svc, "c01_priya_sharma")
    v2 = await ingest_fixture(svc, "c01_priya_sharma_v2")
    assert v2.status == "updated" and v2.candidate_id == v1.candidate_id
    assert v2.headline.startswith("Engineering Lead")
    assert await svc.pool.fetchval("SELECT count(*) FROM candidates") == 1

    versions = await svc.pool.fetch("SELECT * FROM candidate_versions WHERE candidate_id=$1::uuid", v1.candidate_id)
    assert len(versions) == 1
    assert json.loads(versions[0]["profile"])["current_title"] == "Senior Backend Engineer"
    # Old file kept for history; new file stored alongside.
    assert svc.storage.exists(versions[0]["file_key"])
    row = await svc.pool.fetchrow("SELECT file_key FROM candidates WHERE id=$1::uuid", v1.candidate_id)
    assert row["file_key"] != versions[0]["file_key"] and svc.storage.exists(row["file_key"])

    # Re-sending the old file does not roll the candidate back.
    old = await ingest_fixture(svc, "c01_priya_sharma")
    assert old.status == "duplicate_file" and old.headline.startswith("Engineering Lead")


async def test_updated_resume_matched_by_phone_when_no_email(svc):
    v1 = await ingest_fixture(svc, "c06_meera_joshi")
    v2 = await ingest_fixture(svc, "c06_meera_joshi_v2")
    assert v2.status == "updated" and v2.candidate_id == v1.candidate_id
    row = await svc.pool.fetchrow("SELECT skills FROM candidates WHERE id=$1::uuid", v1.candidate_id)
    assert "Next.js" in row["skills"]


async def test_usage_is_recorded_per_call(svc):
    async with track_usage(svc.pool, "ingest_resume") as t:
        await ingest_fixture(svc, "c03_neha_kulkarni")
    rows = await svc.pool.fetch("SELECT * FROM usage WHERE request_id=$1", t.request_id)
    assert len(rows) == 1 and rows[0]["tool"] == "ingest_resume" and rows[0]["output_tokens"] == 200


async def test_get_candidate_lookups(svc):
    for fid in BASE_IDS:
        await ingest_fixture(svc, fid)
    priya_id = await svc.pool.fetchval("SELECT id::text FROM candidates WHERE email='priya.sharma@example.com'")

    res = await cand.get_candidate(svc, priya_id, None)
    assert res.status == "found" and res.candidate.name == "Priya Sharma"
    assert res.candidate.resume_file.mime_type == "application/pdf"
    assert Path(res.candidate.resume_file.path).is_absolute()

    res = await cand.get_candidate(svc, None, "PRIYA.SHARMA@example.com")
    assert res.status == "found" and res.candidate.candidate_id == priya_id

    res = await cand.get_candidate(svc, None, "priya sharma")
    assert res.status == "found" and res.candidate.candidate_id == priya_id

    res = await cand.get_candidate(svc, None, "Priya Sharmaa")  # typo -> trigram
    assert res.status == "found" and res.candidate.candidate_id == priya_id

    res = await cand.get_candidate(svc, None, "sh")
    assert res.status == "ambiguous" and len(res.matches) > 1
    assert {m.name for m in res.matches} >= {"Priya Sharma", "Kabir Shah"}

    res = await cand.get_candidate(svc, None, "Nobody Here")
    assert res.status == "not_found"
    res = await cand.get_candidate(svc, "00000000-0000-0000-0000-000000000000", None)
    assert res.status == "not_found"


# ------------------------------------------------------------ MCP layer (in-process client)


@asynccontextmanager
async def mcp_client(svc):
    """In-process MCP client. Not a fixture: anyio needs enter/exit in the same task."""
    from mcp import Client

    from recruiter_mcp import server

    async with Client(server.mcp) as c:
        # Swap in the fakes and the per-test storage after the server lifespan starts.
        server._services._llm = svc.llm
        server._services._embedder = svc.embedder
        server._services.storage = svc.storage
        yield c


async def test_tools_over_mcp_return_paths_not_files(svc):
    async with mcp_client(svc) as client:
        tools = {t.name for t in (await client.list_tools()).tools}
        assert {"ping", "ingest_resume", "get_candidate", "get_bulk_ingest_folder", "ingest_folder",
                "get_folder_ingest_status"} <= tools
        assert (await client.list_resource_templates()).resource_templates == []

        pdf = FIXTURES / "c04_ananya_iyer.pdf"
        res = await client.call_tool(
            "ingest_resume", {"resume_text": fixture_text("c04_ananya_iyer"), "file_path": str(pdf)}
        )
        assert not res.is_error, res.content
        cid = res.structured_content["candidate_id"]
        assert res.structured_content["status"] == "created"

        got = await client.call_tool("get_candidate", {"candidate_id": cid})
        assert got.structured_content["status"] == "found"
        assert [c.type for c in got.content] == ["text"]
        info = got.structured_content["candidate"]["resume_file"]
        assert info["mime_type"] == "application/pdf"
        assert Path(info["path"]).read_bytes() == pdf.read_bytes()

        # Chat attachment: the app uploads it, the model passes upload_id. The model is never offered file_base64.
        from recruiter_mcp.ingest import save_upload

        schema = {t.name: t.input_schema for t in (await client.list_tools()).tools}["ingest_resume"]
        assert "upload_id" in schema["properties"] and "file_base64" not in schema["properties"]
        v1 = FIXTURES / "c01_priya_sharma.pdf"
        up = save_upload(svc, v1.read_bytes())
        res = await client.call_tool("ingest_resume", {
            "resume_text": fixture_text("c01_priya_sharma"), "upload_id": up.sha256})
        assert not res.is_error, res.content
        got = await client.call_tool("get_candidate", {"candidate_id": res.structured_content["candidate_id"]})
        stored = Path(got.structured_content["candidate"]["resume_file"]["path"])
        assert stored.read_bytes() == v1.read_bytes()
        assert stored.name == f"Priya_Sharma_Resume_{up.sha256[:8]}.pdf"

        # "Get me the resume": path and a ready reply, no profile.
        rf = (await client.call_tool("get_resume_file", {"query": "Ananya Iyer"})).structured_content
        assert rf["status"] == "found" and Path(rf["path"]).read_bytes() == pdf.read_bytes()
        assert rf["path"] in rf["message_for_user"] and "on your computer" in rf["message_for_user"]
        assert "profile" not in rf and "email" not in rf

        # Text-only candidate: no file.
        res = await client.call_tool("ingest_resume", {"resume_text": fixture_text("c05_kabir_shah")})
        got = await client.call_tool("get_candidate", {"candidate_id": res.structured_content["candidate_id"]})
        assert "resume_file" not in got.structured_content["candidate"] or \
            got.structured_content["candidate"]["resume_file"] is None
        rf = (await client.call_tool("get_resume_file",
                                     {"candidate_id": res.structured_content["candidate_id"]})).structured_content
        assert rf["status"] == "no_file" and rf["path"] is None and "not stored" in rf["message_for_user"]
        rf = (await client.call_tool("get_resume_file", {"query": "Nobody Here"})).structured_content
        assert rf["status"] == "not_found"


async def test_errors_are_codes_not_tracebacks(svc):
    async with mcp_client(svc) as client:
        res = await client.call_tool("ingest_resume", {"resume_text": "   "})
        assert res.is_error
        body = json.loads(res.content[0].text)
        assert body["error"]["code"] == "invalid_input"

        res = await client.call_tool("get_candidate", {"candidate_id": "not-a-uuid"})
        assert res.is_error and json.loads(res.content[0].text)["error"]["code"] == "invalid_input"

        txt = str(FIXTURES / "c01_priya_sharma.txt")
        res = await client.call_tool("ingest_resume", {"resume_text": "x" * 300, "file_path": txt})
        assert res.is_error and json.loads(res.content[0].text)["error"]["code"] == "unsupported_file_type"
