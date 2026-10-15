"""Benchmark on a public, graded dataset: Hugging Face `cnamuangtoun/resume-job-description-fit`, test split.
Real resumes and real job postings; each labelled pair is Good Fit, Potential Fit or No Fit (71 jobs, 477 resumes,
1,759 pairs, median 20 labelled resumes per job). The dataset has no card, so who graded it is unknown.

Every resume goes into one pool; every job is ranked against the whole pool. Per job, on its labelled resumes:
  ndcg@5, ndcg@10   order the labelled resumes by the system's ranking (gain Good 2, Potential 1, No 0)
  auc               chance a Good Fit is ranked above a No Fit
  good_r@10         Good Fits in the system's top 10 of the whole pool / min(10, Good Fits); unlabelled resumes
                    compete too, so this is the harder, retrieval-level number
`random` is the expected ndcg of a random order, as a floor.

Systems (all on the same model, so the comparison is the design, not the model):
  new  src/matchmaker: one profile call per resume, then hybrid search (BM25 + embeddings, rank fusion). Reported
       as bm25, embedding and hybrid on the posting; hybrid_query on a query a simulated agent writes from the
       posting (one call per job); +judge where the simulated agent reads the top 50 profiles in batches of 10 and
       reorders them by how well each fits
  old  src/recruiter_mcp: extraction, then per job SQL filters, vector top 50 and one LLM rerank call per candidate.
       Location filtering is switched off (remote_ok): the postings are American, the old city table Indian, and
       the labels ignore location.

Usage (needs LLM_API_KEY; paid):
  uv run python -m tests.benchmarks.resume_job_fit --system new
  uv run python -m tests.benchmarks.resume_job_fit --system old --jobs 20
"""

import argparse
import asyncio
import csv
import hashlib
import json
import math
import os
import random
import statistics
import sys
import tempfile
import time
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Literal

import asyncpg
from dotenv import dotenv_values

from matchmaker.models import LLMModel

HERE = Path(__file__).parent
DATA = HERE / "data"
OUT = HERE / "out"
URL = "https://huggingface.co/datasets/cnamuangtoun/resume-job-description-fit/resolve/main/test.csv"
GAIN = {"Good Fit": 2, "Potential Fit": 1, "No Fit": 0}
MODEL = "openai/gpt-5-nano"
K = 10


def sha(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def load() -> tuple[dict[str, str], dict[str, str], dict[str, dict[str, str]]]:
    """(resumes by hash, jobs by hash, labels[job hash][resume hash])."""
    path = DATA / "test.csv"
    if not path.exists():
        DATA.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(URL, path)
    csv.field_size_limit(10**9)
    resumes, jobs, labels = {}, {}, defaultdict(dict)
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            rh, jh = sha(r["resume_text"]), sha(r["job_description_text"])
            resumes[rh], jobs[jh] = r["resume_text"].strip(), r["job_description_text"].strip()
            labels[jh][rh] = r["label"]
    return resumes, jobs, labels


def pick_jobs(jobs: dict[str, str], labels: dict, n: int | None) -> list[str]:
    """Jobs with at least one Good Fit and five labelled resumes, in a fixed order; the first n."""
    usable = sorted(h for h in jobs if len(labels[h]) >= 5 and "Good Fit" in labels[h].values())
    return usable[:n] if n else usable


# ------------------------------------------------------------------ metrics


def dcg(gains: list[int], k: int) -> float:
    return sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(gains[:k]))


def ndcg(gains: list[int], k: int) -> float:
    ideal = dcg(sorted(gains, reverse=True), k)
    return dcg(gains, k) / ideal if ideal else 0.0


