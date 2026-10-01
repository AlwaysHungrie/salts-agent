"""Match funnel: parse JD -> SQL hard filters -> pgvector top-K -> concurrent LLM rerank -> top N."""

import asyncio
import json
import logging
import re
import time
import uuid

import asyncpg

from .billing import is_fatal
from .errors import ToolFailure
from .locations import expand_job_locations
from .models import (
    AppliedFilters,
    CandidateScore,
    FeedbackResult,
    Funnel,
    JobRequirements,
    JobSummary,
    ListJobsResult,
    MatchCandidate,
    MatchFilters,
    MatchResult,
    MatchStats,
    ScoreBreakdown,
)
from .prompts import render
from .services import Services
from .skills import SkillNormalizer, save_learned
from .usage import current_records

log = logging.getLogger(__name__)

# Up to this many filtered rows, scan exactly: ~130 ms at 20k rows, perfect recall, and trivial next to the
# rerank. Above it, use HNSW (see vector_candidates).
EXACT_SCAN_MAX_ROWS = 20_000
MAX_LIMIT = 50
UNKNOWN_YEARS_CONCERN = "Experience unknown: no role dates on the resume"
DEALBREAKER_DISAGREE_CONCERN = "Possible dealbreaker: two scoring runs disagreed; check manually"


# ------------------------------------------------------------------ filters


def merge_filters(
    req: JobRequirements,
    explicit: MatchFilters | None,
    normalizer: SkillNormalizer,
    *,
    slack_below: float = 1.0,
    slack_above: float = 2.0,
) -> AppliedFilters:
    """Explicit filters win field by field. Years parsed from the JD get slack; explicit years are exact."""
    f = explicit or MatchFilters()
    set_fields = f.model_fields_set

    def pick(name, parsed):
        return getattr(f, name) if name in set_fields and getattr(f, name) is not None else parsed

    min_years = (
        f.min_years if "min_years" in set_fields
        else (max(0.0, req.min_years - slack_below) if req.min_years is not None else None)
    )
    max_years = (
        f.max_years if "max_years" in set_fields
        else (req.max_years + slack_above if req.max_years is not None else None)
    )
    locations = pick("locations", req.locations) or []
    return AppliedFilters(
        location_keys=expand_job_locations(locations),
        remote_ok=bool(pick("remote_ok", req.remote_ok)),
        min_years=min_years,
        max_years=max_years,
        max_notice_days=f.max_notice_days,
        max_resume_age_days=f.max_resume_age_days,
        must_have_skills=normalizer.normalize_requirements(req.must_have_skills),
        min_must_have_skills=f.min_must_have_skills,
    )


def alternatives(requirement: str) -> list[str]:
    """"Tally or SAP" -> ["Tally", "SAP"]; "Python" -> ["Python"]."""
    return [a.strip() for a in re.split(r"\s+or\s+", requirement) if a.strip()]


def coverage_sql(must_haves: list[str], first_param: int) -> tuple[str, list]:
    """SQL for the fraction (0-1) of must-have requirements in `skills`, plus its params."""
    groups = [alternatives(m) for m in must_haves]
    terms = [f"(skills && ${first_param + i}::text[])::int" for i in range(len(groups))]
    return f"(({' + '.join(terms)})::float / {len(groups)})", groups


