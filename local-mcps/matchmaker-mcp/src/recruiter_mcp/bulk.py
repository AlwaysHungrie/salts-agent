"""Folder ingest: every PDF resume in a folder, with no assistant in the loop.

Per file, cheapest check first:
1. source_files has this path with the same size and mtime -> already done (or given up on); the file is not read.
2. Its sha256 is already in the database (a renamed or copied file) -> duplicate_file, no model call.
3. Otherwise the vision model transcribes it and the normal ingest pipeline runs with the PDF attached.

Every outcome is written to source_files, so an interrupted run resumes where it stopped and failed files are
retried on the next run (up to max_attempts, or sooner if the file changes).
"""

import asyncio
import logging
import time
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .billing import ensure_budget, is_fatal, provider_failure
from .errors import ToolFailure
from .ingest import _find_duplicate, ingest_resume, read_pdf
from .services import Services
from .usage import track_usage

log = logging.getLogger(__name__)

DONE_STATUSES = ("created", "updated", "duplicate_file")

# (data, mime, filename) -> transcript
Transcriber = Callable[[bytes, str, str], Awaitable[str]]


@dataclass
class FileResult:
    path: str
    sha256: str | None
    status: str  # created | updated | duplicate_file | unchanged | gave_up | failed | stopped
    candidate_id: str | None = None
    error: str | None = None
    cost_usd: float = 0.0
    seconds: float = 0.0
    attempts: int = 1


@dataclass
class BulkReport:
    total_files: int
    results: list[FileResult] = field(default_factory=list)
    elapsed_s: float = 0.0
    stopped_reason: str | None = None  # set when a bad key, no credits or the spend cap ended the run early

    @property
    def counts(self) -> Counter:
        return Counter(r.status for r in self.results)

    @property
    def cost_usd(self) -> float:
        return sum(r.cost_usd for r in self.results)


@dataclass
class PendingFile:
    path: Path
    size: int
    mtime_ns: int
    attempts: int


@dataclass
class Scan:
    pending: list[PendingFile] = field(default_factory=list)
    skipped: list[FileResult] = field(default_factory=list)  # unchanged or gave_up; never read


def find_files(folder: Path, recursive: bool = True) -> list[Path]:
    """PDFs under folder (any extension case), skipping hidden files. Paths are resolved to absolute form."""
    pattern = "**/*" if recursive else "*"
    return sorted(
        p.resolve() for p in folder.glob(pattern)
        if p.suffix.lower() == ".pdf" and not p.name.startswith(".") and p.is_file()
    )


def inbox_dir(settings) -> Path:
    """The folder users drop PDFs into for bulk ingest. Created on first use."""
    p = (settings.inbox_dir or settings.data_dir / "inbox").expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


async def scan(svc: Services, files: list[Path], max_attempts: int = 3) -> Scan:
    """Split files into ones to process and ones known from earlier runs. One query, one stat per file."""
    rows = await svc.pool.fetch("SELECT * FROM source_files WHERE path = ANY($1::text[])", [str(f) for f in files])
    known = {r["path"]: r for r in rows}
    out = Scan()
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue  # removed since listing
        prev = known.get(str(f))
        same = prev is not None and prev["size_bytes"] == st.st_size and prev["mtime_ns"] == st.st_mtime_ns
        if same and prev["status"] in DONE_STATUSES:
            cid = str(prev["candidate_id"]) if prev["candidate_id"] else None
            out.skipped.append(FileResult(str(f), prev["sha256"], "unchanged", candidate_id=cid, attempts=0))
        elif same and prev["status"] == "failed" and prev["attempts"] >= max_attempts:
            out.skipped.append(FileResult(str(f), prev["sha256"], "gave_up", attempts=prev["attempts"],
                                          error=f"gave up after {prev['attempts']} attempts: {prev['error']}"))
        else:
            # A changed file starts its attempt count over.
            attempts = prev["attempts"] + 1 if same and prev["status"] == "failed" else 1
            out.pending.append(PendingFile(f, st.st_size, st.st_mtime_ns, attempts))
    return out


async def _record(svc: Services, f: PendingFile, r: FileResult) -> None:
    await svc.pool.execute(
        """INSERT INTO source_files (path, size_bytes, mtime_ns, sha256, status, candidate_id, error, attempts)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8)
           ON CONFLICT (path) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, mtime_ns = EXCLUDED.mtime_ns,
             sha256 = EXCLUDED.sha256, status = EXCLUDED.status, candidate_id = EXCLUDED.candidate_id,
             error = EXCLUDED.error, attempts = EXCLUDED.attempts, updated_at = now()""",
        r.path, f.size, f.mtime_ns, r.sha256, r.status, r.candidate_id, r.error, r.attempts,
    )


