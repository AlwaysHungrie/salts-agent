"""Folder ingest: PDF discovery, skip-unchanged by path/size/mtime, resume-on-failure, retries, MCP tools."""

import asyncio
import os
import shutil
from pathlib import Path

import pytest

from recruiter_mcp.bulk import bulk_ingest, find_files, scan

from .conftest import FIXTURES
from .test_ingest_integration import mcp_client


class FakeTranscriber:
    """Returns the fixture transcript for a fixture PDF; fails on demand."""

    def __init__(self, fail: set[str] | None = None) -> None:
        self.fail = fail or set()
        self.calls: list[str] = []

    async def __call__(self, data: bytes, mime: str, filename: str) -> str:
        self.calls.append(filename)
        if filename in self.fail:
            raise RuntimeError("provider 502")
        if filename == "blank.pdf":
            return "  "
        return (FIXTURES / Path(filename).with_suffix(".txt").name).read_text(encoding="utf-8")


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "pile"
    (d / "2023").mkdir(parents=True)
    for fid in ("c01_priya_sharma", "c04_ananya_iyer", "c07_vikram_rao"):
        shutil.copy(FIXTURES / f"{fid}.pdf", d)
    shutil.copy(FIXTURES / "c11_rajesh_gupta.pdf", d / "2023")
    shutil.copy(FIXTURES / "c02_arjun_mehta.txt", d)
    (d / "c03_neha_kulkarni.docx").write_bytes(b"PK not a pdf")
    (d / "broken.pdf").write_bytes(b"%PDF-1.4 not really")
    (d / "blank.pdf").write_bytes(b"%PDF-1.4 blank")
    (d / "notes.exe").write_bytes(b"MZ")
    (d / ".hidden.pdf").write_bytes(b"%PDF")
    return d


def names(files):
    return sorted(f.name for f in files)


def test_find_files_pdf_only(folder):
    (folder / "UPPER.PDF").write_bytes(b"%PDF")
    assert names(find_files(folder)) == [
        "UPPER.PDF", "blank.pdf", "broken.pdf", "c01_priya_sharma.pdf", "c04_ananya_iyer.pdf",
        "c07_vikram_rao.pdf", "c11_rajesh_gupta.pdf"]
    assert "c11_rajesh_gupta.pdf" not in names(find_files(folder, recursive=False))
    assert all(f.is_absolute() for f in find_files(folder))


async def test_bulk_ingest_skips_unchanged_and_retries(svc, folder):
    files = find_files(folder)
    t1 = FakeTranscriber(fail={"broken.pdf"})
    seen = []
    r1 = await bulk_ingest(svc, files, t1, concurrency=3, max_attempts=2,
                           on_result=lambda d, n, r: seen.append((d, n)))
    by = {Path(r.path).name: r for r in r1.results}
    assert r1.counts["created"] == 4
    assert by["broken.pdf"].status == "failed" and "RuntimeError" in by["broken.pdf"].error
    assert by["blank.pdf"].status == "failed" and by["blank.pdf"].error.startswith("empty_transcript")
    assert len(seen) == 6 and seen[-1] == (6, 6)
    row = await svc.pool.fetchrow("SELECT file_key, file_mime, source FROM candidates WHERE name='Priya Sharma'")
    assert row["file_key"].endswith(".pdf") and row["file_mime"] == "application/pdf" and row["source"] == "other"
    assert await svc.pool.fetchval("SELECT count(*) FROM source_files") == 6

    # Re-run: done files skipped by path/size/mtime without being read; failures retried.
    t2 = FakeTranscriber(fail={"broken.pdf"})
    r2 = await bulk_ingest(svc, files, t2, max_attempts=2)
    assert r2.counts["unchanged"] == 4 and r2.counts["failed"] == 2
    assert sorted(t2.calls) == ["blank.pdf", "broken.pdf"]
    assert {r.attempts for r in r2.results if r.status == "failed"} == {2}

    # Third run: gave up on files that hit max_attempts; nothing is called.
    t3 = FakeTranscriber()
    r3 = await bulk_ingest(svc, files, t3, max_attempts=2)
    assert r3.counts["gave_up"] == 2 and t3.calls == []
    assert all("gave up" in r.error for r in r3.results if r.status == "gave_up")

    # Editing a given-up file resets its attempts.
    broken = folder / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4 fixed now")
    os.utime(broken, ns=(broken.stat().st_atime_ns, broken.stat().st_mtime_ns + 10**9))
    r4 = await bulk_ingest(svc, [broken], _as("c05_kabir_shah.pdf", FakeTranscriber()), max_attempts=2)
    assert r4.results[0].status == "created" and r4.results[0].attempts == 1

    # A renamed copy is caught by hash before any model call, then remembered by path.
    copy = folder / "2023" / "priya_renamed.pdf"
    shutil.copy(folder / "c01_priya_sharma.pdf", copy)
    t5 = FakeTranscriber()
    r5 = await bulk_ingest(svc, [copy.resolve()], t5)
    assert r5.results[0].status == "duplicate_file" and t5.calls == []
    assert (await scan(svc, [copy.resolve()])).skipped[0].status == "unchanged"

    # A newer resume for someone already in the pile updates them.
    shutil.copy(FIXTURES / "c01_priya_sharma_v2.pdf", folder)
    r6 = await bulk_ingest(svc, [(folder / "c01_priya_sharma_v2.pdf").resolve()], FakeTranscriber())
    assert r6.results[0].status == "updated"


