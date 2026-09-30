"""Match funnel: filter merging and SQL (unit), filters against real data, end-to-end match with fakes."""

import json
from contextlib import asynccontextmanager

import pytest

from recruiter_mcp import match as matching
from recruiter_mcp.errors import ToolFailure
from recruiter_mcp.ingest import ingest_resume
from recruiter_mcp.models import AppliedFilters, CandidateScore, JobRequirements, MatchFilters
from recruiter_mcp.skills import SkillNormalizer, load_seed
from recruiter_mcp.usage import track_usage

from .conftest import FIXTURES, JOB_FIXTURES, fixture_text, job_fixture

N = SkillNormalizer(load_seed())
BASE_IDS = sorted(p.stem for p in FIXTURES.glob("c*.txt") if not p.stem.endswith("_v2"))
JOB_IDS = sorted(p.stem for p in JOB_FIXTURES.glob("*.json"))


def req(**kw) -> JobRequirements:
    base = dict(title="Backend", must_have_skills=["Python", "aws"], nice_to_have_skills=[], min_years=5,
                max_years=8, locations=["Pune"], remote_ok=False, industries=[], dealbreakers=[], summary="x")
    base.update(kw)
    return JobRequirements(**base)


def applied(**kw) -> AppliedFilters:
    base = dict(location_keys=[], remote_ok=True, min_years=None, max_years=None, max_notice_days=None,
                max_resume_age_days=None, must_have_skills=[], min_must_have_skills=None)
    base.update(kw)
    return AppliedFilters(**base)


# ------------------------------------------------------------------ unit


def test_merge_uses_parsed_values_with_years_slack():
    f = matching.merge_filters(req(), None, N)
    assert (f.min_years, f.max_years) == (4.0, 10.0)
    assert f.location_keys == ["pimpri chinchwad", "pune"] and f.remote_ok is False
    assert f.must_have_skills == ["Python", "AWS"]  # normalized
    assert f.max_notice_days is None and f.min_must_have_skills is None


def test_explicit_filters_override_field_by_field():
    f = matching.merge_filters(req(), MatchFilters(min_years=3, locations=["Bombay"], max_notice_days=30), N)
    assert f.min_years == 3  # exact, no slack
    assert f.max_years == 10.0  # still parsed + slack
    assert "mumbai" in f.location_keys and "thane" in f.location_keys
    assert f.max_notice_days == 30


def test_explicit_remote_and_null_years():
    f = matching.merge_filters(req(remote_ok=False), MatchFilters(remote_ok=True, max_years=None), N)
    assert f.remote_ok is True and f.max_years is None
    f = matching.merge_filters(req(min_years=None, max_years=None, remote_ok=True), None, N)
    assert f.min_years is None and f.max_years is None and f.remote_ok is True


def test_scoring_requirements_apply_explicit_overrides():
    r = req()
    assert matching.scoring_requirements(r, None) is r
    out = matching.scoring_requirements(r, MatchFilters(locations=["Bengaluru"], min_years=3, max_notice_days=30))
    assert out.locations == ["Bengaluru"] and out.min_years == 3 and out.max_years == 8
    assert r.locations == ["Pune"]  # original untouched


def test_filter_sql_empty():
    assert matching.build_filter_sql(applied()) == ("TRUE", [])


def test_filter_sql_all_clauses():
    where, params = matching.build_filter_sql(applied(
        location_keys=["pune"], remote_ok=False, min_years=4, max_years=10, max_notice_days=60,
        max_resume_age_days=180, must_have_skills=["Python", "AWS"], min_must_have_skills=1,
    ), first_param=3)
    assert where == (
        "(years_exp IS NULL OR years_exp >= $3) AND (years_exp IS NULL OR years_exp <= $4) AND "
        "(location_key IS NULL OR location_key = 'remote' OR location_key = ANY($5::text[])) AND "
        "(notice_days IS NULL OR notice_days <= $6) AND updated_at >= now() - make_interval(days => $7) AND "
        "((skills && $8::text[])::int + (skills && $9::text[])::int) >= $10"
    )
    assert params == [4, 10, ["pune"], 60, 180, ["Python"], ["AWS"], 1]


