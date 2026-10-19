import asyncio
import json
from types import SimpleNamespace

import pytest

from matchmaker import bulk, server

from .conftest import resume

KEY = {"X-OpenRouter-Api-Key": "sk-caller"}


@pytest.fixture
def mm(svc, monkeypatch):
    monkeypatch.setattr(server, "_services", svc)
    monkeypatch.setattr(server, "_runs", bulk.Runs())
    return svc


def ctx(headers=KEY):
    return SimpleNamespace(headers=headers)


async def finish():
    run = server._runs.latest
    await run.task
    return await server.get_ingest_status()


async def test_the_inbox_is_read_once_and_duplicates_cost_nothing(mm):
    info = await server.get_upload_link()
    inbox = mm.settings.data_dir / "inbox"
    assert info.folder == str(inbox.resolve()) and info.files == 0 and str(inbox.resolve()) in info.message_for_user
    assert (await server.ingest_inbox(ctx=ctx())).status == "no_files"

    (inbox / "team").mkdir(parents=True)
    (inbox / "a.txt").write_text(resume("Asha R", "Backend engineer", "Python"), encoding="utf-8")
    (inbox / "team" / "b.md").write_text(resume("Bo C", "Designer", "Figma"), encoding="utf-8")
    (inbox / "copy-of-a.txt").write_text(resume("Asha R", "Backend engineer", "Python"), encoding="utf-8")
    (inbox / "notes.xlsx").write_bytes(b"ignored")
    (inbox / ".hidden.txt").write_text("ignored", encoding="utf-8")
    assert (await server.get_upload_link()).new == 3

    started = await server.ingest_inbox(ctx=ctx())
    assert started.status == "started" and started.to_process == 3
    status = await finish()
    assert status.state == "finished" and status.counts == {"added": 2, "duplicate": 1}
    assert len(mm.llm.calls) == 2  # the copy was recognised before any model call
    assert (await server.ping()).people == 2

    assert (await server.ingest_inbox(ctx=ctx())).status == "nothing_new"
    (inbox / "c.txt").write_text(resume("Cy D", "Accountant", "GST"), encoding="utf-8")
    assert (await server.ingest_inbox(ctx=ctx())).to_process == 1
    assert (await finish()).counts == {"added": 1}


async def test_failures_are_retried_and_a_bad_key_stops_the_run(mm):
    inbox = bulk.inbox_dir(mm)
    (inbox / "empty.txt").write_text("   ", encoding="utf-8")
    (inbox / "ok.txt").write_text(resume("Asha R", "Backend engineer", "Python"), encoding="utf-8")
    await server.ingest_inbox(ctx=ctx())
    status = await finish()
    assert status.counts == {"added": 1, "failed": 1} and status.failures[0]["file"].endswith("empty.txt")
    for _ in range(bulk.MAX_ATTEMPTS - 1):  # tried again on each run, then given up
        assert (await server.ingest_inbox(ctx=ctx())).to_process == 1
        await finish()
    assert (await server.ingest_inbox(ctx=ctx())).status == "nothing_new"
    assert (await server.get_upload_link()).gave_up == 1
    ledger = json.loads((mm.settings.data_dir / "inbox.json").read_text())
    assert ledger[str(inbox / "empty.txt")]["attempts"] == bulk.MAX_ATTEMPTS

    from matchmaker.errors import ToolFailure

    async def refused(*a, **k):
        raise ToolFailure("invalid_api_key", "OpenRouter rejected the API key")
    mm.llm.structured = refused
    for n in range(3):
        (inbox / f"new{n}.txt").write_text(resume(f"P{n} Q", "Engineer", "Go"), encoding="utf-8")
    await server.ingest_inbox(ctx=ctx())
    status = await finish()
    assert status.state == "stopped" and "invalid_api_key" in status.stopped_reason
    assert "failed" not in status.counts  # not counted against the files: the next run tries them all


async def test_a_run_over_the_cap_is_refused_and_one_at_a_time(mm):
    inbox = bulk.inbox_dir(mm)
    for n in range(3):
        (inbox / f"{n}.txt").write_text(resume(f"P{n} Q", "Engineer", "Go"), encoding="utf-8")
    capped = ctx(KEY | {"Tool-Call-Max-Charge": "0.002"})  # 3 files at ~$0.001
    refused = await server.ingest_inbox(ctx=capped)
    assert refused.is_error and json.loads(refused.content[0].text)["error"]["code"] == "cost_limit_exceeded"
    gate = asyncio.Event()
    real = mm.llm.structured

    async def slow(*a, **k):
        await gate.wait()
        return await real(*a, **k)
    mm.llm.structured = slow
    await server.ingest_inbox(ctx=ctx())
    second = await server.ingest_inbox(ctx=ctx())
    assert second.is_error and json.loads(second.content[0].text)["error"]["code"] == "already_running"
    assert (await server.get_ingest_status()).state == "running"
    gate.set()
    assert (await finish()).counts == {"added": 3}


async def test_clearing_the_inbox_keeps_people_and_forgets_the_files(mm):
    inbox = bulk.inbox_dir(mm)
    (inbox / "day").mkdir()
    (inbox / "a.txt").write_text(resume("Asha R", "Backend engineer", "Python"), encoding="utf-8")
    await server.ingest_inbox(ctx=ctx())
    await finish()
    (inbox / "day" / "wrong.txt").write_text(resume("Bo C", "Designer", "Figma"), encoding="utf-8")
    assert (await server.get_upload_link()).new == 1

    assert (await server.clear_inbox()).deleted == 2
    assert list(inbox.iterdir()) == [] and (await server.get_upload_link()).files == 0
    assert json.loads((mm.settings.data_dir / "inbox.json").read_text()) == {}
    assert (await server.ping()).people == 1

    gate = asyncio.Event()
    real = mm.llm.structured

    async def slow(*a, **k):
        await gate.wait()
        return await real(*a, **k)
    mm.llm.structured = slow
    (inbox / "c.txt").write_text(resume("Cy D", "Accountant", "GST"), encoding="utf-8")
    await server.ingest_inbox(ctx=ctx())
    busy = await server.clear_inbox()
    assert busy.is_error and json.loads(busy.content[0].text)["error"]["code"] == "already_running"
    gate.set()
    await finish()