def _as(fixture_name: str, inner: FakeTranscriber):
    """Transcriber that answers with a given fixture regardless of the file's name."""

    async def call(data, mime, filename):
        return await inner(data, mime, fixture_name)

    return call


async def test_bulk_skips_oversized_files(svc, folder):
    svc.settings = svc.settings.model_copy(update={"max_file_bytes": 100})
    r = await bulk_ingest(svc, [(folder / "c01_priya_sharma.pdf").resolve()], FakeTranscriber())
    assert r.results[0].status == "failed" and r.results[0].error.startswith("file_too_large")


async def test_deleting_candidate_forgets_their_files(svc, folder):
    from recruiter_mcp import candidates as cand

    f = (folder / "c04_ananya_iyer.pdf").resolve()
    r = await bulk_ingest(svc, [f], FakeTranscriber())
    await cand.delete_candidate(svc, r.results[0].candidate_id)
    assert await svc.pool.fetchval("SELECT count(*) FROM source_files") == 0


async def test_bulk_inbox_flow_over_mcp(svc, folder):
    async with mcp_client(svc) as client:
        from recruiter_mcp import server

        server._services.settings = svc.settings.model_copy(update={"inbox_dir": folder})
        server._services._vision = type("V", (), {"transcribe": FakeTranscriber()})()
        schema = {t.name: t.input_schema for t in (await client.list_tools()).tools}
        assert "folder_path" not in schema["ingest_folder"].get("properties", {})

        info = (await client.call_tool("get_bulk_ingest_folder", {})).structured_content
        assert info["folder"] == str(folder.resolve()) and info["to_process"] == 6
        assert str(folder.resolve()) in info["message_for_user"] and "go ahead" in info["message_for_user"]
        assert await svc.pool.fetchval("SELECT count(*) FROM candidates") == 0  # looking is free

        started = await client.call_tool("ingest_folder", {})
        assert started.structured_content["status"] == "started"
        run_id = started.structured_content["run_id"]
        for _ in range(100):
            st = (await client.call_tool("get_folder_ingest_status", {"run_id": run_id})).structured_content
            if st["state"] != "running":
                break
            await asyncio.sleep(0.05)
        assert st["state"] == "finished" and st["processed"] == 6
        assert st["counts"] == {"created": 4, "failed": 2}
        assert {Path(f["path"]).name for f in st["failures"]} == {"blank.pdf", "broken.pdf"}

        again = await client.call_tool("ingest_folder", {})
        assert again.structured_content["already_ingested"] == 4
        assert again.structured_content["to_process"] == 2  # failures retried

        cid = (await svc.pool.fetchval("SELECT id::text FROM candidates WHERE name='Priya Sharma'"))
        got = await client.call_tool("get_candidate", {"candidate_id": cid})
        path = Path(got.structured_content["candidate"]["resume_file"]["path"])
        assert path.is_absolute() and path.read_bytes() == (FIXTURES / "c01_priya_sharma.pdf").read_bytes()


def test_inbox_defaults_under_data_dir(svc, tmp_path):
    from recruiter_mcp.bulk import inbox_dir

    p = inbox_dir(svc.settings.model_copy(update={"data_dir": tmp_path, "inbox_dir": None}))
    assert p == (tmp_path / "inbox").resolve() and p.is_dir()