def score_job(order: list[str], labelled: dict[str, str]) -> dict:
    """`order`: resume hashes, best first, as far as the system ranked them. Labelled resumes it did not rank go
    last in a fixed (hash) order."""
    pos = {h: i for i, h in enumerate(order)}
    ranked = sorted(labelled, key=lambda h: (pos.get(h, len(order)), h))
    gains = [GAIN[labelled[h]] for h in ranked]
    good = [h for h in labelled if labelled[h] == "Good Fit"]
    bad = [h for h in labelled if labelled[h] == "No Fit"]
    place = {h: i for i, h in enumerate(ranked)}
    auc = (statistics.mean(1.0 if place[g] < place[b] else 0.0 for g in good for b in bad)
           if good and bad else None)
    rng = random.Random(0)
    rand = statistics.mean(ndcg(rng.sample(gains, len(gains)), K) for _ in range(200))
    return {"labelled": len(labelled), "good": len(good), "ndcg@5": ndcg(gains, 5), "ndcg@10": ndcg(gains, K),
            "auc": auc, "good_r@10": len(set(order[:K]) & set(good)) / min(K, len(good)), "random": rand}


def summarize(rows: list[dict]) -> dict:
    def m(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return round(statistics.mean(vals), 3) if vals else None
    return {k: m(k) for k in ("ndcg@5", "ndcg@10", "auc", "good_r@10", "random")} | {"jobs": len(rows)}


async def ensure_db(url: str) -> None:
    base, name = url.rsplit("/", 1)
    conn = await asyncpg.connect(f"{base}/postgres")
    try:
        if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name):
            await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


async def gather_limited(n: int, coros) -> list:
    sem = asyncio.Semaphore(n)

    async def one(c):
        async with sem:
            return await c
    return await asyncio.gather(*(one(c) for c in coros), return_exceptions=True)


def report_failures(what: str, results: list) -> None:
    errors = [r for r in results if isinstance(r, BaseException)]
    if errors:
        print(f"{what}: {len(errors)} failed, e.g. {type(errors[0]).__name__}: {errors[0]}")


# ------------------------------------------------------------------ new system

QUERY_PROMPT = """You turn a job posting into a keyword search query over resumes. Write the role title and its common
alternative titles, the must-have skills, tools and domain, each with its usual other names or abbreviations. Leave
out company blurb, benefits and soft skills. 10-40 words, keywords only."""

JUDGE_PROMPT = """You are a recruiter screening candidates for one job. For each candidate profile decide:
- verdict: "fit" (does the job's role with its must-have skills), "partial" (related, missing some of it), or "no".
- extent: 0-100, how well they match the role and must-have skills; a partial fit's extent says how close it is.
Judge each candidate on their own profile against the job. Output every candidate id given, once."""

JUDGE_TOP = 50
JUDGE_BATCH = 10


class Query(LLMModel):
    query: str


class Verdict(LLMModel):
    id: str
    verdict: Literal["fit", "partial", "no"]
    extent: int


class Verdicts(LLMModel):
    candidates: list[Verdict]


