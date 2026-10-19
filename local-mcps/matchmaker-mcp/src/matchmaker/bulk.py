"""Bulk ingest from the server's own inbox folder. The agent gives the user the folder; the user puts resumes in it
(PDF, DOCX, TXT, MD; subfolders fine) and says go; a background run adds each file as a new person's resume.

A ledger (DATA_DIR/inbox.json) remembers each file by path, size and modification time, so a later run reads only
new or changed files. A file whose text is already someone's resume is skipped without a model call. A file that
failed is tried again on the next run, up to MAX_ATTEMPTS."""

import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import billing
from .documents import SUFFIXES, read_text
from .errors import ToolFailure
from .people import add_document, people_dir
from .services import Services
from .usage import track_usage

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
CONCURRENCY = 8
PER_FILE_USD = billing.COST_RULES["ingest_inbox"].default_estimate


def inbox_dir(svc: Services) -> Path:
    folder = (svc.settings.inbox_dir or svc.settings.data_dir / "inbox").resolve()
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def inbox_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in SUFFIXES
                  and not any(part.startswith(".") for part in p.relative_to(folder).parts))


def _ledger_path(svc: Services) -> Path:
    return svc.settings.data_dir / "inbox.json"


def read_ledger(svc: Services) -> dict:
    path = _ledger_path(svc)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _stamp(path: Path) -> list[int]:
    st = path.stat()
    return [st.st_size, st.st_mtime_ns]


def pending(svc: Services, files: list[Path], ledger: dict) -> tuple[list[Path], int, int]:
    """(files to read, already done, given up)."""
    todo, done, gave_up = [], 0, 0
    for f in files:
        entry = ledger.get(str(f))
        if entry and entry["stamp"] == _stamp(f):
            if entry["status"] in ("added", "duplicate"):
                done += 1
                continue
            if entry.get("attempts", 0) >= MAX_ATTEMPTS:
                gave_up += 1
                continue
        todo.append(f)
    return todo, done, gave_up


def _known_resumes(svc: Services) -> set[str]:
    root = people_dir(svc)
    out = set()
    for f in root.glob("*/person.json") if root.is_dir() else []:
        doc = json.loads(f.read_text(encoding="utf-8"))["documents"].get("resume")
        if doc:
            out.add(doc["sha256"])
    return out


@dataclass
class Run:
    run_id: str
    folder: str
    total_files: int
    to_process: int
    started_at: datetime
    counts: dict[str, int] = field(default_factory=dict)
    failures: list[dict] = field(default_factory=list)
    cost_usd: float = 0.0
    finished_at: datetime | None = None
    stopped_reason: str | None = None
    task: asyncio.Task | None = None

    @property
    def processed(self) -> int:
        return sum(self.counts.values())

    @property
    def state(self) -> str:
        if self.finished_at is None:
            return "running"
        return "stopped" if self.stopped_reason else "finished"


class Runs:
    """Runs since the server started; one at a time."""

    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}
        self.latest: Run | None = None

    def active(self) -> Run | None:
        return self.latest if self.latest and self.latest.state == "running" else None

    def start(self, svc: Services, folder: Path, files: list[Path], todo: list[Path]) -> Run:
        run = Run(run_id=uuid.uuid4().hex[:12], folder=str(folder), total_files=len(files), to_process=len(todo),
                  started_at=datetime.now(UTC))
        self.runs[run.run_id] = self.latest = run
        # The task copies this context, so the caller's key and Tool-Call-Max-Charge cover the whole run.
        run.task = asyncio.create_task(_process(svc, run, todo))
        return run


async def _process(svc: Services, run: Run, todo: list[Path]) -> None:
    ledger = read_ledger(svc)
    known = _known_resumes(svc)
    lock = asyncio.Lock()
    sem = asyncio.Semaphore(CONCURRENCY)
    stop = asyncio.Event()

    async def note(path: Path, status: str, error: str | None = None, person_id: str | None = None) -> None:
        async with lock:
            entry = ledger.get(str(path), {})
            attempts = entry.get("attempts", 0) + (status == "failed")
            ledger[str(path)] = {"stamp": _stamp(path), "status": status, "attempts": attempts,
                                 "person_id": person_id, "error": error}
            run.counts[status] = run.counts.get(status, 0) + 1
            if status == "failed":
                run.failures.append({"file": str(path), "error": error})
            tmp = _ledger_path(svc).with_name("inbox.json.tmp")
            tmp.write_text(json.dumps(ledger, indent=1), encoding="utf-8")
            tmp.replace(_ledger_path(svc))

    async def one(path: Path) -> None:
        async with sem:
            if stop.is_set():
                return
            try:
                text = read_text(path)
                sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
                if sha in known:
                    await note(path, "duplicate")
                    return
                known.add(sha)
                async with track_usage("ingest_inbox") as t:
                    result = await add_document(svc, "resume", file_path=path)
                run.cost_usd += t.cost_usd
                await note(path, "added", person_id=result.person_id)
            except Exception as e:  # noqa: BLE001 - every outcome is recorded per file
                failure = billing.provider_failure(e)
                code = failure.code if failure else "internal_error"
                if failure and failure.code in billing.FATAL_CODES:
                    run.stopped_reason = f"{failure.code}: {failure.message}"
                    stop.set()
                    return
                await note(path, "failed", error=failure.message if failure else type(e).__name__)
                log.info("inbox file failed: %s", code)

    try:
        await asyncio.gather(*(one(p) for p in todo))
    finally:
        run.finished_at = datetime.now(UTC)
        log.info("inbox run %s %s: %s", run.run_id, run.state, run.counts)


def scan(svc: Services) -> dict:
    folder = inbox_dir(svc)
    files = inbox_files(folder)
    todo, done, gave_up = pending(svc, files, read_ledger(svc))
    return {"folder": folder, "files": files, "todo": todo, "already_added": done, "gave_up": gave_up}


def clear(svc: Services) -> int:
    """Deletes every file in the inbox and forgets them in the ledger. People already added keep their own copies."""
    folder = inbox_dir(svc)
    files = [p for p in folder.rglob("*") if p.is_file()]
    for f in files:
        f.unlink()
    for d in sorted((p for p in folder.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        d.rmdir()
    ledger = read_ledger(svc)
    if ledger:
        kept = {k: v for k, v in ledger.items() if not Path(k).is_relative_to(folder)}
        tmp = _ledger_path(svc).with_name("inbox.json.tmp")
        tmp.write_text(json.dumps(kept, indent=1), encoding="utf-8")
        tmp.replace(_ledger_path(svc))
    return len(files)


def require_idle(runs: Runs) -> None:
    if active := runs.active():
        raise ToolFailure("already_running", f"inbox run {active.run_id} is still running; check get_ingest_status")
