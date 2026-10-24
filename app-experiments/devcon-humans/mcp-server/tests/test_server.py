import json
from types import SimpleNamespace

import pytest

from find_humans import server

from .conftest import about, secret

KEY = {"X-OpenRouter-Api-Key": "sk-caller"}
ASHA = KEY | {"X-Find-Humans-Secret": secret("asha-id-0123456789")}
CY = KEY | {"X-Find-Humans-Secret": secret("cy-id-0123456789ab")}


@pytest.fixture
def fh(svc, monkeypatch):
    monkeypatch.setattr(server, "_services", svc)
    return svc


def ctx(headers):
    return SimpleNamespace(headers=headers)


def error(result):
    assert result.is_error
    return json.loads(result.content[0].text)["error"]["code"]


async def test_add_save_find_and_delete_through_the_tools(fh):
    mine = await server.add_info(text=about("Asha Rao", "Builds AI agents", "AI agents"),
                                 links=["https://asha.dev"], ctx=ctx(ASHA))
    await server.add_info(text=about("Cy D", "Runs brand deals", "Brand deals"), ctx=ctx(CY))
    assert (await server.my_info(ctx=ctx(ASHA))).entries == mine.entries
    await server.save_profile(ctx=ctx(ASHA))
    await server.save_profile(ctx=ctx(CY))
    assert (await server.ping()).people == 2

    page = await server.search_people(query="AI agents", ctx=ctx(KEY))  # searching needs no secret
    assert page.people[0].name == "Asha Rao" and page.people[0].links == ["https://asha.dev"]
    assert (await server.get_person(person_id=page.people[0].person_id)).headline == "Builds AI agents"

    assert error(await server.delete_info(entry_ids=[mine.entries[0].entry_id], ctx=ctx(CY))) == "not_found"
    gone = await server.delete_my_profile(ctx=ctx(ASHA))
    assert gone == {"deleted": mine.person_id}
    assert (await server.ping()).people == 1


async def test_failures_come_back_as_codes(fh):
    assert error(await server.add_info(text="hi", ctx=ctx(KEY))) == "missing_secret"
    assert error(await server.add_info(text="hi", ctx=None)) == "missing_secret"
    # paid tools need the caller's key; stdio has no headers at all
    assert error(await server.save_profile(ctx=ctx({"X-Find-Humans-Secret": secret("x" * 16)}))) == "missing_header"
    assert error(await server.search_people(query="agents", ctx=None)) == "missing_header"
    capped = ctx(ASHA | {"Tool-Call-Max-Charge": "0.0001"})  # under a save's typical cost
    assert error(await server.save_profile(ctx=capped)) == "cost_limit_exceeded"
    assert error(await server.get_person(person_id="nope")) == "invalid_input"
    assert error(await server.delete_my_profile(ctx=ctx(ASHA))) == "not_found"
