"""scripts/eval.py feedback metrics against the test database."""

import argparse
import importlib.util
from pathlib import Path

from recruiter_mcp import match as matching
from recruiter_mcp.ingest import ingest_resume

from .conftest import FIXTURES, fixture_text, job_fixture

spec = importlib.util.spec_from_file_location("eval_script", Path(__file__).parents[1] / "scripts" / "eval.py")
eval_script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eval_script)


async def test_feedback_metrics(svc):
    for fid in sorted(p.stem for p in FIXTURES.glob("c*.txt") if not p.stem.endswith("_v2")):
        await ingest_resume(svc, resume_text=fixture_text(fid))
    res = await matching.match_job(svc, jd_text=job_fixture("j1_senior_backend")["jd_text"])
    ranked = res.candidates
    await matching.record_feedback(svc, res.job_id, ranked[0].candidate_id, "shortlisted")
    await matching.record_feedback(svc, res.job_id, ranked[1].candidate_id, "rejected")
    outsider = await svc.pool.fetchval("SELECT id::text FROM candidates WHERE name = 'Rohan Das'")
    await matching.record_feedback(svc, res.job_id, outsider, "placed")

    report = await eval_script.run_feedback(argparse.Namespace())
    s = report["summary"]
    assert s["labeled"] == 3 and s["jobs"] == 1
    assert s["recall_at_10"] == 0.5  # 1 of 2 positives in the top 10; the outsider was never ranked
    assert s["precision_at_10_of_labeled"] == 0.5  # of labeled top-10 rows: 1 shortlisted, 1 rejected
    assert s["positives_found_outside_results"] == 1
    assert s["avg_score_positive"] == ranked[0].score and s["avg_score_rejected"] == ranked[1].score


async def test_feedback_metrics_empty(svc):
    report = await eval_script.run_feedback(argparse.Namespace())
    assert report["summary"] == {"labeled": 0}
