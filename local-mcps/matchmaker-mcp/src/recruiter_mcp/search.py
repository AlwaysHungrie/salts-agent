"""search_candidates: free text + filters, no JD and no LLM. Embedding similarity, with skills named in
the query ranked first."""

import asyncpg

from .errors import ToolFailure
from .ingest import build_headline, rank_skills
from .locations import country_key, expand_job_locations, is_country
from .match import EXACT_SCAN_MAX_ROWS, build_filter_sql
from .models import AppliedFilters, CandidateProfile, SearchFilters, SearchHit, SearchResult
from .services import Services
from .skills import SkillNormalizer, alias_key

MAX_LIMIT = 100


def skills_in_query(query: str, normalizer: SkillNormalizer) -> list[str]:
    """Known skills mentioned in free text, longest phrase first: 'react native devs' -> ['React Native']."""
    tokens = alias_key(query).split()
    found: list[str] = []
    i = 0
    while i < len(tokens):
        for n in (3, 2, 1):
            phrase = " ".join(tokens[i:i + n])
            if len(tokens[i:i + n]) == n and phrase in normalizer.synonyms:
                canonical = normalizer.synonyms[phrase]
                if canonical not in found:
                    found.append(canonical)
                i += n
                break
        else:
            i += 1
    return found


def to_applied(f: SearchFilters, normalizer: SkillNormalizer) -> AppliedFilters:
    """A country in `locations` ("India") filters by country; it would restrict no city there."""
    skills = normalizer.normalize_all(f.skills or [])
    locations = f.locations or []
    countries = [*(f.countries or []), *(loc for loc in locations if is_country(loc))]
    keys = expand_job_locations([loc for loc in locations if not is_country(loc)])
    return AppliedFilters(
        location_keys=keys,
        remote_ok=not keys,
        min_years=f.min_years,
        max_years=f.max_years,
        max_notice_days=f.max_notice_days,
        max_resume_age_days=f.max_resume_age_days,
        must_have_skills=skills,
        min_must_have_skills=len(skills) or None,
        include_remote_candidates=f.include_remote,
        country_keys=list(dict.fromkeys(country_key(c) for c in countries if c.strip())),
    )


def _hit(row: asyncpg.Record, query_skills: list[str]) -> SearchHit:
    profile = CandidateProfile.model_validate_json(row["profile"])
    years = float(row["years_exp"]) if row["years_exp"] is not None else None
    skills = list(row["skills"])
    top = rank_skills(profile, skills)[:5]
    have = {s.lower() for s in skills}
    return SearchHit(
        candidate_id=str(row["id"]),
        name=row["name"],
        headline=build_headline(profile, years, top),
        location=row["location"],
        years_exp=years,
        notice_days=row["notice_days"],
        top_skills=top,
        matched_skills=[s for s in query_skills if s.lower() in have],
        similarity=round(float(row["similarity"]), 4) if row["similarity"] is not None else None,
        updated_at=row["updated_at"].isoformat(),
    )


async def search_candidates(
    svc: Services, query: str | None, filters: SearchFilters | None, limit: int = 20, offset: int = 0
) -> SearchResult:
    """One page of the ranked list; `offset` skips the candidates on earlier pages."""
    if not 1 <= limit <= MAX_LIMIT:
        raise ToolFailure("invalid_input", f"limit must be between 1 and {MAX_LIMIT}")
    if offset < 0:
        raise ToolFailure("invalid_input", "offset must be 0 or more")
    query = (query or "").strip()
    f = filters or SearchFilters()
    applied = to_applied(f, svc.normalizer)
    where, params = build_filter_sql(applied)
    query_skills = skills_in_query(query, svc.normalizer) if query else []

    async with svc.pool.acquire() as conn, conn.transaction():
        total = await conn.fetchval(f"SELECT count(*) FROM candidates WHERE {where}", *params)
        if query:
            [vec] = await svc.embedder.embed([query])
            vec_p = f"${len(params) + 1}"
            skills_p = f"${len(params) + 2}"
            if total > EXACT_SCAN_MAX_ROWS and not query_skills:
                await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
                await conn.execute(f"SET LOCAL hnsw.ef_search = {min(1000, max(100, (offset + limit) * 2))}")
            rows = await conn.fetch(
                f"""SELECT *, 1 - (embedding <=> {vec_p}) AS similarity,
                           cardinality(ARRAY(SELECT unnest(skills) INTERSECT
                                             SELECT unnest({skills_p}::text[]))) AS skill_hits
                    FROM candidates WHERE {where}
                    ORDER BY skill_hits DESC, embedding <=> {vec_p}, id LIMIT {int(limit)} OFFSET {int(offset)}""",
                *params, vec, query_skills,
            )
        else:
            rows = await conn.fetch(
                f"SELECT *, NULL::float AS similarity FROM candidates WHERE {where} "
                f"ORDER BY updated_at DESC, id LIMIT {int(limit)} OFFSET {int(offset)}",
                *params,
            )
    return SearchResult(
        query_skills=query_skills,
        total_matching=total,
        offset=offset,
        next_offset=offset + len(rows) if offset + len(rows) < total else None,
        candidates=[_hit(r, query_skills) for r in rows],
    )
