import functools
import json
import logging
import sys
import traceback
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from mcp.server.mcpserver import Context, MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import billing
from . import candidates as cand
from . import match as matching
from .auth import BearerAuthMiddleware
from .bulk import FolderRuns, find_files, inbox_dir, scan
from .config import get_settings
from .db import create_pool
from .errors import ToolFailure
from .ingest import ingest_resume as run_ingest
from .ingest import save_upload
from .migrate import migrate
from .models import (
    BulkInboxInfo,
    DeleteResult,
    FeedbackLabel,
    FeedbackResult,
    FolderFileOutcome,
    FolderIngestStatus,
    GetCandidateResult,
    IngestFolderResult,
    IngestResult,
    ListJobsResult,
    MatchFilters,
    MatchResult,
    ResumeFileResult,
    SearchFilters,
    SearchResult,
    Source,
)
from .search import search_candidates as run_search
from .services import Services, load_normalizer
from .storage import LocalStorage
from .usage import track_usage

log = logging.getLogger("recruiter_mcp")

_services: Services | None = None
_folder_runs = FolderRuns()


def services() -> Services:
    if _services is None:
        raise ToolFailure("not_ready", "server is still starting")
    return _services


@asynccontextmanager
async def lifespan(_: MCPServer) -> AsyncIterator[None]:
    global _services
    settings = get_settings()
    # Apply pending migrations on start, so an upgrade never runs against an older schema (missing tables).
    if applied := await migrate():
        log.info("applied migrations: %s", ", ".join(applied))
    pool = await create_pool()
    try:
        _services = Services(
            settings=settings,
            pool=pool,
            storage=LocalStorage(settings.data_dir),
            normalizer=await load_normalizer(pool),
        )
        inbox_dir(settings)  # exists before any agent tells a user to put files in it
        yield
    finally:
        await _folder_runs.cancel_all()
        _services = None
        await pool.close()


mcp = MCPServer(
    name="recruiter-mcp",
    instructions=(
        "Recruiter matching server running on the recruiter's own computer. Ingest PDF resumes one at a time "
        "(ingest_resume, e.g. a chat attachment) or in bulk, match job descriptions against ingested candidates, "
        "and look up candidates. "
        "Resume requests: when the user asks for a resume or CV, call get_resume_file and reply with its "
        "message_for_user (the file's full path on their computer); never paste the profile instead. "
        "Bulk ingest: the server has its own inbox folder. Call get_bulk_ingest_folder, tell the user to put their "
        "PDFs in that folder and to tell you when they are done, and only then call ingest_folder. Never ask the "
        "user where their files are."
    ),
    version="0.1.0",
    lifespan=lifespan,
)


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


def tool_handler(name: str, *, preflight: bool = False):
    """Applies the request's OpenRouter key and spend cap (headers, else settings), tracks token usage per call,
    and turns failures into {code, message} errors, never tracebacks. `preflight` rejects the call up front when
    its estimated cost exceeds the cap. Tools that take `ctx` get headers; the rest use settings only."""

    def decorate(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            tokens = None
            try:
                svc = services()
                ctx = kwargs.get("ctx")
                tokens = billing.begin(name, ctx.headers if ctx is not None else None, svc.settings)
                if preflight:
                    await billing.preflight(svc.pool, name)
                async with track_usage(svc.pool, name):
                    return await fn(*args, **kwargs)
            except ToolFailure as e:
                log.info("tool %s failed: %s", name, e.code)
                return _error(e.code, e.message)
            except Exception as e:
                if (failure := billing.provider_failure(e)) is not None:
                    log.info("tool %s failed: %s", name, failure.code)
                    return _error(failure.code, failure.message)
                # Exception messages can quote row values (e.g. a duplicate email), so log the type and
                # frame locations only, never the message or source lines.
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__)
                )
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", "unexpected server error; see server logs")
            finally:
                if tokens is not None:
                    billing.end(tokens)

        return wrapper

    return decorate


# ---------------------------------------------------------------- tools


class PingResult(BaseModel):
    ok: bool
    db: bool
    candidates: int | None


