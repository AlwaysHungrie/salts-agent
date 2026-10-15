"""Jobs are folders too: DATA_DIR/jobs/<job_id>/ holds job.md (the posting as sent), job.json and the posting's
embedding. Posting reads nothing with a model; finding candidates searches with the posting or the agent's query."""

import json
import re
import uuid
from pathlib import Path

import numpy as np

from .errors import ToolFailure
from .models import JobResult, Page
from .search import search
from .services import Services

_ID = re.compile(r"[0-9a-f]{32}")


def job_dir(svc: Services, job_id: str) -> Path:
    if not _ID.fullmatch(job_id or ""):
        raise ToolFailure("invalid_input", "job_id is not a valid id")
    return svc.settings.data_dir / "jobs" / job_id


async def post_job(svc: Services, text: str, title: str | None = None) -> JobResult:
    text = text.strip()
    if not text:
        raise ToolFailure("invalid_input", "the job has no text")
    title = (title or "").strip() or next(line.strip("# ").strip() for line in text.splitlines() if line.strip())[:120]
    [vec] = await svc.embedder.embed([text])
    job_id = uuid.uuid4().hex
    folder = job_dir(svc, job_id)
    folder.mkdir(parents=True)
    (folder / "job.md").write_text(text + "\n", encoding="utf-8")
    (folder / "job.json").write_text(json.dumps({"job_id": job_id, "title": title}, ensure_ascii=False),
                                     encoding="utf-8")
    np.save(folder / "embedding.npy", np.asarray(vec, dtype=np.float32))
    return JobResult(job_id=job_id, title=title)


async def find_candidates(svc: Services, job_id: str, query: str | None = None, offset: int = 0,
                          limit: int | None = None) -> Page:
    """Everyone ranked for the job. Without `query` the whole posting is the query (words and meaning); with one,
    the agent's query (the role, the must-have skills and their other names) replaces it for both."""
    folder = job_dir(svc, job_id)
    if not (folder / "job.md").is_file():
        raise ToolFailure("not_found", "no job with that id")
    if query and query.strip():
        return await search(svc, query, offset, limit)
    text = (folder / "job.md").read_text(encoding="utf-8")
    return await search(svc, text, offset, limit, query_vector=np.load(folder / "embedding.npy").tolist())


def list_jobs(svc: Services) -> list[JobResult]:
    """Every posted job, newest first."""
    root = svc.settings.data_dir / "jobs"
    folders = [f for f in root.iterdir() if (f / "job.json").is_file()] if root.is_dir() else []
    folders.sort(key=lambda f: (f / "job.json").stat().st_mtime, reverse=True)
    return [JobResult(**json.loads((f / "job.json").read_text(encoding="utf-8"))) for f in folders]
