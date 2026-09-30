"""Evaluate matching quality, latency and cost.

Fixture mode (default): uses a separate `recruiter_eval` database. Ingests the synthetic fixture resumes with the
real LLM (once; reused on later runs unless --reingest), runs every fixture JD through match_job, and reports
recall@10 against each JD's expected candidates, where each expected candidate ranked, and for misses, the funnel
stage that lost them. Also average latency and cost per match.

Feedback mode (--feedback): reads record_feedback labels from the main database and reports how well the ranking
agreed with the recruiter's decisions.

Usage:
  uv run python scripts/eval.py                 # fixture eval (~$0.30 with default models)
  uv run python scripts/eval.py --reingest      # re-extract fixture resumes first
  uv run python scripts/eval.py --jobs j1_senior_backend j3_data_scientist
  uv run python scripts/eval.py --feedback      # real labels from DATABASE_URL
  uv run python scripts/eval.py --json out.json # also write the report as JSON
"""

import argparse
import asyncio
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

import asyncpg

from recruiter_mcp import match as matching
from recruiter_mcp.config import get_settings
from recruiter_mcp.db import create_pool
from recruiter_mcp.ingest import ingest_resume
from recruiter_mcp.migrate import migrate
from recruiter_mcp.services import Services, load_normalizer
from recruiter_mcp.storage import LocalStorage
from recruiter_mcp.usage import track_usage

ROOT = Path(__file__).resolve().parents[1]
RESUMES = ROOT / "tests" / "fixtures" / "resumes"
JOBS = ROOT / "tests" / "fixtures" / "jobs"
POSITIVE = {"shortlisted", "interviewed", "placed"}
K = 10


def eval_url() -> str:
    return get_settings().database_url.rsplit("/", 1)[0] + "/recruiter_eval"


async def ensure_db(url: str, fresh: bool) -> None:
    admin = get_settings().database_url
    conn = await asyncpg.connect(admin)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = 'recruiter_eval'")
        if fresh and exists:
            await conn.execute("DROP DATABASE recruiter_eval WITH (FORCE)")
            exists = False
        if not exists:
            await conn.execute("CREATE DATABASE recruiter_eval")
    finally:
        await conn.close()
    await migrate(url)


async def build_services(url: str) -> Services:
    settings = get_settings()
    pool = await create_pool(url)
    storage = LocalStorage(Path(tempfile.gettempdir()) / "recruiter-eval-files")
    return Services(settings=settings, pool=pool, storage=storage, normalizer=await load_normalizer(pool))


async def ingest_fixtures(svc: Services) -> dict:
    ids = sorted(p.stem for p in RESUMES.glob("c*.txt") if not p.stem.endswith("_v2"))
    have = await svc.pool.fetchval("SELECT count(*) FROM candidates")
    if have >= len(ids):
        print(f"using {have} already-ingested fixture candidates (pass --reingest to redo)")
        return {"ingested": 0, "cost_usd": 0.0}
    sem = asyncio.Semaphore(5)
    t0 = time.monotonic()
    costs: list[float] = []
    latencies: list[float] = []

    async def one(fid: str) -> None:
        pdf = RESUMES / f"{fid}.pdf"
        async with sem, track_usage(svc.pool, "eval_ingest") as t:
            s = time.monotonic()
            await ingest_resume(svc, resume_text=(RESUMES / f"{fid}.txt").read_text(encoding="utf-8"),
                                file_path=str(pdf) if pdf.exists() else None, source="other")
            latencies.append(time.monotonic() - s)
        costs.append(t.cost_usd)

    await asyncio.gather(*(one(f) for f in ids))
    print(f"ingested {len(ids)} fixtures in {time.monotonic() - t0:.1f}s "
          f"(avg {statistics.mean(latencies):.1f}s each, ${sum(costs):.4f})")
    return {"ingested": len(ids), "cost_usd": round(sum(costs), 6), "avg_latency_s": statistics.mean(latencies)}


async def diagnose_miss(svc: Services, job_id: str, result, cid: str) -> str:
    """Which funnel stage lost this candidate."""
    stored = await svc.pool.fetchrow(
        "SELECT rank, score FROM matches WHERE job_id = $1::uuid AND candidate_id = $2::uuid", job_id, cid)
    if stored and stored["rank"] is not None:
        return f"scored {stored['score']}, rank {stored['rank']}"
    where, params = matching.build_filter_sql(result.applied_filters)
    passes = await svc.pool.fetchval(
        f"SELECT count(*) FROM candidates WHERE id = ${len(params) + 1}::uuid AND {where}", *params, cid)
    if not passes:
        return "removed by hard filters"
    if result.funnel.rerank_failed:
        return "not in reranked set (vector pool, or its rerank call failed)"
    return "outside vector top-K"