def build_filter_sql(f: AppliedFilters, first_param: int = 1) -> tuple[str, list]:
    """WHERE clause over `candidates` plus its params. Unknown values (NULL) pass every filter."""
    clauses: list[str] = []
    params: list = []

    def p(value) -> str:
        params.append(value)
        return f"${first_param + len(params) - 1}"

    if f.min_years is not None:
        clauses.append(f"(years_exp IS NULL OR years_exp >= {p(f.min_years)})")
    if f.max_years is not None:
        clauses.append(f"(years_exp IS NULL OR years_exp <= {p(f.max_years)})")
    if not f.remote_ok and f.location_keys:
        # In one of the cities, or willing to move: to a preferred location there, or anywhere if none is listed.
        # Remote-only candidates do not fit an office job unless the caller includes them.
        keys = p(f.location_keys)
        remote = " OR location_key = 'remote'" if f.include_remote_candidates else ""
        clauses.append(
            f"(location_key IS NULL{remote} OR location_key = ANY({keys}::text[])"
            f" OR preferred_location_keys && {keys}::text[]"
            f" OR (willing_to_relocate AND preferred_location_keys = '{{}}'))"
        )
    if f.country_keys:
        clauses.append(f"(country_keys = '{{}}' OR country_keys && {p(f.country_keys)}::text[])")
    if f.max_notice_days is not None:
        clauses.append(f"(notice_days IS NULL OR notice_days <= {p(f.max_notice_days)})")
    if f.max_resume_age_days is not None:
        clauses.append(f"updated_at >= now() - make_interval(days => {p(f.max_resume_age_days)})")
    if f.min_must_have_skills and f.must_have_skills:
        # Each requirement is one skill or "X or Y" alternatives; a candidate meets it with any alternative.
        groups = [alternatives(m) for m in f.must_have_skills]
        k = min(f.min_must_have_skills, len(groups))
        if k == len(groups) and all(len(g) == 1 for g in groups):
            clauses.append(f"skills @> {p([g[0] for g in groups])}::text[]")  # GIN-indexed
        else:
            met = " + ".join(f"(skills && {p(g)}::text[])::int" for g in groups)
            clauses.append(f"({met}) >= {p(k)}")
    return (" AND ".join(clauses) or "TRUE"), params


# ------------------------------------------------------------------ helpers


def job_embedding_text(req: JobRequirements, title: str) -> str:
    """title + summary + must-haves + nice-to-haves, mirroring the candidate embedding text."""
    return "\n".join([
        title,
        req.summary,
        "Must have: " + ", ".join(req.must_have_skills),
        "Nice to have: " + ", ".join(req.nice_to_have_skills),
    ])


def scoring_requirements(req: JobRequirements, explicit: MatchFilters | None) -> JobRequirements:
    """What the reranker judges against: the parsed JD with the recruiter's explicit overrides applied,
    so logistics points agree with the filters actually used."""
    if explicit is None:
        return req
    update = {
        k: getattr(explicit, k)
        for k in ("locations", "remote_ok", "min_years", "max_years")
        if k in explicit.model_fields_set and getattr(explicit, k) is not None
    }
    return req.model_copy(update=update) if update else req


def scoring_view(row: asyncpg.Record) -> str:
    """Profile for the reranker without name/email/phone, plus the code-computed facts."""
    profile = json.loads(row["profile"])
    for key in ("name", "email", "phone"):
        profile.pop(key, None)
    profile["years_exp_computed"] = float(row["years_exp"]) if row["years_exp"] is not None else None
    return json.dumps(profile, ensure_ascii=False)


def _stats(started: float) -> MatchStats:
    recs = current_records()
    costs = [r.cost_usd for r in recs if r.cost_usd is not None]
    return MatchStats(
        latency_ms=int((time.monotonic() - started) * 1000),
        llm_calls=sum(1 for r in recs if r.kind == "llm"),
        input_tokens=sum(r.input_tokens for r in recs),
        output_tokens=sum(r.output_tokens for r in recs),
        cache_read_tokens=sum(r.cache_read_tokens for r in recs),
        cost_usd=round(sum(costs), 6) if costs else None,
    )


def _note(funnel: Funnel, returned: int, omitted_low: int, limit: int, min_score: int) -> str | None:
    parts = []
    if funnel.after_filters == 0:
        parts.append("No candidates passed the filters. Try widening locations, years or notice period.")
    elif funnel.after_filters < limit:
        parts.append(f"Only {funnel.after_filters} candidates passed the filters.")
    if omitted_low and returned < limit:
        parts.append(f"{omitted_low} scored below {min_score} and were left out rather than padding the list.")
    if funnel.rerank_failed:
        parts.append(f"{funnel.rerank_failed} candidates could not be scored (LLM errors) and were skipped.")
    return " ".join(parts) or None


# ------------------------------------------------------------------ funnel


