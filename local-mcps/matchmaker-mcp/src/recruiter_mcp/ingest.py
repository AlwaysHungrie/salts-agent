"""Ingest pipeline: transcript (+ optional original PDF) -> profile -> normalized fields -> embedding -> DB."""

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

import asyncpg

from .billing import preflight
from .errors import ToolFailure
from .experience import years_of_experience
from .locations import location_key, location_keys
from .models import CandidateProfile, IngestResult
from .prompts import render
from .services import Services
from .skills import SkillNormalizer, save_learned

log = logging.getLogger(__name__)

PDF_MIME = "application/pdf"
# Appended to file errors: agents otherwise go hunting for the file and try to encode it into a tool call,
# which no model can do for a real PDF (seen in practice: loops until timeout).
NO_FILE_HINT = (
    " Do not look for, read or encode the file yourself. Call ingest_resume again with the same resume_text and "
    "no file_path or upload_id: the candidate is saved without the original PDF. Tell the user the file was not stored."
)
MIN_TEXT_CHARS = 200
MAX_TEXT_CHARS = 100_000


@dataclass
class OriginalFile:
    data: bytes
    ext: str
    mime: str
    sha256: str


def resolve_pdf(file_path: str) -> Path:
    """Absolute path to an existing PDF. Accepts ~, quotes and either slash style (Windows paths included)."""
    p = Path(file_path.strip().strip('"').strip("'")).expanduser()
    if not p.is_absolute():
        raise ToolFailure("invalid_input", "file_path must be an absolute path")
    if p.suffix.lower() != ".pdf":
        raise ToolFailure("unsupported_file_type", "only PDF resumes are supported")
    if not p.is_file():
        raise ToolFailure(
            "file_not_found",
            f"no file at {file_path} on the machine running recruiter-mcp (file_path must be a real file there, never "
            f"a guess).{NO_FILE_HINT}",
        )
    return p.resolve()


def _pdf(data: bytes, max_bytes: int) -> OriginalFile:
    if len(data) > max_bytes:
        raise ToolFailure("file_too_large", f"file exceeds {max_bytes // (1024 * 1024)} MB")
    if not data.startswith(b"%PDF"):
        raise ToolFailure("invalid_input", "file does not look like a PDF")
    return OriginalFile(data=data, ext="pdf", mime=PDF_MIME, sha256=hashlib.sha256(data).hexdigest())


def read_pdf(p: Path, max_bytes: int) -> OriginalFile:
    if p.stat().st_size > max_bytes:
        raise ToolFailure("file_too_large", f"file exceeds {max_bytes // (1024 * 1024)} MB")
    return _pdf(p.read_bytes(), max_bytes)


UPLOAD_ID = re.compile(r"^[0-9a-f]{64}$")


def upload_key(upload_id: str) -> str:
    return f"uploads/{upload_id}.pdf"


def save_upload(svc: Services, data: bytes) -> OriginalFile:
    """POST /uploads: keep an agent-uploaded PDF until ingest_resume claims it by upload_id (its sha256)."""
    original = _pdf(data, svc.settings.max_file_bytes)
    svc.storage.put(upload_key(original.sha256), data)
    return original


def load_upload(svc: Services, upload_id: str) -> OriginalFile:
    uid = upload_id.strip().lower()
    if not UPLOAD_ID.match(uid) or not svc.storage.exists(upload_key(uid)):
        raise ToolFailure(
            "file_not_found",
            f"no upload {upload_id} (only an upload_id given in the conversation works).{NO_FILE_HINT}",
        )
    return _pdf(svc.storage.get(upload_key(uid)), svc.settings.max_file_bytes)


def load_original(file_path: str | None, max_bytes: int) -> OriginalFile | None:
    return read_pdf(resolve_pdf(file_path), max_bytes) if file_path else None


