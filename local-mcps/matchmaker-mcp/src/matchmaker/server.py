"""The matchmaker as an MCP server: people (resumes, cover letters) and jobs as folders, hybrid search, pages judged
against the job. Over HTTP (salts-tools) every model call uses the caller's X-OpenRouter-Api-Key header."""

import functools
import json
import logging
import sys
import traceback
from typing import Annotated, Literal

import uvicorn
from mcp.server.mcpserver import Context, MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import billing, bulk, people
from . import jobs as job_store
from .auth import BearerAuthMiddleware
from .config import get_settings
from .errors import ToolFailure
from .judge import judge_page
from .models import JobResult, JudgedCandidate, Person, PersonResult
from .search import search
from .services import Services
from .uploads import save_upload, upload_path
from .usage import track_usage

log = logging.getLogger("matchmaker")

_services: Services | None = None


def services() -> Services:
    global _services
    if _services is None:
        _services = Services(settings=get_settings())
    return _services


mcp = MCPServer(
    name="matchmaker",
    instructions=(
        "The user's own pool of people (resumes and cover letters, kept on their computer) and the jobs they post. "
        "Adding people: for each resume or cover letter in the chat, call add_document with its upload_id; do not "
        "transcribe the file. Pass text only when there is no file (pasted text) or the server says the file has "
        "no text. A cover letter for someone already added takes their person_id. "
        "Matching: post_job with the full posting (once per job; list_jobs finds earlier ones), then "
        "find_candidates with its job_id and a query you write: the role and its other titles, then the must-have "
        "skills and their other names. Each page is up to 50 people judged against the job, best first, each with "
        "a score, the checks behind it and a reason. Tell the user who fits, who partly fits and what they lack, "
        "from those reasons. The next page (offset = next_offset) is judged when asked for and costs about the "
        "same again (~$0.10), so offer it rather than fetching it. "
        "Many resumes at once: call get_inbox_folder and give the user the folder it returns; tell them to put "
        "their resumes there and to tell you when they are done. Never ask where their files are. Then call "
        "ingest_inbox and report progress with get_ingest_status. "
        "search_people browses the pool without a job, unjudged. get_person gives a full profile with contact "
        "details. delete_person only after the user confirms."
    ),
    version="0.2.0",
)


def _error(code: str, message: str) -> CallToolResult:
    body = {"error": {"code": code, "message": message}}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], is_error=True)


def tool_handler(name: str):
    """The caller's key and spend cap from the headers, a refusal up front when a paid tool's typical cost is over
    the cap, and failures as {code, message} errors, never tracebacks."""

    def decorate(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            tokens = None
            try:
                ctx = kwargs.get("ctx")
                tokens = billing.begin(name, ctx.headers if ctx is not None else None)
                if name in billing.COST_RULES:
                    billing.preflight(name)
                async with track_usage(name):
                    return await fn(*args, **kwargs)
            except ToolFailure as e:
                log.info("tool %s failed: %s", name, e.code)
                return _error(e.code, e.message)
            except Exception as e:
                if (failure := billing.provider_failure(e)) is not None:
                    log.info("tool %s failed: %s", name, failure.code)
                    return _error(failure.code, failure.message)
                # Messages can quote document text: log the type and frame locations only.
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__))
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", "unexpected server error; see server logs")
            finally:
                if tokens is not None:
                    billing.end(tokens)

        return wrapper

    return decorate


# ---------------------------------------------------------------- results


class Match(BaseModel):
    position: int = Field(description="Place on this page, best first")
    person_id: str
    name: str | None
    headline: str
    score: float | None = Field(None, description="0-100 against the job; null when the page was not judged")
    their_role: str | None = Field(None, description="The kind of role their own work is")
    core_work: str | None = Field(None, description="yes / maybe / no: has their work been the job's core work")
    years_of_core_work: float | None = None
    must_haves: dict[str, str] = Field(default_factory=dict, description="Each must-have: yes / maybe / no")
    reason: str | None = None
    location: str | None = None
    open_to_relocate: str | None = None
    years_experience: float | None = None
    duplicates: list[str] = Field(default_factory=list, description="Other files for the same person")