async def parse_job(svc: Services, jd_text: str) -> JobRequirements:
    system, user = render("parse_job", jd_text=jd_text)
    req = await svc.llm.structured(system, user, JobRequirements, name="job_requirements")
    req = req.model_copy(update={
        "must_have_skills": svc.normalizer.normalize_requirements(req.must_have_skills),
        "nice_to_have_skills": svc.normalizer.normalize_all(req.nice_to_have_skills),
    })
    await save_learned(svc.pool, svc.normalizer)
    return req


async def vector_candidates(
    conn: asyncpg.Connection, f: AppliedFilters, job_vec: list[float], pool_size: int, skill_boost: float = 0.0
) -> tuple[int, int, list[asyncpg.Record]]:
    """Returns (total, after_filters, top rows). Must run inside a transaction.
    Rows are ordered by cosine similarity plus `skill_boost` x the fraction of must-haves in their skills, so a
    candidate with every must-have but a vaguely worded profile still reaches the rerank (exact path only; the
    HNSW path can only order by distance)."""
    where, params = build_filter_sql(f, first_param=1)
    total = await conn.fetchval("SELECT count(*) FROM candidates")
    after = await conn.fetchval(f"SELECT count(*) FROM candidates WHERE {where}", *params)
    if after == 0:
        return total, 0, []
    vec_param = f"${len(params) + 1}"
    order = f"embedding <=> {vec_param}"
    extra: list = []
    if after <= EXACT_SCAN_MAX_ROWS:
        await conn.execute("SET LOCAL enable_indexscan = off")
        if skill_boost and f.must_have_skills:
            cov, extra = coverage_sql(f.must_have_skills, len(params) + 2)
            order = f"({order}) - {float(skill_boost)} * {cov}"
    else:
        # HNSW applies WHERE after its search, and returns at most ef_search rows (default 40 < pool size).
        # Iterative scan keeps searching until LIMIT rows pass the filter. With it on, the planner tends to
        # pick a slow seq scan instead, so force the index for this transaction.
        await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
        await conn.execute(f"SET LOCAL hnsw.ef_search = {max(100, pool_size * 2)}")
        await conn.execute("SET LOCAL enable_seqscan = off")
        await conn.execute("SET LOCAL enable_bitmapscan = off")
    rows = await conn.fetch(
        f"""SELECT id, name, location, years_exp, notice_days, profile,
                   1 - (embedding <=> {vec_param}) AS similarity
            FROM candidates WHERE {where}
            ORDER BY {order} LIMIT {int(pool_size)}""",
        *params, job_vec, *extra,
    )
    if after > EXACT_SCAN_MAX_ROWS:
        # relaxed_order can return slightly out-of-order rows.
        rows = sorted(rows, key=lambda r: r["similarity"], reverse=True)
    return total, after, rows


async def rerank(
    svc: Services, req: JobRequirements, rows: list[asyncpg.Record]
) -> list[tuple[asyncpg.Record, CandidateScore]]:
    requirements_json = req.model_dump_json()
    sem = asyncio.Semaphore(max(1, svc.settings.rerank_concurrency))

    async def score(row: asyncpg.Record) -> tuple[asyncpg.Record, CandidateScore] | None:
        # Job + rubric form an identical system prefix across calls, so providers can cache it.
        system, user = render("score_candidate", requirements_json=requirements_json, profile_json=scoring_view(row))
        async with sem:
            try:
                s = await svc.llm.structured(
                    system, user, CandidateScore, name="candidate_score",
                    reasoning_effort=svc.settings.rerank_reasoning_effort,
                )
            except Exception as e:
                if is_fatal(e):
                    raise  # bad key, no credits or spend cap: every other call would fail too
                log.warning("rerank failed candidate_id=%s error=%s", row["id"], type(e).__name__)
                return None
        return row, s

    results = await asyncio.gather(*(score(r) for r in rows))
    return [r for r in results if r is not None]


_NO_EVIDENCE = re.compile(r"\?|no (clear |explicit )?evidence|not (demonstrated|shown|mentioned)|unclear", re.I)