class Cache:
    """Model answers by prompt hash, so a rerun pays only for what changed."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    async def get(self, llm, system: str, user: str, schema, name: str):
        key = sha(system + "\n" + user)
        if key not in self.data:
            self.data[key] = (await llm.structured(system, user, schema, name=name)).model_dump()
        return schema.model_validate(self.data[key])

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data), encoding="utf-8")


def by_rank(cands, key) -> list:
    """Order on one signal; people it does not rank go last, in id order."""
    return [c.person_id for c in sorted(cands, key=lambda c: (key(c) is None, key(c) or 0, c.person_id))]


async def judged(svc, cache: Cache, job_text: str, cands) -> list:
    """The simulated agent reads the top JUDGE_TOP in batches and reorders them: by extent, then search order."""
    top = cands[:JUDGE_TOP]
    batches = [top[i:i + JUDGE_BATCH] for i in range(0, len(top), JUDGE_BATCH)]

    async def one(batch):
        profiles = "\n\n".join(f'<candidate id="{c.person_id[:8]}">\n{c.profile}</candidate>' for c in batch)
        return await cache.get(svc.llm, JUDGE_PROMPT, f"<job>\n{job_text}\n</job>\n\n{profiles}", Verdicts,
                               "verdicts")
    extent = {}
    for v in (await asyncio.gather(*(one(b) for b in batches))):
        for c in v.candidates:
            extent[c.id] = max(0, min(100, c.extent))
    place = {c.person_id: n for n, c in enumerate(top)}
    order = sorted(top, key=lambda c: (-extent.get(c.person_id[:8], -1), place[c.person_id]))
    return [c.person_id for c in order] + [c.person_id for c in cands[JUDGE_TOP:]]


async def run_new(key: str, resumes, jobs, labels, job_ids, concurrency: int) -> tuple[dict, dict]:
    from matchmaker.billing import use_api_key
    from matchmaker.config import get_settings
    from matchmaker.jobs import find_candidates, post_job
    from matchmaker.people import add_document
    from matchmaker.services import Services
    from matchmaker.usage import track_usage

    root = DATA / "matchmaker"
    svc = Services(settings=get_settings().model_copy(update={"llm_model": MODEL, "data_dir": root}))
    cache = Cache(root / "cache.json")
    cost = {"people": 0.0, "jobs": 0.0, "queries": 0.0, "judge": 0.0}

    def stored() -> dict[str, str]:
        people = root / "people"
        return {json.loads((f / "person.json").read_text(encoding="utf-8"))["documents"]["resume"]["sha256"]: f.name
                for f in (people.iterdir() if people.is_dir() else []) if (f / "person.json").is_file()}

    with use_api_key(key):
        todo = [t for h, t in resumes.items() if h not in stored()]
        print(f"new: adding {len(todo)} of {len(resumes)} resumes")

        async def person(text):
            async with track_usage("add_document") as t:
                await add_document(svc, "resume", text=text)
            cost["people"] += t.cost_usd
        t0 = time.monotonic()
        report_failures("add_document", await gather_limited(concurrency, [person(t) for t in todo]))
        print(f"new: people done in {time.monotonic() - t0:.0f}s, ${cost['people']:.3f}")
        hash_of = {pid: h for h, pid in stored().items()}
        job_map_path = root / "jobs.json"
        job_map = json.loads(job_map_path.read_text(encoding="utf-8")) if job_map_path.exists() else {}

        async def one_job(jh):
            async with track_usage("post_job") as t:
                if jh not in job_map:
                    job_map[jh] = (await post_job(svc, jobs[jh])).job_id
            cost["jobs"] += t.cost_usd
            job_id = job_map[jh]
            everyone = len(resumes)
            posting = (await find_candidates(svc, job_id, limit=everyone)).candidates
            async with track_usage("query") as t:
                q = (await cache.get(svc.llm, QUERY_PROMPT, jobs[jh], Query, "query")).query
                written = (await find_candidates(svc, job_id, query=q, limit=everyone)).candidates
            cost["queries"] += t.cost_usd
            async with track_usage("judge") as t:
                judged_posting = await judged(svc, cache, jobs[jh], posting)
                judged_written = await judged(svc, cache, jobs[jh], written)
            cost["judge"] += t.cost_usd
            orders = {
                "bm25": by_rank(posting, lambda c: c.keyword_rank),
                "embedding": by_rank(posting, lambda c: c.meaning_rank),
                "hybrid": [c.person_id for c in posting],
                "hybrid_query": [c.person_id for c in written],
                "hybrid+judge": judged_posting,
                "hybrid_query+judge": judged_written,
            }
            return {name: {"job": jh[:12], **score_job([hash_of[p] for p in order if p in hash_of], labels[jh])}
                    for name, order in orders.items()} | {"query": q}

        # Build the index once before the jobs run in parallel.
        from matchmaker.search import index
        index(svc)
        results = await gather_limited(4, [one_job(jh) for jh in job_ids])
        job_map_path.write_text(json.dumps(job_map), encoding="utf-8")
        cache.save()
        report_failures("jobs", results)
    rows = [r for r in results if isinstance(r, dict)]
    return {name: [r[name] for r in rows] for name in rows[0] if name != "query"} if rows else {}, cost


# ------------------------------------------------------------------ old system


async def run_old(key: str, resumes, jobs, labels, job_ids, concurrency: int) -> tuple[list[dict], dict]:
    os.environ.setdefault("LLM_API_KEY", key)
    from recruiter_mcp import match as matching
    from recruiter_mcp.config import get_settings
    from recruiter_mcp.db import create_pool
    from recruiter_mcp.ingest import ingest_resume
    from recruiter_mcp.migrate import migrate
    from recruiter_mcp.models import MatchFilters
    from recruiter_mcp.services import Services, load_normalizer
    from recruiter_mcp.storage import LocalStorage
    from recruiter_mcp.usage import track_usage

    url = get_settings().database_url.rsplit("/", 1)[0] + "/recruiter_hf"
    await ensure_db(url)
    await migrate(url)
    settings = get_settings().model_copy(update={"database_url": url, "llm_model": MODEL, "llm_api_key": key,
                                                 "embed_api_key": key})
    pool = await create_pool(url)
    svc = Services(settings=settings, pool=pool, storage=LocalStorage(Path(tempfile.gettempdir()) / "recruiter-hf"),
                   normalizer=await load_normalizer(pool))
    cost = {"people": 0.0, "jobs": 0.0}
    try:
        print(f"old: {await pool.fetchval('SELECT count(*) FROM candidates')} candidates stored, sending all "
              f"{len(resumes)} (a stored one comes back as duplicate_file, without a model call)")

        async def person(text):
            async with track_usage(pool, "hf_ingest") as t:
                res = await ingest_resume(svc, resume_text=text, source="other")
            cost["people"] += t.cost_usd
            return sha(text), res.candidate_id
        t0 = time.monotonic()
        results = await gather_limited(concurrency, [person(t) for t in resumes.values()])
        report_failures("ingest", results)
        mapping = dict(r for r in results if isinstance(r, tuple))
        print(f"old: people done in {time.monotonic() - t0:.0f}s, ${cost['people']:.3f}")
        hash_of = {cid: h for h, cid in mapping.items()}

        async def one_job(jh):
            job_id = await pool.fetchval("SELECT id::text FROM jobs WHERE jd_text = $1", jobs[jh])
            if job_id is None:
                async with track_usage(pool, "hf_match") as t:
                    job_id = (await matching.match_job(svc, jd_text=jobs[jh], limit=K,
                                                       filters=MatchFilters(remote_ok=True))).job_id
                cost["jobs"] += t.cost_usd
            rows = await pool.fetch("SELECT candidate_id::text AS c FROM matches WHERE job_id = $1::uuid"
                                    " AND rank IS NOT NULL ORDER BY rank", job_id)
            order = [hash_of[r["c"]] for r in rows if r["c"] in hash_of]
            return {"job": jh[:12], "listed": len(order), **score_job(order, labels[jh])}
        results = await gather_limited(3, [one_job(jh) for jh in job_ids])
        report_failures("jobs", results)
        return [r for r in results if isinstance(r, dict)], cost
    finally:
        await pool.close()


async def main_async(args) -> int:
    key = os.environ.get("LLM_API_KEY") or dotenv_values(".env").get("LLM_API_KEY")
    if not key:
        print("LLM_API_KEY is not set (.env or environment)", file=sys.stderr)
        return 2
    resumes, jobs, labels = load()
    job_ids = pick_jobs(jobs, labels, args.jobs)
    print(f"dataset: {len(resumes)} resumes, {len(jobs)} jobs, {len(job_ids)} used")
    run = run_new if args.system == "new" else run_old
    rows, cost = await run(key, resumes, jobs, labels, job_ids, args.concurrency)
    systems = rows if isinstance(rows, dict) else {args.system: rows}
    for r in systems.values():
        r.sort(key=lambda r: r["job"])
    summary = {"model": MODEL, "cost_usd": {k: round(v, 4) for k, v in cost.items()},
               "systems": {name: summarize(r) for name, r in systems.items()}}
    print(json.dumps(summary, indent=1))
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{args.system}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps({"summary": summary, "jobs": systems, "job_ids": job_ids}, indent=1),
                    encoding="utf-8")
    print(f"wrote {path}")
    return 0


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--system", choices=["new", "old"], required=True)
    ap.add_argument("--jobs", type=int, help="first N usable jobs (default all)")
    ap.add_argument("--concurrency", type=int, default=12)
    sys.exit(asyncio.run(main_async(ap.parse_args())))


if __name__ == "__main__":
    main()
