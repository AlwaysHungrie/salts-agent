import json
from types import SimpleNamespace

import pytest

from matchmaker import server
from matchmaker.errors import ToolFailure
from matchmaker.uploads import save_upload, upload_path

from .conftest import resume

KEY = {"X-OpenRouter-Api-Key": "sk-caller"}


@pytest.fixture
def mm(svc, monkeypatch):
    monkeypatch.setattr(server, "_services", svc)
    return svc


def ctx(headers=KEY):
    return SimpleNamespace(headers=headers)


def error(result):
    assert result.is_error
    return json.loads(result.content[0].text)["error"]["code"]


def test_uploads_are_typed_from_their_bytes(svc):
    import io

    import docx

    buf = io.BytesIO()
    docx.Document().save(buf)
    assert save_upload(svc.settings, b"%PDF-1.7 ...")[1] == "pdf"
    assert save_upload(svc.settings, buf.getvalue())[1] == "docx"
    uid, kind = save_upload(svc.settings, "Name: Asha\nSkill: Go\n".encode())
    assert kind == "txt" and upload_path(svc.settings, uid).name == f"{uid}.txt"
    for data, code in [(b"", "empty_file"), (b"PK\x03\x04junk", "unsupported_file"),
                       (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "unsupported_file"), (b"\x00\x01bin", "unsupported_file")]:
        with pytest.raises(ToolFailure) as e:
            save_upload(svc.settings, data)
        assert e.value.code == code
    for bad, code in [("../../etc/passwd", "bad_upload_id"), ("a" * 64, "upload_not_found")]:
        with pytest.raises(ToolFailure) as e:
            upload_path(svc.settings, bad)
        assert e.value.code == code


async def test_an_attachment_becomes_a_person_and_a_judged_match(mm):
    uid, _ = save_upload(mm.settings, resume("Asha Rao", "Backend engineer", "Python, Django",
                                             extra="Core: yes\nRole: yes\nMusts: yes,yes,yes").encode())
    added = await server.add_document(kind="resume", upload_id=uid, ctx=ctx())
    assert added.status == "created" and added.name == "Asha Rao"
    folder = mm.settings.data_dir / "people" / added.person_id
    assert (folder / "resume.txt").is_file() and (folder / "resume.txt").read_text().startswith("Name: Asha")
    await server.add_document(kind="resume", text=resume("Cy D", "Accountant", "GST, Tally"), ctx=ctx())

    job = await server.post_job(text="Backend engineer, Python and Django", ctx=ctx())
    assert [j.job_id for j in await server.list_jobs()] == [job.job_id]
    page = await server.find_candidates(job_id=job.job_id, query="python django backend", ctx=ctx())
    assert page.total == 2 and page.must_haves == ["Services in production", "Python", "Postgres"]
    top = page.matches[0]
    assert top.name == "Asha Rao" and top.score is not None and top.core_work == "yes" and top.location == "Pune"
    assert top.must_haves == {"Services in production": "yes", "Python": "yes", "Postgres": "yes"}
    assert [m.position for m in page.matches] == [1, 2]

    browse = await server.search_people(query="accountant gst", ctx=ctx())
    assert browse.matches[0].name == "Cy D" and browse.matches[0].score is None
    person = await server.get_person(person_id=added.person_id)
    assert person.email == "asha@example.com"
    assert (await server.ping()).people == 2


async def test_failures_come_back_as_codes(mm):
    assert error(await server.add_document(kind="resume", ctx=ctx())) == "missing_file"
    assert error(await server.add_document(kind="resume", upload_id="b" * 64, ctx=ctx())) == "upload_not_found"
    assert error(await server.get_person(person_id="nope")) == "invalid_input"
    # stdio has no headers, so a paid tool is refused before anything runs
    assert error(await server.add_document(kind="resume", text="x", ctx=None)) == "missing_header"
    capped = ctx(KEY | {"Tool-Call-Max-Charge": "0.01"})  # under a judged page's typical cost
    assert error(await server.find_candidates(job_id="a" * 32, ctx=capped)) == "cost_limit_exceeded"


async def test_a_scanned_file_falls_back_to_the_text_sent_with_it(mm, tmp_path):
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.output(str(tmp_path / "scan.pdf"))
    uid, kind = save_upload(mm.settings, (tmp_path / "scan.pdf").read_bytes())
    assert kind == "pdf"
    assert error(await server.add_document(kind="resume", upload_id=uid, ctx=ctx())) == "invalid_input"
    added = await server.add_document(kind="resume", upload_id=uid, text=resume("Ravi K", "Analyst", "SQL"),
                                      ctx=ctx())
    folder = mm.settings.data_dir / "people" / added.person_id
    assert added.name == "Ravi K" and (folder / "resume.pdf").is_file()  # the original is kept