def test_filter_sql_all_must_haves_uses_containment_and_remote_skips_location():
    where, params = matching.build_filter_sql(applied(
        location_keys=["pune"], remote_ok=True, must_have_skills=["Python", "AWS"], min_must_have_skills=5,
    ))
    assert where == "skills @> $1::text[]" and params == [["Python", "AWS"]]


def test_score_breakdown_is_clamped_summed_and_capped():
    base = dict(must_haves_met=[], must_haves_missing=[], concerns=[], one_line_pitch="x",
                must_have_points=55, experience_points=20, recency_points=-3, nice_to_have_points=5,
                logistics_points=10, dealbreaker_violated=False)
    assert CandidateScore(**base).breakdown().total == 40 + 20 + 0 + 5 + 10
    assert CandidateScore(**{**base, "dealbreaker_violated": True}).breakdown().total == 30


def test_scoring_view_strips_contact_details():
    row = {"profile": json.dumps({"name": "A", "email": "a@x.com", "phone": "1", "skills": ["Go"]}),
           "years_exp": None}
    view = json.loads(matching.scoring_view(row))
    assert view == {"skills": ["Go"], "years_exp_computed": None}


# ------------------------------------------------------------------ filters on real rows


async def ingest_all(svc):
    for fid in BASE_IDS:
        await ingest_resume(svc, resume_text=fixture_text(fid))
    rows = await svc.pool.fetch("SELECT id, email, name FROM candidates")
    return {r["name"]: r["id"] for r in rows}


async def names_passing(svc, f: AppliedFilters) -> set[str]:
    where, params = matching.build_filter_sql(f)
    return {r["name"] for r in await svc.pool.fetch(f"SELECT name FROM candidates WHERE {where}", *params)}


async def test_filters_against_fixture_data(svc):
    await ingest_all(svc)
    everyone = await names_passing(svc, applied())
    assert len(everyone) == 20

    # Years: nulls pass (Lata has no dates), juniors drop.
    got = await names_passing(svc, applied(min_years=4, max_years=10))
    assert "Lata Pillai" in got and "Rohan Das" not in got and "Priya Sharma" in got

    # Location: metro expansion, 'Remote' candidates pass, other cities drop.
    got = await names_passing(svc, applied(location_keys=matching.expand_job_locations(["Mumbai"]), remote_ok=False))
    assert {"Neha Kulkarni", "Meera Joshi", "Pooja Nair", "Sara Khan"} <= got  # Mumbai, Thane, Navi Mumbai, Remote
    assert "Priya Sharma" not in got and "Arjun Mehta" not in got

    # Notice period.
    got = await names_passing(svc, applied(max_notice_days=30))
    assert "Kabir Shah" not in got and "Rajesh Gupta" not in got and "Ananya Iyer" in got

    # Must-have overlap, k of n.
    both = await names_passing(svc, applied(must_have_skills=["Kubernetes", "Terraform"], min_must_have_skills=2))
    assert both == {"Aditya Verma", "Farah Ali"}
    one = await names_passing(svc, applied(must_have_skills=["Kubernetes", "Terraform"], min_must_have_skills=1))
    assert one == {"Aditya Verma", "Farah Ali", "Arjun Mehta"}

    # Freshness.
    await svc.pool.execute("UPDATE candidates SET updated_at = now() - interval '400 days' WHERE name = 'Amit Singh'")
    got = await names_passing(svc, applied(max_resume_age_days=180))
    assert "Amit Singh" not in got and len(got) == 19


# ------------------------------------------------------------------ end to end (fakes)


@pytest.mark.parametrize("jid", JOB_IDS)
async def test_match_fixture_jobs_find_expected(svc, jid):
    await ingest_all(svc)
    job = job_fixture(jid)
    async with track_usage(svc.pool, "match_job"):
        res = await matching.match_job(svc, jd_text=job["jd_text"], limit=10)
    ids = await svc.pool.fetch("SELECT id::text, name FROM candidates")
    name_of = {r["id"]: r["name"] for r in ids}
    top = [name_of[c.candidate_id] for c in res.candidates]
    expected = [json.loads((FIXTURES / f"{e}.json").read_text(encoding="utf-8"))["name"] for e in job["expected_top"]]
    assert set(expected) <= set(top), (jid, top)

    assert res.funnel.total == 20 and 0 < res.funnel.after_filters <= 20
    assert res.funnel.reranked == min(res.funnel.after_filters, 50)
    assert [c.rank for c in res.candidates] == sorted(c.rank for c in res.candidates)
    assert all(c.score >= svc.settings.min_match_score for c in res.candidates)
    assert res.stats.llm_calls == 1 + res.funnel.reranked + res.funnel.rescored and res.stats.cost_usd > 0
    # Everything scored is persisted, not just the returned top N.
    stored = await svc.pool.fetchval("SELECT count(*) FROM matches WHERE job_id = $1::uuid", res.job_id)
    assert stored == res.funnel.reranked


