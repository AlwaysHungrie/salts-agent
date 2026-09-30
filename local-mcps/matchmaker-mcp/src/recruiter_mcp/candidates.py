"""Candidate lookup (get_candidate) and hard delete."""

import logging
import uuid

import asyncpg

from .errors import ToolFailure
from .ingest import build_headline, rank_skills
from .models import (
    CandidateDetail,
    CandidateMatchRef,
    CandidateProfile,
    DeleteResult,
    GetCandidateResult,
    ResumeFileInfo,
    ResumeFileResult,
)
from .services import Services

log = logging.getLogger(__name__)


def parse_id(candidate_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(candidate_id)
    except ValueError:
        raise ToolFailure("invalid_input", "candidate_id must be a UUID") from None


def to_detail(svc: Services, row: asyncpg.Record) -> CandidateDetail:
    profile = CandidateProfile.model_validate_json(row["profile"])
    years = float(row["years_exp"]) if row["years_exp"] is not None else None
    skills = list(row["skills"])
    file_info = None
    if row["file_key"] and svc.storage.exists(row["file_key"]):
        path = svc.storage.path(row["file_key"])
        file_info = ResumeFileInfo(
            path=str(path),
            mime_type=row["file_mime"] or "application/octet-stream",
            size_bytes=path.stat().st_size,
        )
    return CandidateDetail(
        candidate_id=str(row["id"]),
        name=row["name"],
        email=row["email"],
        phone=row["phone"],
        location=row["location"],
        headline=build_headline(profile, years, rank_skills(profile, skills)),
        years_exp=years,
        notice_days=row["notice_days"],
        skills=skills,
        source=row["source"],
        notes=row["notes"],
        created_at=row["created_at"].isoformat(),
        updated_at=row["updated_at"].isoformat(),
        profile=profile,
        resume_file=file_info,
    )


def to_ref(row: asyncpg.Record) -> CandidateMatchRef:
    return CandidateMatchRef(
        candidate_id=str(row["id"]),
        name=row["name"],
        email=row["email"],
        location=row["location"],
        current_title=row["current_title"],
        years_exp=float(row["years_exp"]) if row["years_exp"] is not None else None,
    )


async def fetch_row(pool: asyncpg.Pool, candidate_id: str) -> asyncpg.Record | None:
    return await pool.fetchrow("SELECT * FROM candidates WHERE id = $1", parse_id(candidate_id))


async def get_candidate(svc: Services, candidate_id: str | None, query: str | None) -> GetCandidateResult:
    if bool(candidate_id) == bool(query):
        raise ToolFailure("invalid_input", "send exactly one of candidate_id or query")
    if candidate_id:
        row = await fetch_row(svc.pool, candidate_id)
        if row is None:
            return GetCandidateResult(status="not_found")
        return GetCandidateResult(status="found", candidate=to_detail(svc, row))

    q = query.strip()
    if "@" in q:
        rows = await svc.pool.fetch("SELECT id FROM candidates WHERE email = $1", q.lower())
    else:
        # Exact (case-insensitive) name matches win; otherwise trigram similarity.
        rows = await svc.pool.fetch(
            "SELECT id FROM candidates WHERE lower(name) = lower($1)", q
        ) or await svc.pool.fetch(
            """SELECT id FROM candidates
               WHERE name % $1 OR name ILIKE '%' || $1 || '%'
               ORDER BY similarity(name, $1) DESC LIMIT 10""",
            q,
        )
    if not rows:
        return GetCandidateResult(status="not_found")
    if len(rows) == 1:
        row = await fetch_row(svc.pool, str(rows[0]["id"]))
        return GetCandidateResult(status="found", candidate=to_detail(svc, row))
    refs = await svc.pool.fetch(
        "SELECT id, name, email, location, years_exp, profile->>'current_title' AS current_title"
        " FROM candidates WHERE id = ANY($1::uuid[])",
        [r["id"] for r in rows],
    )
    order = {r["id"]: i for i, r in enumerate(rows)}
    refs = sorted(refs, key=lambda r: order[r["id"]])
    return GetCandidateResult(status="ambiguous", matches=[to_ref(r) for r in refs])


async def get_resume_file(svc: Services, candidate_id: str | None, query: str | None) -> ResumeFileResult:
    """Just where the original PDF is, plus the sentence the agent should say. No profile data."""
    found = await get_candidate(svc, candidate_id, query)
    if found.status == "not_found":
        return ResumeFileResult(status="not_found", message_for_user="No candidate matches that name, email or id.")
    if found.status == "ambiguous":
        names = ", ".join(m.name or m.candidate_id for m in found.matches)
        return ResumeFileResult(status="ambiguous", matches=found.matches,
                                message_for_user=f"Several candidates match: {names}. Which one?")
    c = found.candidate
    if c.resume_file is None:
        return ResumeFileResult(
            status="no_file", candidate_id=c.candidate_id, name=c.name,
            message_for_user=f"{c.name or 'This candidate'}'s original resume file was not stored (only the text "
            "was ingested), so there is no file to open. Re-add the PDF to keep a copy.",
        )
    return ResumeFileResult(
        status="found", candidate_id=c.candidate_id, name=c.name, path=c.resume_file.path,
        message_for_user=f"{c.name or 'The candidate'}'s resume is stored on your computer at: {c.resume_file.path}",
    )


async def delete_candidate(svc: Services, candidate_id: str) -> DeleteResult:
    """Hard delete for data-privacy requests: candidate row, versions, match rows, and every stored file.
    Usage rows hold no candidate data. Logs hold IDs only."""
    cid = parse_id(candidate_id)
    async with svc.pool.acquire() as conn, conn.transaction():
        if not await conn.fetchval("SELECT 1 FROM candidates WHERE id = $1 FOR UPDATE", cid):
            # Row already gone: finish a previously interrupted delete by removing leftover files.
            files = svc.storage.delete_candidate(str(cid))
            if files:
                return DeleteResult(candidate_id=str(cid), deleted=True, versions_deleted=0, matches_deleted=0,
                                    files_deleted=files)
            raise ToolFailure("not_found", f"no candidate {candidate_id}")
        versions = await conn.fetchval("SELECT count(*) FROM candidate_versions WHERE candidate_id = $1", cid)
        matches = await conn.fetchval("SELECT count(*) FROM matches WHERE candidate_id = $1", cid)
        # versions and matches cascade.
        await conn.execute("DELETE FROM candidates WHERE id = $1", cid)
    # Files after the DB commit: a crash here leaves orphan files, which a retry removes; never orphan rows.
    files = svc.storage.delete_candidate(str(cid))
    log.info("deleted candidate_id=%s versions=%d matches=%d files=%d", cid, versions, matches, files)
    return DeleteResult(
        candidate_id=str(cid), deleted=True, versions_deleted=versions, matches_deleted=matches, files_deleted=files
    )
