"""Benchmark the filter + vector stage at scale on a throwaway `recruiter_bench` database.

Loads N synthetic candidates (random unit vectors, random years/location/notice), builds the HNSW index,
then times match.vector_candidates for filters of different selectivity, on both the exact and HNSW paths,
and reports recall of the returned pool against an exact scan.

Usage: uv run python scripts/bench_vector.py [N=50000]
"""

import asyncio
import json
import random
import statistics
import sys
import time
import uuid

import asyncpg
import numpy as np
from pgvector.asyncpg import register_vector

from recruiter_mcp import match as matching
from recruiter_mcp.config import get_settings
from recruiter_mcp.migrate import migrate
from recruiter_mcp.models import AppliedFilters

CITIES = ["pune", "mumbai", "bengaluru", "hyderabad", "delhi", "chennai", "kolkata", "gurugram", "noida", "remote"]


# Real embeddings cluster (by role, domain); uniform random vectors in 1536-d are all nearly equidistant,
# which makes approximate-search recall meaningless. Fixed seed so the query hits a known cluster.
CENTERS = np.random.default_rng(42).standard_normal((200, 1536)).astype(np.float32)


def clustered(rng, n: int, dim: int) -> np.ndarray:
    centers = CENTERS[rng.integers(0, len(CENTERS), n), :dim]
    v = centers + 0.7 * rng.standard_normal((n, dim)).astype(np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def filters(**kw) -> AppliedFilters:
    base = dict(location_keys=[], remote_ok=True, min_years=None, max_years=None, max_notice_days=None,
                max_resume_age_days=None, must_have_skills=[], min_must_have_skills=None)
    return AppliedFilters(**{**base, **kw})


async def load(url: str, n: int, dim: int) -> None:
    conn = await asyncpg.connect(url)
    await register_vector(conn)
    have_rows = await conn.fetchval("SELECT count(*) FROM candidates") >= n
    have_index = await conn.fetchval("SELECT to_regclass('candidates_embedding_idx') IS NOT NULL")
    if have_rows and have_index:
        await conn.close()
        return
    await conn.execute("DROP INDEX IF EXISTS candidates_embedding_idx")
    if have_rows:
        await build_index(conn)
        await conn.close()
        return
    rng = np.random.default_rng(7)
    batch = 5000
    t = time.monotonic()
    for start in range(0, n, batch):
        vecs = clustered(rng, batch, dim)
        rows = []
        for i in range(batch):
            city = random.choice(CITIES)
            rows.append((
                uuid.uuid4(), f"Person {start + i}", city.title(), city,
                round(random.uniform(0, 20), 1), random.choice([0, 15, 30, 60, 90, None]),
                ["Python"], json.dumps({"summary": "x"}), "{}", "x", "x", vecs[i], uuid.uuid4().hex,
            ))
        await conn.copy_records_to_table(
            "candidates", records=rows,
            columns=["id", "name", "location", "location_key", "years_exp", "notice_days", "skills", "profile",
                     "raw_extraction", "summary", "resume_text", "embedding", "content_sha256"],
        )
    print(f"loaded {n} rows in {time.monotonic() - t:.1f}s")
    await build_index(conn)
    await conn.close()


async def build_index(conn) -> None:
    print("building HNSW index...")
    t = time.monotonic()
    await conn.execute("SET maintenance_work_mem = '512MB'")
    await conn.execute(
        "CREATE INDEX candidates_embedding_idx ON candidates USING hnsw (embedding vector_cosine_ops)"
    )
    await conn.execute("ANALYZE candidates")
    print(f"index built in {time.monotonic() - t:.1f}s")


async def time_query(pool, f: AppliedFilters, vec, pool_size=50, runs=10):
    times, result = [], None
    for _ in range(runs):
        async with pool.acquire() as conn, conn.transaction():
            t = time.monotonic()
            result = await matching.vector_candidates(conn, f, vec, pool_size)
            times.append((time.monotonic() - t) * 1000)
    total, after, rows = result
    where, params = matching.build_filter_sql(f)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SET LOCAL enable_indexscan = off")
        exact = await conn.fetch(
            f"SELECT id FROM candidates WHERE {where} ORDER BY embedding <=> ${len(params) + 1} LIMIT {pool_size}",
            *params, vec)
    recall = len({r["id"] for r in rows} & {r["id"] for r in exact}) / max(1, len(exact))
    return statistics.median(times), max(times), after, len(rows), recall


async def main(n: int) -> None:
    s = get_settings()
    admin = s.database_url
    url = admin.rsplit("/", 1)[0] + "/recruiter_bench"
    conn = await asyncpg.connect(admin)
    if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = 'recruiter_bench'"):
        await conn.execute("CREATE DATABASE recruiter_bench")
    await conn.close()
    await migrate(url)
    await load(url, n, s.embed_dim)

    pool = await asyncpg.create_pool(url, init=register_vector, min_size=1, max_size=2)
    vec = clustered(np.random.default_rng(1), 1, s.embed_dim)[0]

    cases = {
        "no filters": filters(),
        "years 4-10 (~30%)": filters(min_years=4, max_years=10),
        "years 4-10 + pune, notice<=30 (~1.5%)": filters(min_years=4, max_years=10, location_keys=["pune"],
                                                         remote_ok=False, max_notice_days=30),
        "very selective (~0.2%)": filters(min_years=9, max_years=9.5, location_keys=["kolkata"], remote_ok=False,
                                          max_notice_days=0),
    }
    print(f"\n{'case':42} {'median':>8} {'max':>8} {'filtered':>9} {'returned':>9} {'recall':>7}")
    for name, f in cases.items():
        for exact_max in (matching.EXACT_SCAN_MAX_ROWS, 0):
            matching.EXACT_SCAN_MAX_ROWS = exact_max
            med, mx, after, got, rec = await time_query(pool, f, vec)
            path = "exact" if after <= exact_max else "hnsw"
            print(f"{name:42} {med:7.1f}ms {mx:7.1f}ms {after:9d} {got:9d} {rec:7.2f}  [{path}]")
        matching.EXACT_SCAN_MAX_ROWS = 20_000

    await pool.close()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 50_000))