async def _ingest_one(svc: Services, f: PendingFile, transcribe: Transcriber, source: str) -> FileResult:
    t0 = time.monotonic()
    key, sha = str(f.path), None
    try:
        ensure_budget()
        original = await asyncio.to_thread(read_pdf, f.path, svc.settings.max_file_bytes)
        sha = original.sha256
        async with svc.pool.acquire() as conn:
            dup = await _find_duplicate(conn, sha)
        if dup:
            return FileResult(key, sha, "duplicate_file", candidate_id=str(dup["id"]),
                              seconds=time.monotonic() - t0, attempts=f.attempts)
        async with track_usage(svc.pool, "ingest_folder") as usage:
            text = await transcribe(original.data, original.mime, f.path.name)
            if len(text.strip()) < 50:
                raise ToolFailure("empty_transcript", "no readable text in file")
            res = await ingest_resume(svc, resume_text=text, original=original, source=source)
        return FileResult(key, sha, res.status, candidate_id=res.candidate_id, cost_usd=usage.cost_usd,
                          seconds=time.monotonic() - t0, attempts=f.attempts)
    except Exception as e:  # provider errors, timeouts, corrupt files
        failure = provider_failure(e)
        if failure is None:
            log.warning("folder ingest file failed: %s", type(e).__name__)
        # Bad key, no credits or spend cap reached: not this file's fault, so it is not counted as an attempt.
        status = "stopped" if is_fatal(e) else "failed"
        error = f"{failure.code}: {failure.message}" if failure else type(e).__name__
        return FileResult(key, sha, status, error=error, seconds=time.monotonic() - t0, attempts=f.attempts)


async def bulk_ingest(
    svc: Services,
    files: list[Path],
    transcribe: Transcriber,
    *,
    concurrency: int = 4,
    max_attempts: int = 3,
    source: str = "other",
    on_result: Callable[[int, int, FileResult], None] | None = None,
    scanned: Scan | None = None,
) -> BulkReport:
    """Ingest files. on_result(done, pending_total, result) fires for each file that needed processing."""
    started = time.monotonic()
    sc = scanned or await scan(svc, files, max_attempts)
    report = BulkReport(total_files=len(files), results=list(sc.skipped))
    sem = asyncio.Semaphore(max(1, concurrency))
    done = 0

    async def run(f: PendingFile) -> None:
        nonlocal done
        # Whole file under the semaphore, so at most `concurrency` files are in memory at once.
        async with sem:
            if report.stopped_reason:
                r = FileResult(str(f.path), None, "stopped", error=report.stopped_reason, attempts=f.attempts)
            else:
                r = await _ingest_one(svc, f, transcribe, source)
        if r.status == "stopped":
            # Left untouched in source_files, so the next run picks the file up as if new.
            report.stopped_reason = report.stopped_reason or r.error
        else:
            await _record(svc, f, r)
        report.results.append(r)
        done += 1
        if on_result:
            on_result(done, len(sc.pending), r)

    await asyncio.gather(*(run(f) for f in sc.pending))
    report.elapsed_s = time.monotonic() - started
    return report


# ---------------------------------------------------------------- background runs for the MCP tool


@dataclass
class FolderRun:
    run_id: str
    folder: str
    total_files: int
    to_process: int
    started_at: datetime
    processed: int = 0
    results: list[FileResult] = field(default_factory=list)  # skipped files first, then each processed file
    finished_at: datetime | None = None
    error: str | None = None
    stopped_reason: str | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()


class FolderRuns:
    """At most one folder run at a time, so two runs never transcribe the same file twice."""

    def __init__(self) -> None:
        self.runs: dict[str, FolderRun] = {}
        self.latest: FolderRun | None = None

    def active(self) -> FolderRun | None:
        return self.latest if self.latest and self.latest.running else None

    def start(self, svc: Services, folder: Path, files: list[Path], sc: Scan, transcribe: Transcriber,
              *, source: str, concurrency: int, max_attempts: int) -> FolderRun:
        run = FolderRun(run_id=str(uuid.uuid4()), folder=str(folder), total_files=len(files),
                        to_process=len(sc.pending), started_at=datetime.now(UTC), results=list(sc.skipped))

        def progress(done: int, _: int, r: FileResult) -> None:
            run.processed = done
            run.results.append(r)

        async def go() -> None:
            try:
                report = await bulk_ingest(svc, files, transcribe, concurrency=concurrency,
                                               max_attempts=max_attempts, source=source, on_result=progress,
                                               scanned=sc)
                run.stopped_reason = report.stopped_reason
            except Exception as e:
                log.error("folder run %s crashed: %s", run.run_id, type(e).__name__)
                run.error = type(e).__name__
            finally:
                run.finished_at = datetime.now(UTC)
                log.info("folder run %s finished processed=%d", run.run_id, run.processed)

        # The task copies the caller's context: its API key and spend cap apply to the whole run. Usage is still
        # tracked per file, not billed to the tool call that started it.
        run.task = asyncio.get_running_loop().create_task(go())
        self.runs[run.run_id] = run
        self.latest = run
        return run

    async def cancel_all(self) -> None:
        for run in self.runs.values():
            if run.task and not run.task.done():
                run.task.cancel()
        await asyncio.gather(*(r.task for r in self.runs.values() if r.task), return_exceptions=True)
