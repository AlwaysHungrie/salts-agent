"""Judging a page of candidates. The job's core (role type, core work, must-haves) is read once and kept with the
job, so every batch is checked against the same list. The judge model answers yes / maybe / no per check for each
candidate from their full documents; the score is computed here, never by the model."""

import asyncio
import logging

from .errors import ToolFailure
from .jobs import job_dir
from .models import Answer, CandidateCheck, Checks, JobCore, JudgedCandidate, JudgedPage, Page
from .people import KINDS, people_dir
from .prompts import render
from .services import Services

log = logging.getLogger(__name__)

VALUE: dict[str, float] = {"yes": 1.0, "maybe": 0.5, "no": 0.0}
# Points for each check; they add up to 100. Years count against the years the job asks for (DEFAULT_YEARS when
# it does not say), so people who did the same work for longer are told apart.
CORE_POINTS, YEARS_POINTS, ROLE_POINTS, RECENT_POINTS, LEVEL_POINTS, MUST_POINTS = 30, 15, 15, 10, 5, 25
DEFAULT_YEARS = 3.0
FIRST_MUST_WEIGHT = 2  # the first must-have is the core experience; it counts twice as much as each other one
# The final score blends in the search place, so equal checks are told apart by relevance to the job.
SEARCH_SHARE = 0.15


def check_score(core_work: Answer, core_years: float, years_needed: float | None, same_role_type: Answer,
                latest_role_core: Answer, level_fit: Answer, must_haves: list[Answer]) -> float:
    """0-100 from the judge's answers alone."""
    weights = [FIRST_MUST_WEIGHT] + [1] * (len(must_haves) - 1)
    musts = (sum(w * VALUE[a] for w, a in zip(weights, must_haves)) / sum(weights) if must_haves
             else VALUE[core_work])
    needed = max(years_needed or DEFAULT_YEARS, 1.0)
    years = 0.0 if core_work == "no" else min(max(core_years, 0.0) / needed, 1.0)
    return (CORE_POINTS * VALUE[core_work] + YEARS_POINTS * years + ROLE_POINTS * VALUE[same_role_type]
            + RECENT_POINTS * VALUE[latest_role_core] + LEVEL_POINTS * VALUE[level_fit] + MUST_POINTS * musts)


def search_score(position: int, total: int) -> float:
    """100 for the first place in the whole ranked pool, falling evenly to 0 for the last."""
    return 100.0 if total <= 1 else 100.0 * (total - position) / (total - 1)


def score(checks: float, search: float) -> float:
    """No ceilings: one answer moves the score by its own points only, so a single flipped answer cannot drop a
    good candidate to the bottom (with ceilings it did: 91 to 25)."""
    return round((1 - SEARCH_SHARE) * checks + SEARCH_SHARE * search, 1)


async def job_core(svc: Services, job_id: str) -> JobCore:
    folder = job_dir(svc, job_id)
    if not (folder / "job.md").is_file():
        raise ToolFailure("not_found", "no job with that id")
    path = folder / "core.json"
    if path.is_file():
        try:
            return JobCore.model_validate_json(path.read_text(encoding="utf-8"))
        except ValueError:  # written by an older version: read the job again
            pass
    system, user = render("job_core", job=(folder / "job.md").read_text(encoding="utf-8"))
    core = await svc.core_reader.structured(system, user, JobCore, name="job_core")
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
        checks = await svc.judge.structured(system, user, Checks, name="checks")
        for c in checks.candidates:
            if c.id in short and short[c.id] not in out:
                out[short[c.id]] = c
    return out


async def judge_page(svc: Services, job_id: str, page: Page) -> JudgedPage:
    """Check every candidate on `page` against the job and order the page by score, best first; equal scores go
    by name (people with no name after them, by id). The score is the checks (85%) and the search place (15%)."""
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
        given = k.must_haves[:len(core.must_haves)]
        answers = [m.answer for m in given]
        answers += ["no"] * (len(core.must_haves) - len(answers))  # a must-have left unanswered counts as no
        checks_part = check_score(k.core_work, k.core_work_years, core.years_needed, k.same_role_type,
                                  k.latest_role_core, k.level_fit, answers)
        search_part = search_score(c.position, page.total)
        judged.append(JudgedCandidate(
            **c.model_dump(), score=score(checks_part, search_part),
            check_score=round(checks_part, 1), search_score=round(search_part, 1),
            candidate_role_type=k.candidate_role_type, same_role_type=k.same_role_type, core_work=k.core_work,
            core_work_years=k.core_work_years, latest_role_core=k.latest_role_core, level_fit=k.level_fit,
            must_haves=dict(zip(core.must_haves, answers)), reason=k.reason,
            evidence={"core_work": k.core_work_evidence} | {m: g.evidence for m, g in zip(core.must_haves, given)}))
    judged.sort(key=lambda c: (c.score is None, -(c.score or 0), c.name is None, (c.name or "").lower(),
                               c.person_id))
    if missing := sum(c.score is None for c in judged):
        log.warning("judge gave no answer for %d of %d candidates", missing, len(judged))
    return JudgedPage(job_id=job_id, role_type=core.role_type, core_work=core.core_work,
                      must_haves=core.must_haves, total=page.total, offset=page.offset, candidates=judged,
                      next_offset=page.next_offset)