def clean_must_haves(sc: CandidateScore, must_haves: list[str]) -> CandidateScore:
    """Map the model's must_haves_met back to the job's skill names. Models annotate entries ('AWS (Lambda) -
    evidence: ...') and sometimes list skills they flag as unevidenced ('Python? (no explicit evidence)'); such
    entries don't count. Everything not met is missing."""
    heads = []
    for entry in sc.must_haves_met:
        if _NO_EVIDENCE.search(entry):
            continue
        heads.append(re.split(r"\s[(\-—:]|,", entry, maxsplit=1)[0].strip().lower())
    met = [m for m in must_haves
           if any(h == a.lower() or a.lower() in h for a in alternatives(m) for h in heads)]
    return sc.model_copy(update={"must_haves_met": met, "must_haves_missing": [m for m in must_haves if m not in met]})


def borderline_indices(totals: list[int], limit: int, min_score: int, margin: int) -> set[int]:
    """Indices of scores close enough to a cutoff that run-to-run noise could move them across it."""
    if margin <= 0 or not totals:
        return set()
    boundaries = [min_score - 0.5]
    passing = sorted((t for t in totals if t >= min_score), reverse=True)
    if len(passing) > limit:
        boundaries.append((passing[limit - 1] + passing[limit]) / 2)
    return {i for i, t in enumerate(totals) if any(abs(t - b) <= margin for b in boundaries)}


def average_scores(a: CandidateScore, b: CandidateScore) -> CandidateScore:
    """Average two scoring runs' points. Evidence lists and pitch come from the first run; concerns are merged.
    A dealbreaker counts only if both runs agree; disagreement becomes a concern instead of a silent cap."""
    concerns = a.concerns + [c for c in b.concerns if c not in a.concerns]
    if a.dealbreaker_violated != b.dealbreaker_violated:
        concerns.append(DEALBREAKER_DISAGREE_CONCERN)
    avg = lambda x, y: round((x + y) / 2)  # noqa: E731
    return a.model_copy(update={
        "must_have_points": avg(a.must_have_points, b.must_have_points),
        "experience_points": avg(a.experience_points, b.experience_points),
        "recency_points": avg(a.recency_points, b.recency_points),
        "nice_to_have_points": avg(a.nice_to_have_points, b.nice_to_have_points),
        "logistics_points": avg(a.logistics_points, b.logistics_points),
        "dealbreaker_violated": a.dealbreaker_violated and b.dealbreaker_violated,
        "concerns": concerns,
    })


async def rescore_borderline(
    svc: Services, req: JobRequirements, scored: list[tuple[asyncpg.Record, CandidateScore]], limit: int
) -> tuple[list[tuple[asyncpg.Record, CandidateScore]], int]:
    s = svc.settings
    totals = [sc.breakdown().total for _, sc in scored]
    picks = borderline_indices(totals, limit, s.min_match_score, s.rerank_borderline_margin)
    if not picks:
        return scored, 0
    second = {row["id"]: sc for row, sc in await rerank(svc, req, [scored[i][0] for i in sorted(picks)])}
    merged = [
        (row, average_scores(sc, second[row["id"]])) if i in picks and row["id"] in second else (row, sc)
        for i, (row, sc) in enumerate(scored)
    ]
    return merged, len(second)