async def run_fixtures(args) -> dict:
    url = eval_url()
    await ensure_db(url, fresh=args.reingest)
    svc = await build_services(url)
    try:
        ingest = await ingest_fixtures(svc)
        by_name = {r["name"]: str(r["id"]) for r in await svc.pool.fetch("SELECT id, name FROM candidates")}
        name_of_fixture = {p.stem: json.loads(p.read_text(encoding="utf-8"))["name"] for p in RESUMES.glob("c*.json")}

        job_files = sorted(JOBS.glob("*.json"))
        if args.jobs:
            job_files = [JOBS / f"{j}.json" for j in args.jobs]
        rows = []
        for jf in job_files:
            job = json.loads(jf.read_text(encoding="utf-8"))
            async with track_usage(svc.pool, "eval_match"):
                res = await matching.match_job(svc, jd_text=job["jd_text"], limit=K)
            top_ids = [c.candidate_id for c in res.candidates]
            name_by_id = {v: k for k, v in by_name.items()}
            expected = []
            for fid in job["expected_top"]:
                name = name_of_fixture[fid]
                cid = by_name.get(name)
                rank = top_ids.index(cid) + 1 if cid in top_ids else None
                why = None if rank else (await diagnose_miss(svc, res.job_id, res, cid) if cid else "not ingested")
                expected.append({"fixture": fid, "name": name, "rank": rank, "miss_reason": why})
            hits = sum(1 for e in expected if e["rank"])
            rows.append({
                "job": jf.stem,
                "job_id": res.job_id,
                "recall_at_10": hits / len(expected),
                "expected": expected,
                "top": [{"rank": c.rank, "name": name_by_id.get(c.candidate_id, c.name), "score": c.score}
                        for c in res.candidates],
                "funnel": res.funnel.model_dump(),
                "latency_s": res.stats.latency_ms / 1000,
                "cost_usd": res.stats.cost_usd,
                "llm_calls": res.stats.llm_calls,
                "input_tokens": res.stats.input_tokens,
                "output_tokens": res.stats.output_tokens,
                "cache_read_tokens": res.stats.cache_read_tokens,
                "note": res.note,
            })
            print_job(rows[-1])
        return summarize(rows, ingest)
    finally:
        await svc.pool.close()


def print_job(r: dict) -> None:
    print(f"\n== {r['job']}  recall@10={r['recall_at_10']:.2f}  latency={r['latency_s']:.1f}s  "
          f"cost=${(r['cost_usd'] or 0):.4f}  funnel={r['funnel']['total']}→{r['funnel']['after_filters']}"
          f"→{r['funnel']['reranked']} (rescored {r['funnel'].get('rescored', 0)})")
    for e in r["expected"]:
        mark = f"#{e['rank']}" if e["rank"] else f"MISS ({e['miss_reason']})"
        print(f"   expected {e['name']:<16} {mark}")
    print("   top: " + ", ".join(f"{t['name']} {t['score']}" for t in r["top"][:10]))
    if r["note"]:
        print(f"   note: {r['note']}")


def summarize(rows: list[dict], ingest: dict) -> dict:
    lat = [r["latency_s"] for r in rows]
    cost = [r["cost_usd"] for r in rows if r["cost_usd"] is not None]
    total_exp = sum(len(r["expected"]) for r in rows)
    total_hit = sum(1 for r in rows for e in r["expected"] if e["rank"])
    summary = {
        "jobs": len(rows),
        "recall_at_10_macro": round(statistics.mean(r["recall_at_10"] for r in rows), 3),
        "recall_at_10_micro": round(total_hit / total_exp, 3),
        "avg_latency_s": round(statistics.mean(lat), 2),
        "max_latency_s": round(max(lat), 2),
        "avg_cost_usd": round(statistics.mean(cost), 5) if cost else None,
        "avg_input_tokens": round(statistics.mean(r["input_tokens"] for r in rows)),
        "avg_output_tokens": round(statistics.mean(r["output_tokens"] for r in rows)),
        "avg_cache_read_tokens": round(statistics.mean(r["cache_read_tokens"] for r in rows)),
        "ingest": ingest,
        "model": get_settings().llm_model,
        "target_met": total_hit / total_exp >= 0.8,
    }
    print("\n" + "=" * 70)
    print(f"model {summary['model']}  |  recall@10 micro {summary['recall_at_10_micro']:.2f} "
          f"(macro {summary['recall_at_10_macro']:.2f})  target ≥0.80: {'PASS' if summary['target_met'] else 'FAIL'}")
    print(f"latency avg {summary['avg_latency_s']}s max {summary['max_latency_s']}s  |  cost avg "
          f"${summary['avg_cost_usd']}/match  |  tokens in {summary['avg_input_tokens']} "
          f"out {summary['avg_output_tokens']} cached {summary['avg_cache_read_tokens']}")
    return {"summary": summary, "jobs": rows}


