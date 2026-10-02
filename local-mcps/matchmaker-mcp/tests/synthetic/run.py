"""Synthetic scale suite: generate (cached) -> ingest into `recruiter_synth` (only missing) -> match every job -> score
against spec ground truth.

Every stage is paid (OpenRouter) and skips work already done, so a rerun after a code change only pays for matching.
Usage (from the repo root, needs LLM_API_KEY):
  uv run python -m tests.synthetic.run                         # 1000 resumes, 50 jobs + the sample JD
  uv run python -m tests.synthetic.run --candidates 100 --jobs 5   # small, cheap smoke run (own seed corpus)
  uv run python -m tests.synthetic.run --candidates 300 --jobs 20 --model deepseek/deepseek-v4-flash --reingest
  uv run python -m tests.synthetic.run --generate-only
  uv run python -m tests.synthetic.run --only j000_sample_ai_engineer j004
  uv run python -m tests.synthetic.run --reingest              # drop the DB and ingest again (after extraction changes)
  uv run python -m tests.synthetic.run --rematch               # match every JD again (after match/rerank changes)

Metrics per job: strong = right family, every must-have, relevant years in range, location workable (incl.
relocation); acceptable = right family, half the must-haves, location workable.
  recall@10     strong fits in the top 10 / min(10, strong fits)
  precision@10  acceptable fits among results / results
  loc_bad       results whose location does not work for the job
Misses are attributed to the funnel stage that lost them: filters, vector pool, or scored too low.
"""

import argparse
import asyncio
import json
import statistics
import sys
import tempfile
import time
from collections import Counter
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

from .generate import Generator, load_text
from .specs import Candidate, Job, build, fit

HERE = Path(__file__).parent
OUT = HERE / "out"
DB = "recruiter_synth"
K = 10


def db_url() -> str:
    return get_settings().database_url.rsplit("/", 1)[0] + f"/{DB}"


async def ensure_db(fresh: bool) -> None:
    conn = await asyncpg.connect(get_settings().database_url)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", DB)
        if fresh and exists:
            await conn.execute(f"DROP DATABASE {DB} WITH (FORCE)")
            exists = False
        if not exists:
            await conn.execute(f"CREATE DATABASE {DB}")
    finally:
        await conn.close()
    await migrate(db_url())


async def ingest(svc: Services, candidates: list[Candidate], concurrency: int) -> dict:
    have = {r["email"] for r in await svc.pool.fetch("SELECT email FROM candidates")}
    todo = [(c, t) for c in candidates if c.email not in have and (t := load_text("resumes", c))]
    if not todo:
        print(f"ingest: all {len(have)} candidates already in {DB}")
        return {"ingested": 0, "cost_usd": 0.0}
    print(f"ingest: {len(todo)} resumes into {DB}")
    sem = asyncio.Semaphore(concurrency)
    costs: list[float] = []
    failed: list[str] = []

    async def one(c: Candidate, text: str) -> None:
        async with sem:
            try:
                async with track_usage(svc.pool, "synth_ingest") as t:
                    await ingest_resume(svc, resume_text=text, source="other")
                costs.append(t.cost_usd)
            except Exception as e:
                failed.append(f"{c.id}: {type(e).__name__}")
            if (len(costs) + len(failed)) % 50 == 0:
                print(f"  {len(costs) + len(failed)}/{len(todo)}  ${sum(costs):.3f}  failed {len(failed)}",
                      flush=True)

    t0 = time.monotonic()
    await asyncio.gather(*(one(c, t) for c, t in todo))
    print(f"ingest: {len(costs)} in {time.monotonic() - t0:.0f}s, ${sum(costs):.3f}, failed {len(failed)} {failed[:5]}")
    return {"ingested": len(costs), "failed": failed, "cost_usd": round(sum(costs), 4)}


async def miss_reason(svc: Services, job_id: str, applied, cid: str, rerank_failed: int) -> str:
    stored = await svc.pool.fetchrow(
        "SELECT rank, score FROM matches WHERE job_id = $1::uuid AND candidate_id = $2::uuid", job_id, cid)
    if stored and stored["rank"] is not None:
        return "scored_low"  # reranked, but below the cut or under MIN_MATCH_SCORE
    where, params = matching.build_filter_sql(applied)
    if not await svc.pool.fetchval(
            f"SELECT count(*) FROM candidates WHERE id = ${len(params) + 1}::uuid AND {where}", *params, cid):
        return "filtered"
    # Failed rerank calls leave no row, so with failures a missing row is ambiguous.
    return "pool_or_rerank_failed" if rerank_failed else "outside_pool"


