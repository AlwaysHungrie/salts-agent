"""PERSON_DAILY_LIMIT_USD / PERSON_MONTHLY_LIMIT_USD: what each person may cost the server's own OpenRouter key. Calls
on the caller's own key are theirs to pay for and do not count."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from find_humans import server, spend
from find_humans.config import get_settings
from find_humans.identity import person_id

from .conftest import about, secret

ASHA = {"X-Find-Humans-Secret": secret("asha-id-0123456789")}
ASHA_ID = person_id("asha-id-0123456789")


def ctx(headers):
    return SimpleNamespace(headers=headers)


def code(result):
    assert result.is_error
    return json.loads(result.content[0].text)["error"]["code"]


@pytest.fixture
def limited(svc, monkeypatch):
    """The server pays, with each person allowed less than two saves (a fake save costs $0.00011)."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-server")
    get_settings.cache_clear()
    svc.settings = svc.settings.model_copy(update={"person_daily_limit_usd": 0.0002,
                                                   "person_monthly_limit_usd": 1.0})
    monkeypatch.setattr(server, "_services", svc)
    return svc


async def save(headers, text="Headline: Builds AI agents"):
    await server.add_info(text=text, ctx=ctx(headers))
    return await server.save_profile(ctx=ctx(headers))


async def test_a_person_is_stopped_once_today_is_used(limited):
    assert not getattr(await save(ASHA), "is_error", False)
    assert not getattr(await save(ASHA, "Headline: Runs brand deals"), "is_error", False)
    day, month = spend.totals(limited, ASHA_ID)
    assert day == pytest.approx(0.00022) and month == pytest.approx(0.00022)
    # Over the day's allowance: refused before any model call, searching included.
    assert code(await save(ASHA, "Headline: Writer")) == "spend_limit_reached"
    assert code(await server.search_people(query="agents", ctx=ctx(ASHA))) == "spend_limit_reached"
    assert spend.totals(limited, ASHA_ID)[0] == pytest.approx(0.00022)
    # Someone else still has theirs.
    cy = {"X-Find-Humans-Secret": secret("cy-id-0123456789ab")}
    assert not getattr(await save(cy, about("Cy", "Auditor", "Solidity")), "is_error", False)


async def test_the_month_has_its_own_limit(limited):
    limited.settings = limited.settings.model_copy(update={"person_daily_limit_usd": 0.0,
                                                           "person_monthly_limit_usd": 0.0001})
    await save(ASHA)
    assert code(await save(ASHA, "Headline: Writer")) == "spend_limit_reached"


async def test_yesterdays_spend_does_not_count_today(limited):
    path = limited.settings.data_dir / "spend" / f"{ASHA_ID}.json"
    path.parent.mkdir(parents=True)
    month = datetime.now(UTC).strftime("%Y-%m")
    path.write_text(json.dumps({"day": "2000-01-01", "day_usd": 5, "month": month, "month_usd": 0.5}))
    assert spend.totals(limited, ASHA_ID) == (0.0, 0.5)
    assert not getattr(await save(ASHA), "is_error", False)


async def test_calls_on_the_callers_own_key_do_not_count(limited):
    own = ASHA | {"X-OpenRouter-Api-Key": "sk-caller"}
    for n in range(3):
        assert not getattr(await save(own, f"Headline: Job {n}"), "is_error", False)
    assert spend.totals(limited, ASHA_ID) == (0.0, 0.0)