async def run_feedback(args) -> dict:
    """Agreement between ranking and the recruiter's labels, from the main database."""
    pool = await create_pool()
    try:
        rows = await pool.fetch(
            """SELECT j.id AS job_id, j.title, m.rank, m.score, m.feedback_label
               FROM matches m JOIN jobs j ON j.id = m.job_id
               WHERE m.feedback_label IS NOT NULL ORDER BY j.created_at"""
        )
    finally:
        await pool.close()
    if not rows:
        print("no feedback labels recorded yet; call record_feedback after reviewing matches")
        return {"summary": {"labeled": 0}}
    jobs: dict = {}
    for r in rows:
        jobs.setdefault(str(r["job_id"]), {"title": r["title"], "items": []})["items"].append(r)
    per_job = []
    for jid, j in jobs.items():
        pos = [i for i in j["items"] if i["feedback_label"] in POSITIVE]
        neg = [i for i in j["items"] if i["feedback_label"] == "rejected"]
        top = [i for i in j["items"] if i["rank"] is not None and i["rank"] <= K]
        per_job.append({
            "job_id": jid,
            "title": j["title"],
            "positives": len(pos),
            "negatives": len(neg),
            # Positives the ranking put in the top 10; outsiders found via search count as misses.
            "recall_at_10": (sum(1 for i in pos if i["rank"] is not None and i["rank"] <= K) / len(pos))
            if pos else None,
            "precision_at_10": (sum(1 for i in top if i["feedback_label"] in POSITIVE) / len(top)) if top else None,
            "outside_results": sum(1 for i in pos if i["rank"] is None),
        })
    pos_scores = [r["score"] for r in rows if r["feedback_label"] in POSITIVE and r["score"] is not None]
    neg_scores = [r["score"] for r in rows if r["feedback_label"] == "rejected" and r["score"] is not None]
    recalls = [p["recall_at_10"] for p in per_job if p["recall_at_10"] is not None]
    precs = [p["precision_at_10"] for p in per_job if p["precision_at_10"] is not None]
    summary = {
        "labeled": len(rows),
        "jobs": len(per_job),
        "recall_at_10": round(statistics.mean(recalls), 3) if recalls else None,
        "precision_at_10_of_labeled": round(statistics.mean(precs), 3) if precs else None,
        "avg_score_positive": round(statistics.mean(pos_scores), 1) if pos_scores else None,
        "avg_score_rejected": round(statistics.mean(neg_scores), 1) if neg_scores else None,
        "positives_found_outside_results": sum(p["outside_results"] for p in per_job),
    }
    for p in per_job:
        print(f"{p['title'][:40]:<40} +{p['positives']} -{p['negatives']}  recall@10 {p['recall_at_10']}  "
              f"precision@10 {p['precision_at_10']}  found outside results {p['outside_results']}")
    print(json.dumps(summary, indent=2))
    return {"summary": summary, "jobs": per_job}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feedback", action="store_true", help="evaluate real feedback labels instead of fixtures")
    ap.add_argument("--reingest", action="store_true", help="recreate the eval DB and re-extract fixtures")
    ap.add_argument("--jobs", nargs="*", help="fixture job ids to run (default: all)")
    ap.add_argument("--json", type=Path, help="write the report to this file")
    args = ap.parse_args()
    report = asyncio.run(run_feedback(args) if args.feedback else run_fixtures(args))
    if args.json:
        args.json.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"wrote {args.json}")
    if not args.feedback and not report["summary"]["target_met"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