async def evaluate(svc: Services, job: Job, text: str, by_email: dict[str, str],
                   candidates: list[Candidate], rematch: bool) -> dict:
    stored = None if rematch else await svc.pool.fetchval(
        "SELECT id::text FROM jobs WHERE jd_text = $1 ORDER BY created_at DESC LIMIT 1", text.strip())
    if stored:  # matched by an earlier (interrupted) run: score it again without paying
        res = await matching.get_job(svc, stored, limit=K)
    else:
        res = await matching.match_job(svc, jd_text=text, limit=K)
    fits = {by_email[c.email]: (c, fit(c, job)) for c in candidates if c.email in by_email}
    strong = {cid for cid, (_, f) in fits.items() if f["strong"]}
    acceptable = {cid for cid, (_, f) in fits.items() if f["acceptable"]}
    top = [c.candidate_id for c in res.candidates]
    hits = [cid for cid in top if cid in strong]
    misses = []
    for cid in strong - set(top):
        c, _ = fits[cid]
        misses.append({"id": c.id, "reason": await miss_reason(svc, res.job_id, res.applied_filters, cid,
                                                                     res.funnel.rerank_failed)})
    loc_bad = [fits[cid][0].id for cid in top if cid in fits and not fits[cid][1]["location_ok"]]
    off_family = [fits[cid][0].id for cid in top if cid in fits and not fits[cid][1]["family"]]
    return {
        "job": job.id,
        "title": job.title,
        "spec": {"must": job.must_haves, "years": [job.min_years, job.max_years], "mode": job.mode,
                 "cities": job.cities},
        "parsed": {"must": res.parsed_requirements.must_have_skills, "remote_ok": res.parsed_requirements.remote_ok,
                   "locations": res.parsed_requirements.locations,
                   "years": [res.parsed_requirements.min_years, res.parsed_requirements.max_years]},
        "location_keys": res.applied_filters.location_keys,
        "funnel": res.funnel.model_dump(),
        "strong": len(strong),
        "acceptable": len(acceptable),
        "returned": len(top),
        "recall_at_10": len(hits) / min(K, len(strong)) if strong else None,
        "precision_at_10": sum(cid in acceptable for cid in top) / len(top) if top else 0.0,
        "loc_bad": loc_bad,
        "off_family": off_family,
        "misses": misses,
        "top": [{"id": fits[c.candidate_id][0].id if c.candidate_id in fits else None, "score": c.score,
                 **(fits[c.candidate_id][1] if c.candidate_id in fits else {})} for c in res.candidates],
        "note": res.note,
        "reused": bool(stored),
        "latency_s": res.stats.latency_ms / 1000 if res.stats else 0.0,
        "cost_usd": res.stats.cost_usd if res.stats else None,
    }


def print_job(r: dict) -> None:
    rec = "  n/a" if r["recall_at_10"] is None else f"{r['recall_at_10']:.2f}"
    reasons = Counter(m["reason"] for m in r["misses"])
    print(f"{r['job']:<26} R@10 {rec}  P@10 {r['precision_at_10']:.2f}  strong {r['strong']:>2}  "
          f"ret {r['returned']:>2}  filt {r['funnel']['after_filters']:>4}  loc_bad {len(r['loc_bad'])}  "
          f"off_fam {len(r['off_family'])}  miss {dict(reasons)}  {r['latency_s']:.0f}s ${r['cost_usd'] or 0:.3f}")


def summarize(rows: list[dict], extra: dict) -> dict:
    recalls = [r["recall_at_10"] for r in rows if r["recall_at_10"] is not None]
    returned = sum(r["returned"] for r in rows)
    reasons = Counter(m["reason"] for r in rows for m in r["misses"])
    s = {
        "jobs": len(rows),
        "recall_at_10": round(statistics.mean(recalls), 3) if recalls else None,
        "precision_at_10": round(statistics.mean(r["precision_at_10"] for r in rows), 3),
        "loc_bad_rate": round(sum(len(r["loc_bad"]) for r in rows) / returned, 3) if returned else None,
        "off_family_rate": round(sum(len(r["off_family"]) for r in rows) / returned, 3) if returned else None,
        "short_lists": sum(r["returned"] < min(K, r["strong"]) for r in rows),
        "miss_reasons": dict(reasons),
        "avg_latency_s": round(statistics.mean(r["latency_s"] for r in rows), 1),
        "match_cost_usd": round(sum(r["cost_usd"] or 0 for r in rows), 3),
        **extra,
    }
    print("\n" + "=" * 100)
    print(json.dumps(s, indent=1))
    return s


