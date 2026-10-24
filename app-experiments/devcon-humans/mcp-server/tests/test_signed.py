"""Only secrets minted with SECRET_SIGNING_KEY are accepted, and each is its caller's only pass, so the agent holding
one can show or send nothing that reaches anyone else's profile or the server as a whole."""

import json
from types import SimpleNamespace

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from find_humans import billing, server
from find_humans.auth import SignedSecretMiddleware
from find_humans.config import Settings, get_settings, signing_key_problem
from find_humans.errors import ToolFailure
from find_humans.identity import caller, mint, person_id

from .conftest import SIGNING_KEY, secret

ID = "asha-id-0123456789abcdef"


def test_the_signature_matches_the_app_that_mints_it():
    # The same pair is checked in frontend/test/agent.test.ts.
    assert mint(SIGNING_KEY, ID) == "fh1.asha-id-0123456789abcdef.pRrdEwqRLWQ0n8oduxsmcJXSSce6avC-weonQeU8i0Q"


def test_a_minted_secret_is_the_person_its_id_was():
    assert caller({"X-Find-Humans-Secret": secret(ID)}) == person_id(ID)


@pytest.mark.parametrize("sent", [
    ID,                                         # plain
    mint("some-other-key-0123456789abcdefghij", ID),  # minted elsewhere
    secret(ID)[:-1] + "x",                      # tampered signature
    secret(ID) + "=",                           # padded signature
    secret("short"),                            # id too short
    secret(ID).replace(ID, ID + "z"),           # someone else's id, old signature
    secret(ID)[:-1] + "é",                      # not ASCII
])
def test_anything_not_minted_here_is_refused(sent):
    with pytest.raises(ToolFailure) as e:
        caller({"X-Find-Humans-Secret": sent})
    assert e.value.code == "invalid_input"


def test_http_needs_exactly_one_minted_secret():
    app = SignedSecretMiddleware(
        Starlette(routes=[Route("/mcp", lambda _: PlainTextResponse("ok")),
                          Route("/healthz", lambda _: PlainTextResponse("ok"))]), SIGNING_KEY)
    client = TestClient(app)
    assert client.get("/healthz").status_code == 200
    assert client.get("/mcp").status_code == 401
    assert client.get("/mcp", headers={"X-Find-Humans-Secret": ID}).status_code == 401
    assert client.get("/mcp", headers={"Authorization": "Bearer anything"}).status_code == 401
    not_ascii = (secret(ID)[:-1] + "\xe9").encode("latin-1")
    assert client.get("/mcp", headers={"X-Find-Humans-Secret": not_ascii}).status_code == 401
    assert client.get("/mcp", headers={"X-Find-Humans-Secret": secret(ID)}).status_code == 200
    twice = [("X-Find-Humans-Secret", secret(ID)), ("X-Find-Humans-Secret", secret("cy-id-0123456789ab"))]
    assert client.get("/mcp", headers=twice).status_code == 401


def test_the_server_will_not_start_without_a_strong_key():
    assert signing_key_problem(Settings(secret_signing_key=None)) == "SECRET_SIGNING_KEY is required"
    assert "at least 32 bytes" in signing_key_problem(Settings(secret_signing_key="short"))
    assert signing_key_problem(Settings(secret_signing_key=SIGNING_KEY)) is None


def test_the_servers_own_key_pays_when_the_caller_sends_none(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-server")
    get_settings.cache_clear()
    tokens = billing.begin("save_profile", {})
    try:
        assert billing.current_api_key() == "sk-server"
    finally:
        billing.end(tokens)
    tokens = billing.begin("save_profile", {"X-OpenRouter-Api-Key": "sk-caller"})
    try:
        assert billing.current_api_key() == "sk-caller"
    finally:
        billing.end(tokens)


async def test_without_any_key_paid_tools_are_refused(svc, monkeypatch):
    monkeypatch.setattr(server, "_services", svc)
    result = await server.save_profile(ctx=SimpleNamespace(headers={"X-Find-Humans-Secret": secret(ID)}))
    assert result.is_error and json.loads(result.content[0].text)["error"]["code"] == "missing_header"