async def test_match_filters_and_notes(svc):
    await ingest_all(svc)
    job = job_fixture("j4_devops_sre")
    res = await matching.match_job(svc, jd_text=job["jd_text"],
                                   filters=MatchFilters(max_notice_days=30, locations=["Bengaluru"]))
    names = [c.name for c in res.candidates]
    assert "Farah Ali" in names and "Aditya Verma" not in names  # Aditya: Pune, 60-day notice
    assert res.applied_filters.max_notice_days == 30 and res.applied_filters.location_keys == ["bengaluru"]
    assert res.note and "passed the filters" in res.note

    none = await matching.match_job(svc, jd_text=job["jd_text"], filters=MatchFilters(min_years=40))
    assert none.funnel.after_filters == 0 and none.candidates == [] and "No candidates" in none.note


async def test_unknown_years_flagged_and_failed_rerank_dropped(svc):
    await ingest_all(svc)
    svc.llm.fail_for = {"Site Reliability Engineer"}
    res = await matching.match_job(svc, jd_text=job_fixture("j4_devops_sre")["jd_text"],
                                   filters=MatchFilters(locations=[], remote_ok=True, min_years=None))
    assert res.funnel.rerank_failed == 1 and "could not be scored" in res.note
    assert "Aditya Verma" not in {c.name for c in res.candidates}
    stored = await svc.pool.fetch(
        "SELECT result FROM matches m JOIN candidates c ON c.id = m.candidate_id "
        "WHERE m.job_id = $1::uuid AND c.name = 'Lata Pillai'", res.job_id)
    assert stored and matching.UNKNOWN_YEARS_CONCERN in json.loads(stored[0]["result"])["concerns"]


async def test_all_reranks_failing_is_an_error(svc):
    await ingest_all(svc)

    async def boom(*a, **k):
        raise RuntimeError("down")

    jd = job_fixture("j1_senior_backend")["jd_text"]
    real = svc.llm.structured

    async def parse_only(system, user, schema, *, name, reasoning_effort=None):
        return await (real if name == "job_requirements" else boom)(
            system, user, schema, name=name, reasoning_effort=reasoning_effort)

    svc.llm.structured = parse_only
    with pytest.raises(ToolFailure) as e:
        await matching.match_job(svc, jd_text=jd)
    assert e.value.code == "rerank_failed"


async def test_hnsw_iterative_path_matches_exact_path(svc, monkeypatch):
    await ingest_all(svc)
    jd = job_fixture("j2_frontend_react")["jd_text"]
    exact = await matching.match_job(svc, jd_text=jd)
    monkeypatch.setattr(matching, "EXACT_SCAN_MAX_ROWS", 0)
    approx = await matching.match_job(svc, jd_text=jd)
    assert exact.funnel == approx.funnel
    assert [c.candidate_id for c in exact.candidates] == [c.candidate_id for c in approx.candidates]