async def match_job(
    svc: Services,
    *,
    jd_text: str,
    title: str | None = None,
    limit: int = 10,
    filters: MatchFilters | None = None,
) -> MatchResult:
    started = time.monotonic()
    jd_text = (jd_text or "").strip()
    if not jd_text:
        raise ToolFailure("invalid_input", "jd_text is required")
    if not 1 <= limit <= MAX_LIMIT:
        raise ToolFailure("invalid_input", f"limit must be between 1 and {MAX_LIMIT}")
    s = svc.settings

    # 1. Parse the JD and merge filters.
    req = await parse_job(svc, jd_text)
    title = (title or req.title or "Untitled role").strip()
    applied = merge_filters(req, filters, svc.normalizer,
                            slack_below=s.years_slack_below, slack_above=s.years_slack_above)
    [job_vec] = await svc.embedder.embed([job_embedding_text(req, title)])

    # 2 + 3. Hard filters, then vector recall.
    pool_size = max(s.rerank_pool_size, limit)
    async with svc.pool.acquire() as conn, conn.transaction():
        total, after, rows = await vector_candidates(conn, applied, job_vec, pool_size, s.pool_skill_boost)

    # 4. Rerank concurrently; one failed call drops one candidate.
    sreq = scoring_requirements(req, filters)
    scored = await rerank(svc, sreq, rows) if rows else []
    scored = [(row, clean_must_haves(sc, sreq.must_have_skills)) for row, sc in scored]
    if rows and not scored:
        raise ToolFailure("rerank_failed", "every rerank call failed; check LLM settings and server logs")
    # 4b. Second opinion for candidates near a cutoff, where scoring noise decides who is shown.
    scored, rescored = await rescore_borderline(svc, sreq, scored, limit)
    funnel = Funnel(total=total, after_filters=after, reranked=len(scored), rerank_failed=len(rows) - len(scored),
                    rescored=rescored)

    ranked: list[MatchCandidate] = []
    order = sorted(
        scored,
        key=lambda rs: (-rs[1].breakdown().total, -len(rs[1].must_haves_met), -rs[0]["similarity"]),
    )
    for i, (row, sc) in enumerate(order, start=1):
        bd: ScoreBreakdown = sc.breakdown()
        concerns = list(sc.concerns)
        profile = json.loads(row["profile"])
        if row["years_exp"] is None and UNKNOWN_YEARS_CONCERN not in concerns:
            concerns.append(UNKNOWN_YEARS_CONCERN)
        ranked.append(MatchCandidate(
            rank=i,
            candidate_id=str(row["id"]),
            name=row["name"],
            score=bd.total,
            one_line_pitch=sc.one_line_pitch,
            must_haves_met=sc.must_haves_met,
            must_haves_missing=sc.must_haves_missing,
            concerns=concerns,
            location=row["location"],
            willing_to_relocate=profile.get("willing_to_relocate"),
            preferred_locations=profile.get("preferred_locations") or [],
            years_exp=float(row["years_exp"]) if row["years_exp"] is not None else None,
            notice_days=row["notice_days"],
            score_breakdown=bd,
        ))

    good = [c for c in ranked if c.score >= s.min_match_score]
    returned = good[:limit]
    note = _note(funnel, len(returned), len(ranked) - len(good), limit, s.min_match_score)
    stats = _stats(started)

    # 5. Persist the job and every scored candidate (ranks beyond `limit` feed evaluation).
    job_id = uuid.uuid4()
    async with svc.pool.acquire() as conn, conn.transaction():
        created_at = await conn.fetchval(
            """INSERT INTO jobs (id, title, jd_text, requirements, filters, funnel, embedding, stats)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at""",
            job_id, title, jd_text, req.model_dump_json(), applied.model_dump_json(),
            funnel.model_dump_json(), job_vec, stats.model_dump_json(),
        )
        if ranked:
            await conn.executemany(
                "INSERT INTO matches (job_id, candidate_id, score, rank, result) VALUES ($1, $2, $3, $4, $5)",
                [(job_id, uuid.UUID(c.candidate_id), c.score, c.rank, c.model_dump_json()) for c in ranked],
            )
    log.info("match job_id=%s total=%d filtered=%d reranked=%d latency_ms=%d",
             job_id, total, after, len(scored), stats.latency_ms)

    return MatchResult(
        job_id=str(job_id),
        title=title,
        created_at=created_at.isoformat(),
        parsed_requirements=req,
        applied_filters=applied,
        funnel=funnel,
        candidates=returned,
        note=note,
        stats=stats,
    )


# ------------------------------------------------------------------ stored jobs