@mcp.tool(
    description="Health check. Confirms the server and database are reachable.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
async def ping() -> PingResult:
    try:
        count = await services().pool.fetchval("SELECT count(*) FROM candidates")
        return PingResult(ok=True, db=True, candidates=count)
    except Exception as e:
        log.error("ping db check failed: %s", type(e).__name__)
        return PingResult(ok=True, db=False, candidates=None)


@mcp.tool(
    description=(
        "Add one resume to the candidate database. First read the resume yourself and pass its FULL text in "
        "resume_text: a verbatim transcript of everything on the page, including contact details, every role with "
        "its dates, skills, education and notes. Do not summarise, shorten or reorder. Also pass the original PDF "
        "so it is kept (only PDF is accepted): if the conversation gives an upload_id for the attachment, pass it "
        "(preferred); otherwise file_path only for a real file on the machine running this server. Never guess a "
        "path, and never try to read, locate or encode the file yourself: if neither is available, ingest the text "
        "alone and tell the user the file was not stored. For more than a few resumes, use the bulk inbox "
        "instead (get_bulk_ingest_folder). "
        "Re-sending the same file is safe (status=duplicate_file). "
        "A resume from someone already in the database, matched by email or phone, updates them and keeps the old "
        "version (status=updated)."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("ingest_resume")
async def ingest_resume(
    resume_text: Annotated[str, Field(description="Verbatim full-text transcript of the resume")],
    file_path: Annotated[
        str | None,
        Field(description="Absolute path to the PDF on the server's machine, e.g. /Users/me/cv.pdf or C:\\cv.pdf"),
    ] = None,
    upload_id: Annotated[
        str | None, Field(description="ID of a PDF the agent app uploaded to POST /uploads (given in the conversation)")
    ] = None,
    source: Annotated[Source | None, Field(description="Where the resume came from")] = None,
    notes: Annotated[str | None, Field(description="Optional recruiter notes")] = None,
    ctx: Context | None = None,
) -> IngestResult:
    # No file_base64 here: a model cannot reproduce a file's bytes, and offering the field invites a fabricated PDF.
    return await run_ingest(services(), resume_text=resume_text, file_path=file_path, upload_id=upload_id,
                            source=source, notes=notes)


@mcp.tool(
    description=(
        "Get a candidate's parsed profile (contact details, roles, skills, summary). Look up by candidate_id, or "
        "by query (a name or email). If several people match a query, status is 'ambiguous' and matches lists "
        "them; call again with the right candidate_id. Not for requests for the resume/CV itself ('get me the "
        "resume', 'send/open/share X's CV'): use get_resume_file for those."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_candidate")
async def get_candidate(
    candidate_id: Annotated[str | None, Field(description="Candidate UUID")] = None,
    query: Annotated[str | None, Field(description="Name or email to look up")] = None,
) -> GetCandidateResult:
    return await cand.get_candidate(services(), candidate_id, query)


@mcp.tool(
    description=(
        "Use when the user asks for a candidate's resume or CV file ('get me the resume of X', 'send me X's CV', "
        "'where is X's resume'). The file is never sent through the chat; it is stored on the user's computer. "
        "Reply with message_for_user, which gives the full path exactly as stored; do not summarise the profile "
        "unless asked. Look up by candidate_id, or by query (a name or email)."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_resume_file")
async def get_resume_file(
    candidate_id: Annotated[str | None, Field(description="Candidate UUID")] = None,
    query: Annotated[str | None, Field(description="Name or email to look up")] = None,
) -> ResumeFileResult:
    return await cand.get_resume_file(services(), candidate_id, query)


async def _scan_inbox(svc: Services):
    folder = inbox_dir(svc.settings)
    files = find_files(folder)
    sc = await scan(svc, files, svc.settings.folder_max_attempts)
    skipped = [r.status for r in sc.skipped]
    per_file, _ = await billing.estimate(svc.pool, "ingest_folder")
    counts = dict(
        folder=str(folder), pdf_files=len(files), already_ingested=skipped.count("unchanged"),
        gave_up=skipped.count("gave_up"), to_process=len(sc.pending),
        # Upper bound: duplicates found by hash cost nothing.
        estimated_cost_usd=round(len(sc.pending) * per_file, 4),
    )
    return folder, files, sc, counts


@mcp.tool(
    description=(
        "Start of bulk ingest. Returns the server's inbox folder (an absolute path on the server's machine) and "
        "what is in it now. Use it whenever the user wants to add more than a few resumes: tell them to put the PDF "
        "files in that folder (subfolders are fine, other file types are ignored) and to tell you when they are "
        "done. Do not ask where their files are and do not start ingesting until they confirm; then call "
        "ingest_folder. Free, no model calls."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_bulk_ingest_folder")
async def get_bulk_ingest_folder() -> BulkInboxInfo:
    _, _, _, counts = await _scan_inbox(services())
    folder, new = counts["folder"], counts["to_process"]
    message = (
        f"Put the PDF resumes you want to add in {folder} (subfolders are fine; other file types are ignored), "
        f"then tell me to go ahead and I'll process them."
    )
    if new:
        message += f" There are already {new} new PDF(s) there (about ${counts['estimated_cost_usd']:.2f} to process)."
    return BulkInboxInfo(message_for_user=message, **counts)


@mcp.tool(
    description=(
        "Ingest every PDF in the server's bulk inbox (see get_bulk_ingest_folder). Call only after the user has "
        "put their files there and confirmed. Files already ingested and unchanged are skipped without being "
        "read; renamed or copied duplicates are skipped by content hash before any model call. The server reads "
        "the PDFs itself, so do not open them. Runs in the background and returns a run_id at once; poll "
        "get_folder_ingest_status every 30-60 s and report progress. Costs ~$0.004 per new file. Calling again "
        "is safe and retries earlier failures."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("ingest_folder")
async def ingest_folder(
    source: Annotated[Source, Field(description="Where these resumes came from")] = "other",
    ctx: Context | None = None,
) -> IngestFolderResult:
    svc = services()

    def ensure_idle() -> None:
        if active := _folder_runs.active():
            raise ToolFailure(
                "already_running", f"folder ingest {active.run_id} is still running; check get_folder_ingest_status"
            )

    ensure_idle()
    folder, files, sc, counts = await _scan_inbox(svc)
    budget = billing.current_budget()
    base = dict(approved_usd=budget.approved_usd if budget else None, **counts)
    if not files:
        return IngestFolderResult(status="no_pdfs", **base)
    if not sc.pending:
        return IngestFolderResult(status="up_to_date", **base)
    await billing.preflight(svc.pool, "ingest_folder", units=len(sc.pending))
    vision = svc.vision  # fails now, not in the background, if there is no API key
    ensure_idle()  # another call may have started a run while this one scanned
    run = _folder_runs.start(svc, folder, files, sc, vision.transcribe, source=source,
                             concurrency=svc.settings.folder_concurrency,
                             max_attempts=svc.settings.folder_max_attempts)
    log.info("folder run %s started files=%d to_process=%d", run.run_id, len(files), len(sc.pending))
    return IngestFolderResult(status="started", run_id=run.run_id, **base)


@mcp.tool(
    description=(
        "Progress of a folder ingest started by ingest_folder: files processed so far, counts by outcome, cost, "
        "and failed files with reasons. Omit run_id for the most recent run."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_folder_ingest_status")
async def get_folder_ingest_status(
    run_id: Annotated[str | None, Field(description="run_id from ingest_folder")] = None,
) -> FolderIngestStatus:
    run = _folder_runs.runs.get(run_id) if run_id else _folder_runs.latest
    if run is None:
        raise ToolFailure("not_found", "no folder ingest run with that id since the server started")
    counts: dict[str, int] = {}
    for r in run.results:
        counts[r.status] = counts.get(r.status, 0) + 1
    return FolderIngestStatus(
        run_id=run.run_id,
        folder=run.folder,
        state="running" if run.running else (
            "crashed" if run.error else "stopped" if run.stopped_reason else "finished"),
        stopped_reason=run.stopped_reason,
        started_at=run.started_at.isoformat(),
        finished_at=run.finished_at.isoformat() if run.finished_at else None,
        pdf_files=run.total_files,
        to_process=run.to_process,
        processed=run.processed,
        counts=counts,
        cost_usd=round(sum(r.cost_usd for r in run.results), 4),
        failures=[
            FolderFileOutcome(path=r.path, status=r.status, error=r.error)
            for r in run.results if r.status in ("failed", "gave_up") and r.error != run.stopped_reason
        ],
    )


@mcp.tool(
    description=(
        "Find the best candidates for a job. Pass the full job description in jd_text. The server parses "
        "requirements from it, applies hard filters (years, location, notice period, resume age), picks the ~50 "
        "most similar candidates, scores each against a fixed rubric, and returns the top `limit` with reasons. "
        "Filters are optional; any you pass override what was parsed from the JD. Takes 20-45 seconds. "
        "Results are saved: reopen them with get_job instead of re-running."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
)
@tool_handler("match_job", preflight=True)
async def match_job(
    jd_text: Annotated[str, Field(description="Full job description text")],
    title: Annotated[str | None, Field(description="Optional job title; parsed from the JD if omitted")] = None,
    limit: Annotated[int, Field(description="How many candidates to return (1-50)", ge=1, le=50)] = 10,
    filters: Annotated[MatchFilters | None, Field(description="Optional hard filters overriding the JD")] = None,
    ctx: Context | None = None,
) -> MatchResult:
    return await matching.match_job(services(), jd_text=jd_text, title=title, limit=limit, filters=filters)


@mcp.tool(
    description="Reopen a saved match result by job_id without re-running any LLM calls.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_job")
async def get_job(
    job_id: Annotated[str, Field(description="Job UUID from match_job or list_jobs")],
    limit: Annotated[int, Field(description="How many ranked candidates to return (1-50)", ge=1, le=50)] = 10,
    include_low_scores: Annotated[
        bool, Field(description="Also return candidates below the minimum match score")
    ] = False,
) -> MatchResult:
    return await matching.get_job(services(), job_id, limit=limit, include_low_scores=include_low_scores)


@mcp.tool(
    description="List recent match runs, newest first, with their top candidates.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("list_jobs")
async def list_jobs(
    limit: Annotated[int, Field(description="How many jobs to return (1-100)", ge=1, le=100)] = 20,
) -> ListJobsResult:
    return await matching.list_jobs(services(), limit=limit)


@mcp.tool(
    description=(
        "Search candidates without a job description, e.g. 'Python devs in Pune with under 30 days notice'. "
        "Put the descriptive part in query (ranked by meaning; skills named in it rank first) and hard "
        "constraints in filters (locations, years, notice, required skills). Fast, no LLM. With no query, "
        "returns the most recently updated candidates matching the filters."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("search_candidates")
async def search_candidates(
    query: Annotated[str | None, Field(description="Free text: role, skills, domain")] = None,
    filters: Annotated[SearchFilters | None, Field(description="Hard filters")] = None,
    limit: Annotated[int, Field(description="Max results (1-100)", ge=1, le=100)] = 20,
    ctx: Context | None = None,
) -> SearchResult:
    return await run_search(services(), query, filters, limit)


@mcp.tool(
    description=(
        "Record the recruiter's decision on a candidate for a job: shortlisted, rejected, interviewed or placed. "
        "Call it whenever the recruiter acts on a match; these labels are the evaluation data for ranking "
        "quality. Re-labelling replaces the previous label. Works for candidates found outside match_job too."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("record_feedback")
async def record_feedback(
    job_id: Annotated[str, Field(description="Job UUID")],
    candidate_id: Annotated[str, Field(description="Candidate UUID")],
    label: Annotated[FeedbackLabel, Field(description="shortlisted | rejected | interviewed | placed")],
    note: Annotated[str | None, Field(description="Optional reason, e.g. 'notice too long'")] = None,
) -> FeedbackResult:
    return await matching.record_feedback(services(), job_id, candidate_id, label, note)


@mcp.tool(
    description=(
        "Permanently delete a candidate: profile, all previous versions, match results and every stored "
        "resume file. Cannot be undone. Use for data-privacy deletion requests; confirm with the recruiter first."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False),
)
@tool_handler("delete_candidate")
async def delete_candidate(
    candidate_id: Annotated[str, Field(description="Candidate UUID")],
) -> DeleteResult:
    return await cand.delete_candidate(services(), candidate_id)


# ---------------------------------------------------------------- transports


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


@mcp.custom_route("/uploads", methods=["POST"])
async def upload(request: Request) -> JSONResponse:
    """Raw PDF bytes in, upload_id out. For agent apps whose model can see an attachment but cannot reproduce its
    bytes in a tool call: the app uploads the file, then tells the model the upload_id for ingest_resume.
    Behind the same bearer auth as /mcp."""
    try:
        svc = services()
        limit = svc.settings.max_file_bytes
        if int(request.headers.get("content-length") or 0) > limit:
            raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        original = save_upload(svc, bytes(body))
    except ToolFailure as e:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=400)
    log.info("upload stored size=%d", len(original.data))
    return JSONResponse({"upload_id": original.sha256, "size_bytes": len(original.data)})


def build_http_app():
    settings = get_settings()
    if not settings.mcp_auth_token:
        raise SystemExit("MCP_AUTH_TOKEN is required for the http transport")
    # Files arrive via /uploads (streamed, capped separately), so an MCP request is at most a transcript or a JD.
    app = mcp.streamable_http_app(host=settings.mcp_host, max_request_body_size=2 * 1024 * 1024)
    return BearerAuthMiddleware(app, settings.mcp_auth_token)


def main() -> None:
    # Logs go to stderr so they never corrupt the stdio transport. IDs only, never resume content.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    settings = get_settings()
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
