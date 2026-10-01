"""Offline checks for the synthetic scale suite: deterministic specs, ground truth rules, text validators.
The paid part (generation, ingest, matching) runs via `python -m tests.synthetic.run`."""

from dataclasses import replace

from recruiter_mcp.experience import years_of_experience

from .synthetic.generate import job_problems, resume_problems
from .synthetic.specs import ANCHOR, MAX_STRONG, MIN_STRONG, SAMPLE_JOB_ID, Job, build, fit

CANDS, JOBS = build(seed=7, n_candidates=300, n_jobs=8, sample_jd="sample")


def job(**kw) -> Job:
    base = dict(id="jx", title="Backend Engineer", family="backend", stack="python", must_haves=["Python", "AWS"],
                nice_to_haves=[], min_years=3, max_years=6, mode="onsite", cities=["pune"], style="startup")
    base.update(kw)
    return Job(**base)


def cand(**kw):
    base = next(c for c in CANDS if c.family == "backend")
    return replace(base, **{"family": "backend", "skills": ["Python", "Django", "AWS"], "relevant_years": 4.0,
                            "city": "pune", "relocate": None, "preferred": [], **kw})


def test_build_is_deterministic_and_jobs_have_enough_fits():
    c2, j2 = build(seed=7, n_candidates=300, n_jobs=8, sample_jd="sample")
    assert [c.text_hash() for c in c2] == [c.text_hash() for c in CANDS]
    assert [j.text_hash() for j in j2] == [j.text_hash() for j in JOBS]
    assert len({c.email for c in CANDS}) == len(CANDS)
    assert JOBS[0].id == SAMPLE_JOB_ID and len(JOBS) == 9
    for j in JOBS[1:]:
        assert MIN_STRONG <= sum(fit(c, j, ANCHOR)["strong"] for c in CANDS) <= MAX_STRONG, j.id


def test_smaller_corpus_shares_its_candidates_with_the_full_one():
    small, _ = build(seed=7, n_candidates=50, n_jobs=1)
    assert [c.text_hash() for c in small] == [c.text_hash() for c in CANDS[:50]]  # cached texts are reused


def test_role_dates_match_relevant_years():
    for c in CANDS[:100]:
        relevant = [r for r in c.roles if r.family == c.family]
        got = years_of_experience([{"start": r.start, "end": r.end} for r in relevant], today=ANCHOR)
        assert abs(got - c.relevant_years) <= 0.1, c.id


def test_fit_location_rules():
    j = job()
    assert fit(cand(), j)["strong"]
    assert not fit(cand(city="delhi"), j)["location_ok"]
    assert fit(cand(city="delhi", relocate=True), j)["location_ok"]
    assert not fit(cand(city="delhi", relocate=True, preferred=["bengaluru"]), j)["location_ok"]
    assert fit(cand(city="delhi", relocate=None, preferred=["pune"]), j)["location_ok"]
    assert not fit(cand(city="remote"), j)["location_ok"]
    assert fit(cand(city="delhi", relocate=False), job(mode="remote", cities=[]))["location_ok"]


def test_fit_skills_years_family():
    assert fit(cand(skills=["Python"]), job())["coverage"] == 0.5
    assert not fit(cand(skills=["Python"]), job())["strong"] and fit(cand(skills=["Python"]), job())["acceptable"]
    assert fit(cand(skills=["Go", "AWS"]), job(must_haves=["Python or Go", "AWS"]))["strong"]
    assert not fit(cand(relevant_years=1.5), job())["strong"]  # below min - 1
    assert fit(cand(relevant_years=7.9), job())["strong"]  # within max + 2
    assert not fit(cand(family="qa"), job())["acceptable"]


def test_validators_catch_missing_facts():
    c = CANDS[0]
    good = " ".join([c.email, *c.written_skills, *(r.company for r in c.roles), *(r.start[:4] for r in c.roles)])
    assert resume_problems(c, good) == []
    assert resume_problems(c, good.replace(c.written_skills[0], "")) != []
    j = job(must_haves=["Python or Go", "AWS"])
    assert job_problems(j, "Python, Go, AWS. Pune office.") == []
    assert job_problems(j, "Python and AWS in Pune") == ["must 'Go'"]