def text_sha256(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    return hashlib.sha256(normalized.encode()).hexdigest()


def normalize_email(email: str | None) -> str | None:
    if not email:
        return None
    e = email.strip().strip("<>").lower()
    return e if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", e) else None


def normalize_name(name: str | None) -> str | None:
    """Collapse whitespace; title-case names written entirely in upper or lower case ('KARAN MALHOTRA').
    Mixed case is left as written, so 'McDonald' and 'de Souza' survive."""
    if not name:
        return None
    n = re.sub(r"\s+", " ", name).strip()
    if n.isupper() or n.islower():
        n = n.title()
    return n or None


def phone_key(phone: str | None) -> str | None:
    """Last 10 digits, so '+91 98765-43210' and '09876543210' dedup together."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    return digits[-10:] if len(digits) >= 10 else None


def rank_skills(profile: CandidateProfile, skills: list[str]) -> list[str]:
    """Skills with evidence in role titles/highlights first (most recent roles weigh most)."""
    evidence = " ".join(
        f"{r.title} {' '.join(r.highlights)}" for r in profile.roles[:3]
    ).lower()

    def evidenced(skill: str) -> bool:
        # Whole-token match, so "Go" is not found in "Google" and "Java" not in "JavaScript".
        return re.search(rf"(?<![\w+#]){re.escape(skill.lower())}(?![\w+#])", evidence) is not None

    return sorted(skills, key=lambda s: (not evidenced(s), skills.index(s)))


@dataclass
class Derived:
    """Columns computed in code from a profile; `migrate` recomputes them when the vocabulary or rules change."""

    skills: list[str]
    location_key: str | None
    willing_to_relocate: bool | None
    preferred_location_keys: list[str]


def derive(profile: CandidateProfile, normalizer: SkillNormalizer) -> Derived:
    """Skills normalized, plus the umbrella skills they imply (so "AWS Lambda" meets a must-have "AWS")."""
    return Derived(
        skills=normalizer.expand(normalizer.normalize_all(profile.skills)),
        location_key=location_key(profile.location),
        willing_to_relocate=profile.willing_to_relocate,
        preferred_location_keys=location_keys(profile.preferred_locations),
    )


def build_headline(profile: CandidateProfile, years: float | None, top: list[str]) -> str:
    parts = [profile.current_title or (profile.roles[0].title if profile.roles else "Candidate")]
    if years is not None:
        parts.append(f"{years:g} yrs")
    if top:
        parts.append("/".join(top[:3]))
    return ", ".join(parts)


def embedding_text(profile: CandidateProfile, skills: list[str]) -> str:
    """current_title + summary + skills + last 3 roles (title, company, highlights)."""
    lines = [profile.current_title or "", profile.summary, "Skills: " + ", ".join(skills)]
    for r in profile.roles[:3]:
        lines.append(f"{r.title} at {r.company or 'unknown'}: " + "; ".join(r.highlights))
    return "\n".join(line for line in lines if line)


async def _find_duplicate(conn: asyncpg.Connection, sha: str) -> asyncpg.Record | None:
    row = await conn.fetchrow("SELECT * FROM candidates WHERE content_sha256 = $1", sha)
    if row:
        return row
    # An older version of someone's resume: still a duplicate, don't roll them back.
    return await conn.fetchrow(
        "SELECT c.* FROM candidate_versions v JOIN candidates c ON c.id = v.candidate_id"
        " WHERE v.content_sha256 = $1 LIMIT 1",
        sha,
    )


async def _find_person(
    conn: asyncpg.Connection, email: str | None, pkey: str | None
) -> asyncpg.Record | None:
    if email:
        row = await conn.fetchrow("SELECT * FROM candidates WHERE email = $1", email)
        if row:
            return row
    if pkey:
        return await conn.fetchrow(
            "SELECT * FROM candidates WHERE phone_key = $1 ORDER BY updated_at DESC LIMIT 1", pkey
        )
    return None


def _discard_file(svc: Services, candidate_id: str, file_key: str | None, existing) -> None:
    """Undo a file write after a failed DB write, without touching files the candidate already had."""
    if not file_key:
        return
    if existing is None:
        svc.storage.delete_candidate(candidate_id)
    elif file_key != existing["file_key"]:
        svc.storage.delete(file_key)


def result_from_row(row: asyncpg.Record, status: str, warnings: list[str] | None = None) -> IngestResult:
    profile = CandidateProfile.model_validate_json(row["profile"])
    years = float(row["years_exp"]) if row["years_exp"] is not None else None
    top = rank_skills(profile, list(row["skills"]))[:5]
    return IngestResult(
        status=status,
        candidate_id=str(row["id"]),
        name=row["name"],
        headline=build_headline(profile, years, top),
        location=row["location"],
        years_exp=years,
        top_skills=top,
        notice_days=row["notice_days"],
        warnings=warnings or [],
    )


async def ingest_resume(
    svc: Services,
    *,
    resume_text: str,
    file_path: str | None = None,
    upload_id: str | None = None,
    original: OriginalFile | None = None,
    source: str | None = None,
    notes: str | None = None,
) -> IngestResult:
    """`original` is for callers that already read the file (bulk); otherwise it comes from upload_id or file_path."""
    text = (resume_text or "").strip()
    if not text:
        raise ToolFailure("invalid_input", "resume_text is required")
    if len(text) > MAX_TEXT_CHARS:
        raise ToolFailure("invalid_input", f"resume_text exceeds {MAX_TEXT_CHARS} characters")
    if upload_id and file_path:
        raise ToolFailure("invalid_input", "send upload_id or file_path, not both")
    if upload_id:
        original = load_upload(svc, upload_id)
    original = original or load_original(file_path, svc.settings.max_file_bytes)
    sha = original.sha256 if original else text_sha256(text)

    async with svc.pool.acquire() as conn:
        dup = await _find_duplicate(conn, sha)
    if dup:
        log.info("ingest duplicate candidate_id=%s", dup["id"])
        _drop_upload(svc, upload_id)
        return result_from_row(dup, "duplicate_file")

    await preflight(svc.pool, "ingest_resume")  # after the dup check: duplicates are free

    warnings: list[str] = []
    if len(text) < MIN_TEXT_CHARS:
        warnings.append("resume_text is very short; send the full verbatim transcript")

    # 1. Structured extraction (server-side, fixed prompt/model for consistency).
    system, user = render("extract_resume", text=text)
    profile = await svc.llm.structured(system, user, CandidateProfile, name="candidate_profile")
    raw_extraction = profile.model_dump(mode="json")

    # 2. Deterministic derivations.
    email = normalize_email(profile.email)
    pkey = phone_key(profile.phone)
    derived = derive(profile, svc.normalizer)
    skills = derived.skills
    years = years_of_experience(profile.roles)
    profile = profile.model_copy(update={"email": email, "name": normalize_name(profile.name)})
    if not email:
        warnings.append("no email found")
    if not pkey:
        warnings.append("no phone found")
    if years is None:
        warnings.append("no role dates found; years_exp unknown")
    if not original:
        warnings.append("no original file stored; get_candidate will return the transcript only")

    # 3. Embed.
    [vector] = await svc.embedder.embed([embedding_text(profile, skills)])

    # 4. Persist. Person dedup: email, then phone.
    async with svc.pool.acquire() as conn:
        existing = await _find_person(conn, email, pkey)
        candidate_id = str(existing["id"]) if existing else str(uuid.uuid4())
        file_key = svc.storage.resume_key(candidate_id, sha, original.ext, profile.name) if original else None
        if original:
            svc.storage.put(file_key, original.data)
        values = (
            profile.name, email, profile.phone, pkey, profile.location, years,
            profile.notice_period_days, skills, profile.model_dump_json(), json.dumps(raw_extraction),
            profile.summary, text, vector, sha, file_key, original.mime if original else None,
            source, notes, derived.location_key, derived.willing_to_relocate, derived.preferred_location_keys,
        )
        try:
            async with conn.transaction():
                if existing:
                    await conn.execute(
                        "INSERT INTO candidate_versions (candidate_id, profile, resume_text, file_key,"
                        " content_sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                        existing["id"], existing["profile"], existing["resume_text"],
                        existing["file_key"], existing["content_sha256"], existing["updated_at"],
                    )
                    row = await conn.fetchrow(
                        """UPDATE candidates SET name=$1, email=COALESCE($2, email), phone=COALESCE($3, phone),
                           phone_key=COALESCE($4, phone_key), location=$5, years_exp=$6, notice_days=$7,
                           skills=$8, profile=$9, raw_extraction=$10, summary=$11, resume_text=$12,
                           embedding=$13, content_sha256=$14, file_key=$15, file_mime=$16,
                           source=COALESCE($17, source), notes=COALESCE($18, notes), location_key=$19,
                           willing_to_relocate=$20, preferred_location_keys=$21,
                           updated_at=now() WHERE id=$22 RETURNING *""",
                        *values, existing["id"],
                    )
                    status = "updated"
                else:
                    row = await conn.fetchrow(
                        """INSERT INTO candidates (name, email, phone, phone_key, location, years_exp,
                           notice_days, skills, profile, raw_extraction, summary, resume_text, embedding,
                           content_sha256, file_key, file_mime, source, notes, location_key, willing_to_relocate,
                           preferred_location_keys, id)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
                           RETURNING *""",
                        *values, uuid.UUID(candidate_id),
                    )
                    status = "created"
        except asyncpg.UniqueViolationError:
            # A concurrent ingest of the same file or person won the race.
            _discard_file(svc, candidate_id, file_key, existing)
            dup = await _find_duplicate(conn, sha) or await _find_person(conn, email, pkey)
            if dup is None:
                raise
            return result_from_row(dup, "duplicate_file")
        except BaseException:
            _discard_file(svc, candidate_id, file_key, existing)
            raise

    log.info("ingest %s candidate_id=%s", status, candidate_id)
    await save_learned(svc.pool, svc.normalizer)
    _drop_upload(svc, upload_id)  # the PDF now lives under resumes/
    return result_from_row(row, status, warnings)


def _drop_upload(svc: Services, upload_id: str | None) -> None:
    if upload_id:
        svc.storage.delete(upload_key(upload_id.strip().lower()))