async def get_job(svc: Services, job_id: str, *, limit: int = 10, include_low_scores: bool = False) -> MatchResult:
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise ToolFailure("invalid_input", "job_id must be a UUID") from None
    job = await svc.pool.fetchrow("SELECT * FROM jobs WHERE id = $1", jid)
    if job is None:
        raise ToolFailure("not_found", f"no job {job_id}")
    min_score = -1 if include_low_scores else svc.settings.min_match_score
    rows = await svc.pool.fetch(
        """SELECT m.result, m.feedback_label, c.name, c.location, c.years_exp, c.notice_days
           FROM matches m JOIN candidates c ON c.id = m.candidate_id
           WHERE m.job_id = $1 AND m.score >= $2 ORDER BY m.rank LIMIT $3""",
        jid, min_score, max(1, min(limit, MAX_LIMIT)),
    )
    candidates = []
    for r in rows:
        c = MatchCandidate.model_validate_json(r["result"])
        # Current contact-free fields (the candidate may have been updated since the match).
        candidates.append(c.model_copy(update={
            "name": r["name"], "location": r["location"], "notice_days": r["notice_days"],
            "years_exp": float(r["years_exp"]) if r["years_exp"] is not None else None,
            "feedback_label": r["feedback_label"],
        }))
    return MatchResult(
        job_id=str(job["id"]),
        title=job["title"],
        created_at=job["created_at"].isoformat(),
        parsed_requirements=JobRequirements.model_validate_json(job["requirements"]),
        applied_filters=AppliedFilters.model_validate_json(job["filters"]),
        funnel=Funnel.model_validate_json(job["funnel"]),
        candidates=candidates,
        stats=MatchStats.model_validate_json(job["stats"]) if job["stats"] else None,
    )


async def list_jobs(svc: Services, *, limit: int = 20) -> ListJobsResult:
    rows = await svc.pool.fetch(
        """SELECT j.id, j.title, j.created_at, j.funnel,
                  (SELECT array_agg(c.name ORDER BY m.rank) FROM (
                      SELECT candidate_id, rank FROM matches WHERE job_id = j.id ORDER BY rank LIMIT 3
                  ) m JOIN candidates c ON c.id = m.candidate_id) AS top_names,
                  (SELECT count(*) FROM matches WHERE job_id = j.id AND feedback_label IS NOT NULL) AS fb
           FROM jobs j ORDER BY j.created_at DESC LIMIT $1""",
        max(1, min(limit, 100)),
    )
    return ListJobsResult(jobs=[
        JobSummary(
            job_id=str(r["id"]),
            title=r["title"],
            created_at=r["created_at"].isoformat(),
            funnel=Funnel.model_validate_json(r["funnel"]),
            top_candidates=[n or "(no name)" for n in (r["top_names"] or [])],
            feedback_count=r["fb"],
        )
        for r in rows
    ])


async def record_feedback(
    svc: Services, job_id: str, candidate_id: str, label: str, note: str | None = None
) -> FeedbackResult:
    """Label a candidate for a job. Works for candidates outside the scored matches too (e.g. found via
    search_candidates); those get a match row with no score or rank."""
    try:
        jid, cid = uuid.UUID(job_id), uuid.UUID(candidate_id)
    except ValueError:
        raise ToolFailure("invalid_input", "job_id and candidate_id must be UUIDs") from None
    async with svc.pool.acquire() as conn, conn.transaction():
        if not await conn.fetchval("SELECT 1 FROM jobs WHERE id = $1", jid):
            raise ToolFailure("not_found", f"no job {job_id}")
        if not await conn.fetchval("SELECT 1 FROM candidates WHERE id = $1", cid):
            raise ToolFailure("not_found", f"no candidate {candidate_id}")
        existing = await conn.fetchrow(
            "SELECT feedback_label, score FROM matches WHERE job_id = $1 AND candidate_id = $2 FOR UPDATE", jid, cid
        )
        if existing:
            await conn.execute(
                "UPDATE matches SET feedback_label = $3, feedback_note = $4 WHERE job_id = $1 AND candidate_id = $2",
                jid, cid, label, note,
            )
        else:
            await conn.execute(
                "INSERT INTO matches (job_id, candidate_id, feedback_label, feedback_note) VALUES ($1, $2, $3, $4)",
                jid, cid, label, note,
            )
    log.info("feedback job_id=%s candidate_id=%s label=%s", job_id, candidate_id, label)
    return FeedbackResult(
        job_id=job_id,
        candidate_id=candidate_id,
        label=label,
        previous_label=existing["feedback_label"] if existing else None,
        in_match_results=bool(existing and existing["score"] is not None),
    )