class MatchPage(BaseModel):
    job_id: str | None
    role_type: str | None = Field(None, description="What the job is, as the judge read it")
    must_haves: list[str] = Field(default_factory=list)
    total: int = Field(description="Everyone in the pool, each person once")
    offset: int
    next_offset: int | None = Field(description="Pass as offset for the next page; null on the last page")
    matches: list[Match]


class PingResult(BaseModel):
    ok: bool
    people: int
    jobs: int


def _facts(svc: Services, person_id: str) -> dict:
    meta = json.loads((people.person_dir(svc, person_id) / "person.json").read_text(encoding="utf-8"))
    return meta.get("profile") or {}


def _match(svc: Services, n: int, c, judged: bool) -> Match:
    f = _facts(svc, c.person_id)
    row = Match(position=n, person_id=c.person_id, name=c.name, headline=f.get("headline") or "",
                location=f.get("location"), open_to_relocate=f.get("open_to_relocate"),
                years_experience=f.get("years_experience"), duplicates=c.duplicates)
    if judged and isinstance(c, JudgedCandidate):
        row.score, row.their_role, row.core_work = c.score, c.candidate_role_type, c.core_work
        row.years_of_core_work, row.must_haves, row.reason = c.core_work_years, dict(c.must_haves), c.reason
    return row


# ---------------------------------------------------------------- tools