async def main_async(args) -> int:
    settings = get_settings()
    if not settings.llm_api_key:
        print("LLM_API_KEY is not set (.env or environment)", file=sys.stderr)
        return 2
    candidates, jobs = build(args.seed, args.candidates, args.jobs,
                             sample_jd=(HERE / "sample_jd.txt").read_text(encoding="utf-8"))
    gen = Generator(settings.llm_api_key, settings.llm_base_url, args.gen_model or settings.llm_model)
    await gen.run(candidates, jobs)
    if gen.failed:
        print(f"generation: {len(gen.failed)} failed validation and are left out: {gen.failed[:5]}")
    if args.generate_only:
        return 0

    if args.model:
        # The system under test (extraction, JD parsing, scoring) on another model. Reasoning effort is dropped:
        # with require_parameters, providers of non-reasoning models would refuse the request.
        settings = settings.model_copy(update={"llm_model": args.model, "llm_reasoning_effort": None,
                                               "rerank_reasoning_effort": None})
    await ensure_db(args.reingest)
    pool = await create_pool(db_url())
    svc = Services(settings=settings, pool=pool, storage=LocalStorage(Path(tempfile.gettempdir()) / "recruiter-synth"),
                   normalizer=await load_normalizer(pool))
    try:
        ing = await ingest(svc, candidates, args.ingest_concurrency)
        by_email = {r["email"]: str(r["id"]) for r in await pool.fetch("SELECT id, email FROM candidates")}
        in_db = [c for c in candidates if c.email in by_email]
        print(f"corpus: {len(in_db)}/{len(candidates)} candidates in {DB}")

        todo = [(j, j.jd_text or load_text("jobs", j)) for j in jobs if not args.only or j.id in args.only]
        todo = [(j, t) for j, t in todo if t]
        sem = asyncio.Semaphore(args.match_concurrency)
        rows: list[dict] = []

        async def one(j: Job, text: str) -> None:
            async with sem:
                async with track_usage(pool, "synth_match"):
                    try:
                        r = await evaluate(svc, j, text, by_email, in_db, args.rematch)
                    except Exception as e:
                        print(f"{j.id}: match failed {type(e).__name__}: {e}")
                        return
                rows.append(r)
                print_job(r)

        print(f"matching {len(todo)} jobs")
        await asyncio.gather(*(one(j, t) for j, t in todo))
        rows.sort(key=lambda r: r["job"])
        summary = summarize(rows, {"generation_cost_usd": round(gen.cost, 3), "ingest": ing,
                                   "candidates": len(in_db), "model": settings.llm_model, "seed": args.seed})
        OUT.mkdir(exist_ok=True)
        path = OUT / f"report-{time.strftime('%Y%m%d-%H%M%S')}.json"
        path.write_text(json.dumps({"summary": summary, "jobs": rows}, indent=1, default=str), encoding="utf-8")
        print(f"wrote {path}")
        ok = summary["recall_at_10"] is not None and summary["recall_at_10"] >= args.min_recall
        return 0 if ok else 1
    finally:
        await pool.close()


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # progress shows up when piped to a log file
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", type=int, default=1000)
    ap.add_argument("--jobs", type=int, default=50)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--gen-model", help="model that writes the synthetic texts (default LLM_MODEL)")
    ap.add_argument("--model", help="model for ingest extraction, JD parsing and scoring (default LLM_MODEL); "
                                    "use --reingest when changing it, or the corpus mixes extractions")
    ap.add_argument("--generate-only", action="store_true")
    ap.add_argument("--reingest", action="store_true", help=f"drop {DB} and ingest everything again")
    ap.add_argument("--only", nargs="*", help="job ids to match")
    ap.add_argument("--rematch", action="store_true", help="match again even if this JD was matched before")
    ap.add_argument("--ingest-concurrency", type=int, default=8)
    ap.add_argument("--match-concurrency", type=int, default=3)
    ap.add_argument("--min-recall", type=float, default=0.7, help="exit 1 below this macro recall@10")
    sys.exit(asyncio.run(main_async(ap.parse_args())))


if __name__ == "__main__":
    main()