async def test_get_job_and_list_jobs(svc):
    await ingest_all(svc)
    res = await matching.match_job(svc, jd_text=job_fixture("j1_senior_backend")["jd_text"], limit=3)
    calls = svc.llm.calls
    again = await matching.get_job(svc, res.job_id, limit=3)
    assert svc.llm.calls == calls  # no LLM on reopen
    assert [c.candidate_id for c in again.candidates] == [c.candidate_id for c in res.candidates]
    assert again.parsed_requirements == res.parsed_requirements and again.funnel == res.funnel

    await svc.pool.execute("UPDATE matches SET feedback_label='shortlisted' WHERE job_id=$1::uuid AND rank=1",
                           res.job_id)
    again = await matching.get_job(svc, res.job_id, limit=50, include_low_scores=True)
    assert again.candidates[0].feedback_label == "shortlisted" and len(again.candidates) == res.funnel.reranked

    await matching.match_job(svc, jd_text=job_fixture("j5_finance_manager")["jd_text"])
    jobs = (await matching.list_jobs(svc)).jobs
    assert [j.title for j in jobs] == ["Finance Manager", "Senior Backend Engineer"]
    assert jobs[1].feedback_count == 1 and len(jobs[1].top_candidates) == 3

    for bad in ("nope", "00000000-0000-0000-0000-000000000000"):
        with pytest.raises(ToolFailure):
            await matching.get_job(svc, bad)


# ------------------------------------------------------------------ MCP layer


@asynccontextmanager
async def mcp_client(svc):
    from mcp import Client

    from recruiter_mcp import server

    async with Client(server.mcp) as c:
        server._services._llm = svc.llm
        server._services._embedder = svc.embedder
        yield c


async def test_match_tools_over_mcp(svc):
    await ingest_all(svc)
    async with mcp_client(svc) as client:
        tools = {t.name for t in (await client.list_tools()).tools}
        assert {"match_job", "get_job", "list_jobs"} <= tools
        res = await client.call_tool("match_job", {
            "jd_text": job_fixture("j3_data_scientist")["jd_text"], "limit": 5,
            "filters": {"max_notice_days": 60},
        })
        assert not res.is_error, res.content
        body = res.structured_content
        assert body["funnel"]["total"] == 20 and body["candidates"][0]["rank"] == 1
        assert body["applied_filters"]["max_notice_days"] == 60

        usage = await svc.pool.fetch("SELECT tool FROM usage WHERE tool = 'match_job'")
        assert len(usage) == 1 + body["funnel"]["reranked"] + body["funnel"]["rescored"]

        got = await client.call_tool("get_job", {"job_id": body["job_id"], "limit": 5})
        assert [c["candidate_id"] for c in got.structured_content["candidates"]] == \
               [c["candidate_id"] for c in body["candidates"]]
        listed = await client.call_tool("list_jobs", {})
        assert listed.structured_content["jobs"][0]["job_id"] == body["job_id"]

        bad = await client.call_tool("match_job", {"jd_text": " "})
        assert bad.is_error and json.loads(bad.content[0].text)["error"]["code"] == "invalid_input"


# ------------------------------------------------------------------ borderline re-scoring


def _score(points: int, dealbreaker=False, concerns=()) -> CandidateScore:
    # Spread `points` over the rubric lines in order of capacity.
    caps = [40, 25, 15, 10, 10]
    parts = []
    for cap in caps:
        parts.append(min(cap, points))
        points -= parts[-1]
    return CandidateScore(must_haves_met=["Python"], must_haves_missing=[], concerns=list(concerns),
                          one_line_pitch="p", must_have_points=parts[0], experience_points=parts[1],
                          recency_points=parts[2], nice_to_have_points=parts[3], logistics_points=parts[4],
                          dealbreaker_violated=dealbreaker)


def test_borderline_indices():
    # min_score 35 boundary only (fewer passing than limit): 30 and 40 are within 8 of 34.5.
    assert matching.borderline_indices([90, 40, 30, 10], limit=10, min_score=35, margin=8) == {1, 2}
    # Rank cutoff too: limit 2, passing [90, 80, 50] -> boundary between 80 and 50 is 65; nothing within 8.
    assert matching.borderline_indices([90, 80, 50], limit=2, min_score=35, margin=8) == set()
    # Close race for the last slot: limit 2, passing [90, 70, 66] -> boundary 68 catches both.
    assert matching.borderline_indices([90, 70, 66], limit=2, min_score=35, margin=8) == {1, 2}
    assert matching.borderline_indices([36, 34], limit=10, min_score=35, margin=0) == set()