@mcp.tool(description="Health check: how many people and jobs are stored.",
          annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
@tool_handler("ping")
async def ping() -> PingResult:
    svc = services()
    root = svc.settings.data_dir
    count = lambda d, f: sum(1 for p in d.iterdir() if (p / f).is_file()) if d.is_dir() else 0  # noqa: E731
    return PingResult(ok=True, people=count(root / "people", "person.json"), jobs=count(root / "jobs", "job.json"))


@mcp.tool(
    description=(
        "Add a resume or cover letter. Pass the chat attachment's upload_id (PDF, DOCX or text); the server reads "
        "the file and writes the person's profile (location, relocation, years, skills, summary). Pass text only "
        "for pasted text or when the server says the file has no text. Without person_id a new person is created; "
        "with it the document is added to that person (a new resume replaces their old one). ~$0.001."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("add_document")
async def add_document(
    kind: Annotated[Literal["resume", "cover_letter"], Field(description="What the document is")] = "resume",
    upload_id: Annotated[str | None, Field(description="ID of the attachment, given in the conversation")] = None,
    text: Annotated[str | None, Field(description="The document's text, only when there is no file")] = None,
    person_id: Annotated[str | None, Field(description="Add to this existing person")] = None,
    ctx: Context | None = None,
) -> PersonResult:
    svc = services()
    if not upload_id and not (text or "").strip():
        raise ToolFailure("missing_file", "pass the attachment's upload_id, or the document's text")
    path = upload_path(svc.settings, upload_id) if upload_id else None
    return await people.add_document(svc, kind, text=text, file_path=path, person_id=person_id)


@mcp.tool(
    description=(
        "Add what the user tells you about a person to their notes: any fact not in their documents (\"open to "
        "relocating to Berlin\", \"single, open to dating\", \"available from March\"). Notes are kept and dated, "
        "win over the resume, and are read by search and matching, so use this rather than your own memory. Find "
        "the person first (search_people by name). ~$0.001."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
)
@tool_handler("add_note")
async def add_note(
    person_id: Annotated[str, Field(description="The person the note is about")],
    text: Annotated[str, Field(description="The fact, as the user said it")],
    ctx: Context | None = None,
) -> PersonResult:
    return await people.add_note(services(), person_id, text)


@mcp.tool(description="A person's full profile, contact details and which documents are on file.",
          annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
@tool_handler("get_person")
async def get_person(person_id: Annotated[str, Field(description="From add_document or a result")]) -> Person:
    return people.get_person(services(), person_id)


@mcp.tool(description="Permanently delete a person and all their files. Confirm with the user first.",
          annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True))
@tool_handler("delete_person")
async def delete_person(person_id: Annotated[str, Field(description="The person to delete")]) -> dict:
    people.delete_person(services(), person_id)
    return {"deleted": person_id}


@mcp.tool(
    description="Save a job posting. Pass the full posting text, once per job; returns the job_id for "
                "find_candidates. Use list_jobs to find a job posted earlier instead of posting it again.",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
)
@tool_handler("post_job")
async def post_job(
    text: Annotated[str, Field(description="The full job posting")],
    title: Annotated[str | None, Field(description="Optional title; the first line otherwise")] = None,
    ctx: Context | None = None,
) -> JobResult:
    return await job_store.post_job(services(), text, title)


@mcp.tool(description="Every posted job, newest first.",
          annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
@tool_handler("list_jobs")
async def list_jobs() -> list[JobResult]:
    return job_store.list_jobs(services())


@mcp.tool(
    description=(
        "The best people for a job, one page (up to 50) at a time. Everyone is ranked by search (words and meaning), "
        "then this page is judged against the job: each person gets a 0-100 score, yes/maybe/no on the job's core "
        "work and each must-have, and a reason; the page comes back best first. Write query: the role and its other "
        "titles, then the must-have skills and their other names (better than the posting alone). For the next "
        "page pass offset = next_offset; ask the user first, each judged page costs ~$0.10 and takes ~30 s."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
)
@tool_handler("find_candidates")
async def find_candidates(
    job_id: Annotated[str, Field(description="From post_job or list_jobs")],
    query: Annotated[str | None, Field(description="Search words: role, other titles, must-have skills")] = None,
    offset: Annotated[int, Field(description="next_offset of the previous page", ge=0)] = 0,
    ctx: Context | None = None,
) -> MatchPage:
    svc = services()
    page = await job_store.find_candidates(svc, job_id, query, offset)
    judged = await judge_page(svc, job_id, page)
    return MatchPage(job_id=job_id, role_type=judged.role_type, must_haves=judged.must_haves, total=judged.total,
                     offset=judged.offset, next_offset=judged.next_offset,
                     matches=[_match(svc, n, c, True) for n, c in enumerate(judged.candidates, offset + 1)])


@mcp.tool(
    description="Browse the pool without a job, e.g. 'python backend Pune'. Ranked by words and meaning, not judged. "
                "Pass offset = next_offset for more.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("search_people")
async def search_people(
    query: Annotated[str, Field(description="Role, skills, place, names")],
    offset: Annotated[int, Field(description="next_offset of the previous page", ge=0)] = 0,
    ctx: Context | None = None,
) -> MatchPage:
    svc = services()
    page = await search(svc, query, offset)
    return MatchPage(job_id=None, total=page.total, offset=page.offset, next_offset=page.next_offset,
                     matches=[_match(svc, c.position, c, False) for c in page.candidates])


class InboxInfo(BaseModel):
    message_for_user: str = Field(description="Pass this on to the user")
    folder: str = Field(description="The inbox, a folder on the user's computer")
    files: int = Field(description="Resume files in it now")
    new: int = Field(description="Files the next ingest_inbox would read")
    already_added: int
    gave_up: int = Field(description="Files that failed every attempt; changing the file tries it again")
    estimated_cost_usd: float


class IngestStarted(BaseModel):
    status: Literal["started", "nothing_new", "no_files"]
    run_id: str | None = None
    to_process: int
    estimated_cost_usd: float


class IngestStatus(BaseModel):
    run_id: str
    state: Literal["running", "finished", "stopped"]
    stopped_reason: str | None = Field(description="Why the run stopped early, e.g. the key ran out of credit")
    files: int
    to_process: int
    processed: int
    counts: dict[str, int] = Field(description="added, duplicate (already someone's resume), failed")
    cost_usd: float
    failures: list[dict] = Field(description="Files that failed, with the reason; the next run tries them again")


_runs = bulk.Runs()


@mcp.tool(
    description=(
        "Start of bulk ingest: the server's inbox folder on the user's computer and what is in it. Give the user "
        "message_for_user, then wait until they say the files are in before calling ingest_inbox. Never ask the "
        "user where their files are. Free."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_inbox_folder")
async def get_inbox_folder() -> InboxInfo:
    sc = bulk.scan(services())
    new, cost = len(sc["todo"]), round(len(sc["todo"]) * bulk.PER_FILE_USD, 4)
    message = (f"Put the resumes you want to add in {sc['folder']} (PDF, Word .docx or text files; subfolders "
               f"are fine), then tell me and I'll add them.")
    if new:
        message += f" There are already {new} new file(s) there (about ${cost:.2f} to read)."
    return InboxInfo(message_for_user=message, folder=str(sc["folder"]), files=len(sc["files"]), new=new,
                     already_added=sc["already_added"], gave_up=sc["gave_up"], estimated_cost_usd=cost)


@mcp.tool(
    description=(
        "Add every new resume in the inbox (see get_inbox_folder), each as a new person. Call only after the user "
        "has put their files there and said so. Files added before and unchanged are skipped; a file whose text "
        "is already someone's resume costs nothing. Runs in the background and returns at once: report progress "
        "with get_ingest_status every 30-60 s. ~$0.001 a file. Calling again retries files that failed."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True),
)
@tool_handler("ingest_inbox")
async def ingest_inbox(ctx: Context | None = None) -> IngestStarted:
    svc = services()
    bulk.require_idle(_runs)
    sc = bulk.scan(svc)
    cost = round(len(sc["todo"]) * bulk.PER_FILE_USD, 4)
    if not sc["files"]:
        return IngestStarted(status="no_files", to_process=0, estimated_cost_usd=0)
    if not sc["todo"]:
        return IngestStarted(status="nothing_new", to_process=0, estimated_cost_usd=0)
    billing.require_within(cost, f"{len(sc['todo'])} files at ~${bulk.PER_FILE_USD} each")
    svc.llm, svc.embedder  # noqa: B018 - fails now, not in the background, without a key
    run = _runs.start(svc, sc["folder"], sc["files"], sc["todo"])
    log.info("inbox run %s started files=%d to_process=%d", run.run_id, len(sc["files"]), len(sc["todo"]))
    return IngestStarted(status="started", run_id=run.run_id, to_process=len(sc["todo"]), estimated_cost_usd=cost)


@mcp.tool(
    description="Progress of the inbox run started by ingest_inbox: files done, counts, cost, failures. Omit run_id "
                "for the latest run.",
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("get_ingest_status")
async def get_ingest_status(run_id: Annotated[str | None, Field(description="From ingest_inbox")] = None,
                            ) -> IngestStatus:
    run = _runs.runs.get(run_id) if run_id else _runs.latest
    if run is None:
        raise ToolFailure("not_found", "no inbox run with that id since the server started")
    return IngestStatus(run_id=run.run_id, state=run.state, stopped_reason=run.stopped_reason, files=run.total_files,
                        to_process=run.to_process, processed=run.processed, counts=dict(run.counts),
                        cost_usd=round(run.cost_usd, 4), failures=run.failures[:20])


# ---------------------------------------------------------------- transports


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


@mcp.custom_route("/uploads", methods=["POST"])
async def upload(request: Request) -> JSONResponse:
    """Raw file bytes in, upload_id out, for agent apps whose model sees an attachment but cannot reproduce its
    bytes. Behind the same bearer auth as /mcp."""
    settings = get_settings()
    try:
        limit = settings.max_file_bytes
        if int(request.headers.get("content-length") or 0) > limit:
            raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise ToolFailure("file_too_large", f"file exceeds {limit // (1024 * 1024)} MB")
        upload_id, kind = save_upload(settings, bytes(body))
    except ToolFailure as e:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=400)
    log.info("upload stored kind=%s size=%d", kind, len(body))
    return JSONResponse({"upload_id": upload_id, "size_bytes": len(body), "kind": kind})


def build_http_app():
    settings = get_settings()
    if not settings.mcp_auth_token:
        raise SystemExit("MCP_AUTH_TOKEN is required for the http transport")
    app = mcp.streamable_http_app(host=settings.mcp_host, max_request_body_size=2 * 1024 * 1024)
    return BearerAuthMiddleware(app, settings.mcp_auth_token)


def main() -> None:
    # Logs go to stderr so they never corrupt the stdio transport. IDs and counts only, never document text.
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    settings = get_settings()
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
