"""Judging a page of candidates. The job's core (role type, core work, must-haves) is read once and kept with the
job, so every batch is checked against the same list. The judge model answers yes / maybe / no per check for each
candidate from their full documents; the score is computed here, never by the model."""

import asyncio
import logging
from statistics import mean

from .errors import ToolFailure
from .jobs import job_dir
from .models import Answer, CandidateCheck, Checks, JobCore, JudgedCandidate, JudgedPage, Page
from .people import KINDS, people_dir
from .prompts import render
from .services import Services

log = logging.getLogger(__name__)

VALUE: dict[str, float] = {"yes": 1.0, "maybe": 0.5, "no": 0.0}
# Points for each check; the three add up to 100.
CORE_POINTS, ROLE_POINTS, MUST_POINTS = 50, 20, 30
# Ceilings: work that was not the core work, or a different kind of role, cannot pass these whatever else is true.
CORE_NO_CAP, ROLE_NO_CAP = 49, 39


def score(core_work: Answer, same_role_type: Answer, must_haves: list[Answer]) -> int:
    musts = mean(VALUE[a] for a in must_haves) if must_haves else VALUE[core_work]
    s = CORE_POINTS * VALUE[core_work] + ROLE_POINTS * VALUE[same_role_type] + MUST_POINTS * musts
    if core_work == "no":
        s = min(s, CORE_NO_CAP)
    if same_role_type == "no":
        s = min(s, ROLE_NO_CAP)
    return round(s)


async def job_core(svc: Services, job_id: str) -> JobCore:
    folder = job_dir(svc, job_id)
    if not (folder / "job.md").is_file():
        raise ToolFailure("not_found", "no job with that id")
    path = folder / "core.json"
    if path.is_file():
        return JobCore.model_validate_json(path.read_text(encoding="utf-8"))
    system, user = render("job_core", job=(folder / "job.md").read_text(encoding="utf-8"))
    core = await svc.judge.structured(system, user, JobCore, name="job_core")
    if not core.must_haves:
        raise ToolFailure("llm_invalid_output", "no must-haves could be read from the job")
    path.write_text(core.model_dump_json(indent=1), encoding="utf-8")
    return core


def _documents(svc: Services, person_id: str) -> str:
    folder = people_dir(svc) / person_id
    return "\n\n".join(f'<document kind="{k}">\n{(folder / f"{k}.txt").read_text(encoding="utf-8")}\n</document>'
                       for k in KINDS if (folder / f"{k}.txt").is_file())


async def _check(svc: Services, system: str, batch: list) -> dict[str, CandidateCheck]:
    """Checks keyed by person id. Ids are shortened for the model and mapped back; a candidate the model left
    out is asked for once more on its own batch."""
    short = {c.person_id[:8]: c.person_id for c in batch}
    out: dict[str, CandidateCheck] = {}
    for _ in range(2):
        todo = [c for c in batch if c.person_id not in out]
        if not todo:
            break
        user = "\n\n".join(f'<candidate id="{c.person_id[:8]}">\n{_documents(svc, c.person_id)}\n</candidate>'
                           for c in todo)
        checks = await svc.judge.structured(system, user, Checks, name="checks",
                                            reasoning_effort=svc.settings.judge_reasoning_effort)
        for c in checks.candidates:
            if c.id in short and short[c.id] not in out:
                out[short[c.id]] = c
    return out


async def judge_page(svc: Services, job_id: str, page: Page) -> JudgedPage:
    """Check every candidate on `page` against the job and order the page by score, best first; equal scores go
    by name (people with no name after them, by id)."""
    core = await job_core(svc, job_id)
    system, _ = render("judge", role_type=core.role_type, core_work=core.core_work,
                       must_haves="\n".join(f"  {n}. {m}" for n, m in enumerate(core.must_haves, 1)))
    size = svc.settings.judge_batch
    batches = [page.candidates[i:i + size] for i in range(0, len(page.candidates), size)]
    checks: dict[str, CandidateCheck] = {}
    for found in await asyncio.gather(*(_check(svc, system, b) for b in batches)):
        checks.update(found)

    judged = []
    for c in page.candidates:
        k = checks.get(c.person_id)
        if k is None:
            judged.append(JudgedCandidate(**c.model_dump(), score=None))
            continue
        answers = [m.answer for m in k.must_haves[:len(core.must_haves)]]
        answers += ["no"] * (len(core.must_haves) - len(answers))  # a must-have left unanswered counts as no
        judged.append(JudgedCandidate(
            **c.model_dump(), score=score(k.core_work, k.same_role_type, answers),
            candidate_role_type=k.candidate_role_type, same_role_type=k.same_role_type, core_work=k.core_work,
            must_haves=dict(zip(core.must_haves, answers)), reason=k.reason))
    judged.sort(key=lambda c: (c.score is None, -(c.score or 0), c.name is None, (c.name or "").lower(),
                               c.person_id))
    if missing := sum(c.score is None for c in judged):
        log.warning("judge gave no answer for %d of %d candidates", missing, len(judged))
    return JudgedPage(job_id=job_id, role_type=core.role_type, core_work=core.core_work,
                      must_haves=core.must_haves, total=page.total, offset=page.offset, candidates=judged,
                      next_offset=page.next_offset)

