import json

import pytest

from find_humans.errors import ToolFailure
from find_humans.identity import caller, person_id
from find_humans.people import add_info, delete_info, delete_person, get_person, my_info, save_profile
from find_humans.search import fuse, search

from .conftest import about, secret

ASHA = person_id("asha-secret-0123456789")
CY = person_id("cy-secret-0123456789ab")


def test_the_secret_header_decides_who_you_are():
    assert caller({"X-Find-Humans-Secret": secret("asha-secret-0123456789")}) == ASHA
    assert caller({"x-find-humans-secret": f" {secret('asha-secret-0123456789')} "}) == ASHA
    assert ASHA != CY and len(ASHA) == 32
    for headers, code in [(None, "missing_secret"), ({}, "missing_secret"),
                          ({"X-Find-Humans-Secret": "asha-secret-0123456789"}, "invalid_input")]:
        with pytest.raises(ToolFailure) as e:
            caller(headers)
        assert e.value.code == code


async def test_entries_are_free_and_reach_search_only_when_saved(svc):
    info = add_info(svc, ASHA, about("Asha Rao", "Builds AI agents", "AI agents, Python"),
                    links=["github.com/asha", "https://asha.dev"])
    assert [e.kind for e in info.entries] == ["text", "link", "link"]
    assert info.entries[1].value == "https://github.com/asha"
    assert info.unsaved_changes and info.saved_profile is None
    assert svc.llm.calls == [] and svc.embedder.calls == 0
    assert (await search(svc, "agents")).total == 0

    saved = await save_profile(svc, ASHA)
    assert not saved.unsaved_changes and saved.saved_profile.startswith("# Builds AI agents")
    assert "- Links: https://github.com/asha https://asha.dev" in saved.saved_profile
    assert svc.llm.calls == ["person_profile"] and svc.embedder.calls == 1
    await save_profile(svc, ASHA)  # nothing changed: no model call
    assert svc.llm.calls == ["person_profile"]

    page = await search(svc, "AI agents")
    assert page.total == 1 and page.people[0].person_id == ASHA and page.people[0].name == "Asha Rao"
    person = get_person(svc, ASHA)
    assert person.about == [about("Asha Rao", "Builds AI agents", "AI agents, Python").strip()]
    assert person.links == ["https://github.com/asha", "https://asha.dev"]


async def test_deleted_info_leaves_search_on_save(svc):
    add_info(svc, ASHA, "Name: Asha\nHeadline: Builds AI agents\nSkill: AI agents")
    add_info(svc, ASHA, "Skill: Brand deals", links=["https://x.com/asha"])
    await save_profile(svc, ASHA)
    assert (await search(svc, "brand deals")).people[0].keyword_rank == 1

    brand, link = [e.entry_id for e in my_info(svc, ASHA).entries[1:]]
    info = delete_info(svc, ASHA, [brand, link])
    assert len(info.entries) == 1 and info.unsaved_changes
    assert "Brand deals" in info.saved_profile  # still searchable until saved
    info = await save_profile(svc, ASHA)
    assert "Brand deals" not in info.saved_profile and get_person(svc, ASHA).links == []
    assert (await search(svc, "brand deals")).people[0].keyword_rank is None

    delete_info(svc, ASHA, [info.entries[0].entry_id])
    await save_profile(svc, ASHA)  # no entries left: out of search
    assert (await search(svc, "agents")).total == 0
    assert not (svc.settings.data_dir / "people" / ASHA).exists()


async def test_one_person_cannot_touch_anothers_entries(svc):
    entry = add_info(svc, ASHA, "Headline: Builds AI agents").entries[0].entry_id
    with pytest.raises(ToolFailure) as e:
        delete_info(svc, CY, [entry])
    assert e.value.code == "not_found"
    with pytest.raises(ToolFailure) as e:
        delete_person(svc, CY)
    assert e.value.code == "not_found"
    assert len(my_info(svc, ASHA).entries) == 1


async def test_bad_input_is_refused(svc):
    svc.settings.max_entries = 2
    for kwargs in [{}, {"text": "  "}, {"links": ["javascript:alert(1)"]}, {"links": ["not a link"]},
                   {"text": "x" * 5000}, {"text": "a", "links": ["https://a.dev", "https://b.dev"]}]:
        with pytest.raises(ToolFailure) as e:
            add_info(svc, ASHA, **kwargs)
        assert e.value.code == "invalid_input", kwargs
    add_info(svc, ASHA, links=["https://a.dev", "a.dev/"])
    assert [x.value for x in my_info(svc, ASHA).entries] == ["https://a.dev", "https://a.dev/"]
    with pytest.raises(ToolFailure) as e:
        get_person(svc, ASHA)  # never saved
    assert e.value.code == "not_found"
    with pytest.raises(ToolFailure) as e:
        get_person(svc, "../etc")
    assert e.value.code == "invalid_input"


async def test_search_ranks_and_pages(svc):
    for n, (secret_id, text) in enumerate([
        ("a" * 16, about("Asha", "Builds AI agents", "AI agents, LLMs, Python")),
        ("b" * 16, about("Bo", "Runs brand deals for creators", "Brand deals, Influencer marketing")),
        ("c" * 16, about("Cy", "Solidity auditor", "Solidity, Security", location="Berlin")),
    ]):
        add_info(svc, person_id(secret_id), text)
        await save_profile(svc, person_id(secret_id))
    first = await search(svc, "who builds AI agents")
    assert first.people[0].name == "Asha" and first.total == 3 and first.next_offset == 2
    rest = await search(svc, "who builds AI agents", offset=first.next_offset)
    assert len(rest.people) == 1 and rest.people[0].position == 3 and rest.next_offset is None
    assert (await search(svc, "brand deals")).people[0].name == "Bo"
    assert (await search(svc, "Berlin")).people[0].location == "Berlin"
    with pytest.raises(ToolFailure):
        await search(svc, " ")


def test_saved_files_hold_no_secret(svc):
    add_info(svc, person_id("my-secret-0123456789"), "Headline: Writer")
    stored = "".join(p.read_text() for p in (svc.settings.data_dir / "people").rglob("*.json"))
    assert "my-secret" not in stored and json.loads(stored)["entries"][0]["value"] == "Headline: Writer"


def test_fuse_merges_both_rankings():
    assert fuse([2, 0], [0, 1, 2], k=60) == [0, 2, 1]
