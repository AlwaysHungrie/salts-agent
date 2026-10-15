import csv
import io
import json
import zipfile
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from matchmaker import bulk, exports, links, server

from .conftest import resume

TOKEN = "s" * 64
TUNNEL = {"X-OpenRouter-Api-Key": "sk-caller", "X-Forwarded-Host": "abc.trycloudflare.com",
          "X-Forwarded-Proto": "https", "X-Forwarded-Prefix": "/matchmaker"}


@pytest.fixture
def mm(svc, monkeypatch):
    svc.settings = svc.settings.model_copy(update={"mcp_auth_token": TOKEN})
    monkeypatch.setattr(server, "_services", svc)
    monkeypatch.setattr(server, "_runs", bulk.Runs())
    monkeypatch.setattr(server, "_reset_codes", exports.ResetCodes())
    monkeypatch.setattr(server, "get_settings", lambda: svc.settings)
    return svc


def ctx(headers=TUNNEL):
    return SimpleNamespace(headers=headers)


def path_of(url: str) -> str:
    return url.removeprefix("https://abc.trycloudflare.com/matchmaker")


def rows(z: zipfile.ZipFile, name: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(z.read(name).decode("utf-8-sig"))))


async def fill(mm) -> tuple[str, str]:
    a = await server.add_document(kind="resume", text=resume("Asha Rao", "Backend engineer", "Python, Django"),
                                  ctx=ctx())
    await server.add_note(person_id=a.person_id, text="Open to Berlin", ctx=ctx())
    await server.add_document(kind="resume", text=resume("Bo Chen", "Designer", "Figma"), ctx=ctx())
    job = await server.post_job(text="Backend engineer\nPython and Django", ctx=ctx())
    return a.person_id, job.job_id


async def test_people_and_jobs_export_as_a_download(mm):
    asha, job_id = await fill(mm)
    browser = TestClient(server.build_http_app())

    got = await server.export_people(ctx=ctx())
    assert got.count == 2 and got.url.startswith("https://abc.trycloudflare.com/matchmaker/share/export-")
    assert got.url in got.message_for_user
    res = browser.get(path_of(got.url))
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    assert "attachment" in res.headers["content-disposition"] and "matchmaker-people-" in res.headers[
        "content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(res.content))
    people = {r["name"]: r for r in rows(z, "people.csv")}
    assert set(people) == {"Asha Rao", "Bo Chen"}
    assert people["Asha Rao"]["email"] == "asha@example.com" and people["Asha Rao"]["skills"] == "Python; Django"
    folder = people["Asha Rao"]["folder_in_zip"]
    assert folder == f"people/Asha_Rao_{asha[:8]}"
    assert {n.removeprefix(folder + "/") for n in z.namelist() if n.startswith(folder)} == {
        "resume.txt", "notes.txt", "profile.md"}
    assert not any(n.endswith(("person.json", "embedding.npy")) for n in z.namelist())

    jobs = await server.export_jobs(ctx=ctx())
    z = zipfile.ZipFile(io.BytesIO(browser.get(path_of(jobs.url)).content))
    [row] = rows(z, "jobs.csv")
    assert row["job_id"] == job_id and row["title"] == "Backend engineer"
    assert z.read(f"{row['folder_in_zip']}/job.md").decode().startswith("Backend engineer")

    token = path_of(got.url).removeprefix("/share/")
    kind, export_id = links.read_token(mm.settings, token)
    assert kind == links.EXPORT
    forged = links.make_token(mm.settings, links.EXPORT, "f" * 32)[0]
    assert browser.get(f"/share/{forged}").status_code == 404  # signed, but no such export


async def test_export_without_the_tunnel_gives_the_path(mm):
    await fill(mm)
    got = await server.export_people(ctx=None)
    assert got.url is None and got.path in got.message_for_user and zipfile.is_zipfile(got.path)


async def test_reset_needs_the_code_the_user_types_back(mm):
    await fill(mm)
    (bulk.inbox_dir(mm) / "waiting.txt").write_text("x", encoding="utf-8")
    await server.export_people(ctx=ctx())

    ask = await server.reset_server()
    assert ask.status == "confirmation_needed" and (ask.people, ask.jobs, ask.inbox_files) == (2, 1, 1)
    code = ask.message_for_user.split("RESET ")[1].split()[0]
    assert (await server.ping()).people == 2  # asking deletes nothing

    wrong = await server.reset_server(confirmation_code="RESET AAAAAA")
    assert wrong.status == "wrong_code" and (await server.ping()).people == 2
    assert (await server.reset_server(confirmation_code=code)).status == "wrong_code"  # a wrong guess spends it

    code = (await server.reset_server()).message_for_user.split("RESET ")[1].split()[0]
    done = await server.reset_server(confirmation_code=f"reset {code.lower()}")
    assert done.status == "wiped" and done.people == 2
    assert list(mm.settings.data_dir.iterdir()) in ([], [mm.settings.data_dir / "inbox"])
    assert (await server.ping()).people == 0 and await server.list_jobs() == []
    assert (await server.search_people(query="python", ctx=ctx())).total == 0
    assert (await server.reset_server(confirmation_code=code)).status == "wrong_code"  # single use


async def test_a_code_expires(mm, monkeypatch):
    code = (await server.reset_server()).message_for_user.split("RESET ")[1].split()[0]
    monkeypatch.setattr(exports.time, "time", lambda: server._reset_codes.expires + 1)
    assert (await server.reset_server(confirmation_code=code)).status == "wrong_code"


async def test_no_reset_while_an_inbox_run_is_going(mm):
    code = (await server.reset_server()).message_for_user.split("RESET ")[1].split()[0]
    server._runs.latest = SimpleNamespace(state="running", run_id="r1")
    result = await server.reset_server(confirmation_code=code)
    assert result.is_error and json.loads(result.content[0].text)["error"]["code"] == "already_running"
    server._runs.latest = None
    assert (await server.reset_server(confirmation_code=code)).status == "wiped"  # the code was not spent