def test_average_scores():
    a, b = _score(40, concerns=["notice 90d"]), _score(30, concerns=["notice 90d", "gap in 2021"])
    m = matching.average_scores(a, b)
    assert m.breakdown().total == 35 and m.concerns == ["notice 90d", "gap in 2021"]
    assert m.must_haves_met == a.must_haves_met and m.one_line_pitch == a.one_line_pitch
    # Dealbreaker needs both runs; disagreement is surfaced, not silently capped.
    split = matching.average_scores(_score(80, dealbreaker=True), _score(80))
    assert split.breakdown().total == 80 and matching.DEALBREAKER_DISAGREE_CONCERN in split.concerns
    both = matching.average_scores(_score(80, dealbreaker=True), _score(70, dealbreaker=True))
    assert both.breakdown().total == 30


async def test_borderline_candidates_are_rescored_and_averaged(svc):
    await ingest_all(svc)
    real = svc.llm._score
    runs: dict[str, int] = {}

    def noisy(system, user):
        # First run of each candidate scores 6 points high, the second 6 low: the average is the true score.
        out = real(system, user)
        key = json.loads(user[user.index("<candidate>") + 11: user.rindex("</candidate>")])["current_title"]
        runs[key] = runs.get(key, 0) + 1
        delta = 6 if runs[key] == 1 else -6
        out["recency_points"] = max(0, min(15, out["recency_points"] + delta))
        return out

    svc.llm._score = noisy
    jd = job_fixture("j1_senior_backend")["jd_text"]
    svc.settings = svc.settings.model_copy(update={"rerank_borderline_margin": 0})
    off = await matching.match_job(svc, jd_text=jd)
    assert off.funnel.rescored == 0

    runs.clear()
    svc.settings = svc.settings.model_copy(update={"rerank_borderline_margin": 8})
    async with track_usage(svc.pool, "match_job"):
        on = await matching.match_job(svc, jd_text=jd)
    assert on.funnel.rescored > 0 and on.stats.llm_calls == 1 + on.funnel.reranked + on.funnel.rescored
    twice = {k for k, v in runs.items() if v == 2}
    assert len(twice) == on.funnel.rescored
    # Rescored candidates carry the averaged (de-noised) recency, others keep the inflated first run.
    stored = await svc.pool.fetch("SELECT result FROM matches WHERE job_id = $1::uuid", on.job_id)
    recency = {json.loads(r["result"])["score_breakdown"]["recency"] for r in stored}
    assert 10 in recency and 16 not in recency


def test_clean_must_haves():
    sc = _score(50)
    raw = sc.model_copy(update={"must_haves_met": [
        "Kubernetes (production) — runs 40 EKS clusters",
        "AWS (Lambda, ECS/EKS, RDS) - evidence: EKS on AWS",
        "Python? (no explicit evidence)",
        "Machine learning fundamentals (no clear evidence)",
    ], "must_haves_missing": ["whatever the model said"]})
    out = matching.clean_must_haves(raw, ["Python", "AWS", "Kubernetes", "Machine Learning", "Terraform"])
    assert out.must_haves_met == ["AWS", "Kubernetes"]
    assert out.must_haves_missing == ["Python", "Machine Learning", "Terraform"]
    assert out.breakdown() == raw.breakdown()  # points untouched


def test_alternative_must_haves():
    raw = ["tally or sap", "k8s", "Python / Go", "CI/CD", "pl/sql", "React (production)"]
    assert N.normalize_requirements(raw) == ["Tally or SAP", "Kubernetes", "Python or Go", "CI/CD", "PL/SQL", "React"]
    where, params = matching.build_filter_sql(applied(must_have_skills=["Tally or SAP", "GST"], min_must_have_skills=2))
    assert where == "((skills && $1::text[])::int + (skills && $2::text[])::int) >= $3"
    assert params == [["Tally", "SAP"], ["GST"], 2]
    raw = _score(50).model_copy(update={"must_haves_met": ["Tally ERP (bookkeeping)", "GST"]})
    out = matching.clean_must_haves(raw, ["Tally or SAP", "GST", "IFRS"])
    assert out.must_haves_met == ["Tally or SAP", "GST"] and out.must_haves_missing == ["IFRS"]


async def test_alternative_must_have_filter_on_rows(svc):
    await ingest_all(svc)
    got = await names_passing(svc, applied(must_have_skills=["Tally or SAP FICO", "GST"], min_must_have_skills=2))
    assert got == {"Rajesh Gupta", "Pooja Nair"}  # Pooja has Tally only, Rajesh has both
