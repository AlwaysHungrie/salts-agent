import json
from dataclasses import dataclass

import pytest

from find_humans import server

from .conftest import about, secret

# Tests have no server OpenRouter key, so the caller pays.
ASHA = {"X-OpenRouter-Api-Key": "sk-caller", "X-Find-Humans-Secret": secret("asha-id-0123456789")}


@dataclass
class Answer:
    status_code: int
    body: bytes

    def json(self):
        return json.loads(self.body)


class Client:
    """Calls the ASGI app directly (no HTTP client in the dependencies)."""

    def __init__(self, app) -> None:
        self.app = app

    async def request(self, method: str, path: str, headers: dict | None = None) -> Answer:
        scope = {"type": "http", "method": method, "path": path, "raw_path": path.encode(), "query_string": b"",
                 "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
                 "scheme": "http", "server": ("test", 80), "client": ("test", 1), "http_version": "1.1",
                 "root_path": ""}
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await self.app(scope, receive, send)
        start = next(m for m in sent if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        return Answer(start["status"], body)

    async def get(self, path, headers=None):
        return await self.request("GET", path, headers)

    async def post(self, path, headers=None):
        return await self.request("POST", path, headers)


@pytest.fixture
def api(svc, monkeypatch):
    monkeypatch.setattr(server, "_services", svc)
    return Client(server.build_http_app())


async def test_my_profile_is_structured_and_saved_by_the_api(api):
    empty = (await api.get("/api/me", headers=ASHA)).json()
    assert empty["profile"] is None and empty["info"]["entries"] == []

    text = about("Asha Rao", "Builds AI agents", "AI agents") + "Telegram: @asha\n"
    await server.add_info(text=text,
                          links=["https://asha.dev"], ctx=server.SimpleNamespace(headers=ASHA))
    unsaved = (await api.get("/api/me", headers=ASHA)).json()
    assert unsaved["info"]["unsaved_changes"] and unsaved["profile"] is None

    saved = await api.post("/api/me/save", headers=ASHA)
    assert saved.status_code == 200
    body = saved.json()
    assert not body["info"]["unsaved_changes"]
    assert body["profile"] | {"saved_at": None} == {
        "person_id": body["info"]["person_id"], "name": "Asha Rao", "headline": "Builds AI agents",
        "location": None, "skills": ["AI agents"], "summary": "Works as Builds AI agents.",
        "page": body["profile"]["page"], "links": ["https://asha.dev"],
        "about": [about("Asha Rao", "Builds AI agents", "AI agents").strip() + "\nTelegram: @asha"],
        "saved_at": None}

    person = await api.get(f"/api/people/{body['info']['person_id']}", headers=ASHA)
    assert "- Telegram: @asha" in person.json()["page"]  # anything they wrote, in the readable page


async def test_the_api_needs_a_secret_and_answers_failures_with_codes(api):
    assert (await api.get("/api/me")).status_code == 401
    assert (await api.get("/healthz")).status_code == 200
    missing = await api.get(f"/api/people/{'0' * 32}", headers=ASHA)
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"
    assert (await api.get("/api/people/nope", headers=ASHA)).status_code == 400
