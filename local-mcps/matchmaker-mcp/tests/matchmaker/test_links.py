from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from matchmaker import bulk, links, server
from matchmaker.errors import ToolFailure

from .conftest import resume

TOKEN = "s" * 64
# What the salts-tools gateway adds to a request that came through the tunnel.
TUNNEL = {"X-OpenRouter-Api-Key": "sk-caller", "X-Forwarded-Host": "abc.trycloudflare.com",
          "X-Forwarded-Proto": "https", "X-Forwarded-Prefix": "/matchmaker"}


@pytest.fixture
def mm(svc, monkeypatch):
    svc.settings = svc.settings.model_copy(update={"mcp_auth_token": TOKEN})
    monkeypatch.setattr(server, "_services", svc)
    monkeypatch.setattr(server, "_runs", bulk.Runs())
    monkeypatch.setattr(server, "get_settings", lambda: svc.settings)
    return svc


@pytest.fixture
def browser(mm):
    """The HTTP app as a browser sees it: no bearer token."""
    return TestClient(server.build_http_app())


def ctx(headers=TUNNEL):
    return SimpleNamespace(headers=headers)


def path_of(url: str) -> str:
    return url.removeprefix("https://abc.trycloudflare.com/matchmaker")


def test_a_token_opens_only_what_it_was_signed_for(mm):
    s = mm.settings
    pid = "a" * 32
    token, expires = links.make_token(s, links.FILES, pid, now=1_000)
    assert expires == datetime.fromtimestamp(1_000 + 24 * 3600, UTC)
    assert links.read_token(s, token, now=2_000) == (links.FILES, pid)
    assert links.read_token(s, token, now=1_000 + 24 * 3600 + 1) is None  # expired
    assert links.read_token(s, token.replace("a" * 32, "b" * 32), now=2_000) is None  # another person
    assert links.read_token(s, token[:-1] + ("0" if token[-1] != "0" else "1"), now=2_000) is None
    other = s.model_copy(update={"mcp_auth_token": "t" * 64})  # salts-tools token replaced: every link void
    assert links.read_token(other, token, now=2_000) is None
    forged = f"upload-{pid}-99999999999"
    assert links.read_token(s, f"{forged}-{links._sign(s, forged)}", now=2_000) is None


def test_the_public_address_comes_from_the_gateway():
    assert links.public_base(TUNNEL) == "https://abc.trycloudflare.com/matchmaker"
    assert links.public_base({"X-OpenRouter-Api-Key": "k"}) is None
    assert links.public_base(None) is None
    assert links.public_base({"x-forwarded-host": "evil.com/x?"}) is None
    assert links.public_base({"x-forwarded-host": "h.com", "x-forwarded-proto": "javascript"}) is None


async def test_a_person_s_files_open_in_a_browser(mm, browser):
    added = await server.add_document(kind="resume", text=resume("Amir Soto", "Automation engineer", "SCADA"),
                                      ctx=ctx())
    got = await server.get_person_files_link(person_id=added.person_id, ctx=ctx())
    assert got.url.startswith("https://abc.trycloudflare.com/matchmaker/share/files-")
    assert got.url in got.message_for_user and "resume.txt" in got.files and "person.json" not in got.files

    page = browser.get(path_of(got.url))
    assert page.status_code == 200 and "Amir Soto" in page.text and "resume.txt" in page.text
    assert page.headers["cache-control"] == "no-store" and "embedding.npy" not in page.text
    file = browser.get(path_of(got.url) + "/f/resume.txt")
    assert file.status_code == 200 and file.text.startswith("Name: Amir Soto")
    for hidden in ("person.json", "embedding.npy", "..%2Fperson.json"):
        assert browser.get(path_of(got.url) + f"/f/{hidden}").status_code == 404
    assert browser.get("/share/files-" + "a" * 32 + "-9999999999-" + "0" * 32).status_code == 404
    assert browser.post(path_of(got.url) + "/upload?name=x.txt", content=b"hi").status_code == 404
    assert browser.post("/mcp").status_code == 401  # the rest still needs the bearer token

    server.people.delete_person(mm, added.person_id)
    assert browser.get(path_of(got.url)).status_code == 404


async def test_without_the_tunnel_the_folder_is_given_instead(mm):
    added = await server.add_document(kind="resume", text=resume("Bo C", "Designer", "Figma"), ctx=ctx())
    got = await server.get_person_files_link(person_id=added.person_id, ctx=ctx({"X-OpenRouter-Api-Key": "k"}))
    assert got.url is None and added.person_id in got.message_for_user
    assert (await server.get_upload_link(ctx=None)).url is None


async def test_resumes_uploaded_in_a_browser_land_in_the_inbox(mm, browser):
    info = await server.get_upload_link(ctx=ctx())
    assert info.url.startswith("https://abc.trycloudflare.com/matchmaker/share/upload-inbox-")
    assert info.url in info.message_for_user
    url = path_of(info.url)
    page = browser.get(url)
    assert page.status_code == 200 and "Upload resumes" in page.text

    text = resume("Asha R", "Backend engineer", "Python").encode()
    first = browser.post(url + "/upload?name=../../asha.txt", content=text)
    assert first.json() == {"new": True, "name": "asha.txt"}
    assert browser.post(url + "/upload?name=asha.txt", content=text).json()["new"] is False
    other = browser.post(url + "/upload?name=asha.txt", content=resume("Asha K", "Designer", "Figma").encode())
    assert other.json() == {"new": True, "name": "asha (2).txt"}
    assert browser.post(url + "/upload?name=x.pdf", content=b"not a pdf").json()["error"]["code"] == "unsupported_file"
    assert browser.post(url + "/upload?name=x.exe", content=b"MZ").status_code == 400
    big = mm.settings.max_file_bytes + 1
    assert browser.post(url + "/upload?name=big.txt", content=b"a" * big).json()["error"]["code"] == "file_too_large"

    day = bulk.inbox_dir(mm) / datetime.now(UTC).date().isoformat()
    assert sorted(p.name for p in day.iterdir()) == ["asha (2).txt", "asha.txt"]
    assert (await server.get_upload_link(ctx=ctx())).new == 2


def test_upload_names_are_made_safe():
    assert links.safe_name("..\\..\\Windows\\cv.PDF") == "cv.pdf"
    assert links.safe_name(".hidden.md") == "hidden.md"
    assert links.safe_name('a<b>:c.docx') == "a_b__c.docx"
    with pytest.raises(ToolFailure):
        links.safe_name("setup.exe")
