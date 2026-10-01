"""Deterministic candidate and job specs, and the ground-truth fit between them.

A spec holds the facts (family, skills, role dates, location, relocation); an LLM only writes the text. Ground truth
is computed from specs, never from what the system extracted, so extraction mistakes count against the system."""

import hashlib
import json
import random
from dataclasses import asdict, dataclass, field
from datetime import date

from .taxonomy import (
    AWS_SERVICES,
    CITIES,
    COMPANIES,
    EDUCATION,
    FAMILIES,
    FAMILY_WEIGHTS,
    FIRST_NAMES,
    GENERIC,
    IMPLIES,
    LAST_NAMES,
    VARIANTS,
)

# Role dates are laid out back from this month, so specs do not change with the calendar.
ANCHOR = date(2026, 9, 1)
MIN_STRONG, MAX_STRONG = 3, 40
RESUME_STYLES = ["founder", "classic", "naukri", "minimal"]
JOB_STYLES = ["enterprise", "startup", "agency"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass
class Role:
    title: str
    company: str
    start: str  # YYYY-MM
    end: str  # YYYY-MM or "present"
    family: str
    skills: list[str]


@dataclass
class Candidate:
    id: str
    name: str
    email: str
    phone: str
    family: str
    stack: str
    relevant_years: float
    total_years: float
    city: str  # CITIES key
    location_written: str
    relocate: bool | None
    preferred: list[str]  # CITIES keys
    notice_days: int | None
    skills: list[str]  # canonical, with implied umbrellas: what ground truth uses
    written_skills: list[str]  # as the resume spells them
    roles: list[Role]
    education: str
    style: str

    def text_hash(self) -> str:
        return _hash(asdict(self))


@dataclass
class Job:
    id: str
    title: str
    family: str
    stack: str | None
    must_haves: list[str]  # "A or B" = either
    nice_to_haves: list[str]
    min_years: float
    max_years: float | None
    mode: str  # onsite | hybrid | remote | country
    cities: list[str]  # CITIES keys
    style: str
    jd_text: str | None = None  # fixed text (the hand-written sample); otherwise generated
    notes: list[str] = field(default_factory=list)

    def text_hash(self) -> str:
        return _hash(asdict(self))


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]


# ------------------------------------------------------------------ ground truth


def alternatives(requirement: str) -> list[str]:
    return [a.strip() for a in requirement.split(" or ")]


def location_ok(c: Candidate, j: Job) -> bool:
    if j.mode in ("remote", "country"):
        return True
    if c.city in j.cities:
        return True
    if c.city == "remote" or c.relocate is False:
        return False
    if set(c.preferred) & set(j.cities):
        return True
    return bool(c.relocate) and not c.preferred


def years_now(c: Candidate, today: date | None = None) -> float:
    """Relevant years as of today: a current role keeps counting after ANCHOR, as it does in the system."""
    today = today or date.today()
    drift = (today.year * 12 + today.month) - (ANCHOR.year * 12 + ANCHOR.month)
    current = any(r.end == "present" and r.family == c.family for r in c.roles)
    return c.relevant_years + (max(0, drift) / 12 if current else 0)


def fit(c: Candidate, j: Job, today: date | None = None) -> dict:
    have = {s.lower() for s in c.skills}
    met = [m for m in j.must_haves if any(a.lower() in have for a in alternatives(m))]
    coverage = len(met) / len(j.must_haves)
    hi = j.max_years if j.max_years is not None else 99.0
    family = c.family == j.family
    loc = location_ok(c, j)
    rel = years_now(c, today)
    years = j.min_years - 1 <= rel <= hi + 2
    return {
        "strong": family and coverage == 1 and years and loc,
        "acceptable": family and coverage >= 0.5 and loc and j.min_years - 2 <= rel <= hi + 4,
        "family": family,
        "coverage": round(coverage, 2),
        "years_ok": years,
        "location_ok": loc,
    }


# ------------------------------------------------------------------ candidates


def _weighted(rng: random.Random, weights: dict):
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] if not isinstance(weights[k], tuple) else weights[k][0]
                                      for k in keys])[0]


def _ym(months_before: int) -> str:
    idx = ANCHOR.year * 12 + ANCHOR.month - 1 - months_before
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def _years_band(rng: random.Random) -> float:
    lo, hi = rng.choices([(0.5, 2.5), (3, 6), (6, 10), (10, 16)], weights=[25, 35, 28, 12])[0]
    return round(rng.uniform(lo, hi), 1)


def _split(rng: random.Random, months: int, parts: int) -> list[int]:
    parts = max(1, min(parts, months // 6 or 1))
    cuts = sorted(rng.sample(range(6, months - 5), parts - 1)) if parts > 1 and months > 12 else []
    bounds = [0, *cuts, months]
    return [b - a for a, b in zip(bounds, bounds[1:])]


def _written(rng: random.Random, skills: list[str]) -> list[str]:
    out = []
    for s in skills:
        if s == "AWS" and rng.random() < 0.3:
            out.extend(rng.sample(AWS_SERVICES, 3))  # services only, never the word "AWS"
        elif s in VARIANTS and rng.random() < 0.35:
            out.append(rng.choice(VARIANTS[s]))
        else:
            out.append(s)
    return out


def expand(skills: list[str]) -> list[str]:
    out = list(skills)
    for s in skills:
        for parent in IMPLIES.get(s, []):
            if parent not in out:
                out.append(parent)
    return out


def make_candidate(rng: random.Random, i: int, used_emails: set[str]) -> Candidate:
    family = _weighted(rng, FAMILY_WEIGHTS)
    stack = rng.choice(list(FAMILIES[family]))
    titles, core, optional = FAMILIES[family][stack]
    relevant = _years_band(rng)

    skills = core[:2] + [s for s in core[2:] if rng.random() < 0.65] + [s for s in optional if rng.random() < 0.25]
    roles: list[Role] = []
    rel_months = max(6, round(relevant * 12))
    gap = rng.choice([0] * 9 + [rng.randint(1, 6)])
    end = gap
    durations = _split(rng, rel_months, 1 if relevant < 2 else rng.randint(2, 3 if relevant < 8 else 4))
    companies = rng.sample(COMPANIES, len(durations) + 1)
    for n, months in enumerate(durations):
        title = titles[0] if n == 0 else rng.choice(titles)
        if n == 0 and relevant >= 6:
            title = f"Senior {title}" if not title.startswith("Senior") else title
        role_skills = rng.sample(skills, min(len(skills), rng.randint(2, 4)))
        roles.append(Role(title, companies[n], _ym(end + months - 1), "present" if end == 0 else _ym(end),
                          family, role_skills))
        end += months
    total = relevant
    if rng.random() < 0.12:  # career switcher: earlier years in another family
        other = rng.choice([f for f in FAMILIES if f != family])
        o_stack = rng.choice(list(FAMILIES[other]))
        o_titles, o_core, _ = FAMILIES[other][o_stack]
        months = rng.randint(12, 48)
        o_skills = o_core[:2]
        skills += [s for s in o_skills if s not in skills]
        roles.append(Role(rng.choice(o_titles), companies[-1], _ym(end + months - 1), _ym(end), other, o_skills))
        total = round(relevant + months / 12, 1)
    skills += rng.sample(GENERIC, rng.randint(1, 3))
    skills = list(dict.fromkeys(skills))

    city = _weighted(rng, CITIES)
    relocate: bool | None = None
    preferred: list[str] = []
    if city != "remote":
        r = rng.random()
        others = [k for k in CITIES if k not in (city, "remote")]
        if r < 0.15:
            relocate = True
        elif r < 0.25:
            relocate = True
            preferred = rng.sample(others[:6], rng.randint(1, 2))
        elif r < 0.30:
            relocate = False

    while True:
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        email = f"{first}.{last}{rng.randint(1, 999)}@example.com".lower().replace("'", "")
        if email not in used_emails:
            used_emails.add(email)
            break
    return Candidate(
        id=f"c{i:04d}",
        name=f"{first} {last}",
        email=email,
        phone=f"+91 9{rng.randint(100000000, 999999999)}",
        family=family,
        stack=stack,
        relevant_years=relevant,
        total_years=total,
        city=city,
        location_written=rng.choice(CITIES[city][1]),
        relocate=relocate,
        preferred=preferred,
        notice_days=rng.choice([0, 15, 30, 30, 60, 60, 90, None]),
        skills=expand(skills),
        written_skills=_written(rng, skills),
        roles=roles,
        education=rng.choice(EDUCATION),
        style=rng.choice(RESUME_STYLES),
    )


# ------------------------------------------------------------------ jobs

SAMPLE_JOB_ID = "j000_sample_ai_engineer"


def sample_job(jd_text: str) -> Job:
    """The hand-written AI Engineer JD, with ground truth set by hand."""
    return Job(
        id=SAMPLE_JOB_ID, title="AI Engineer (Agentic AI) - AWS & Microsoft Copilot Studio", family="ai_engineer",
        stack=None, must_haves=["Python", "Generative AI", "AWS"], nice_to_haves=["Microsoft Copilot Studio"],
        min_years=2, max_years=None, mode="country", cities=[], style="enterprise", jd_text=jd_text,
        notes=["Location is a country ('India'), not a city"],
    )


def make_job(rng: random.Random, i: int) -> Job:
    family = _weighted(rng, FAMILY_WEIGHTS)
    stack = rng.choice(list(FAMILIES[family]))
    titles, core, optional = FAMILIES[family][stack]
    n_must = rng.randint(2, 4)
    must = [core[0]] + rng.sample(core[1:], n_must - 1)
    if rng.random() < 0.15 and len(must) > 1:
        alt = rng.choice([s for s in core + optional if s not in must])
        must[-1] = f"{must[-1]} or {alt}"
    used = {a for m in must for a in alternatives(m)}
    nice = rng.sample([s for s in core + optional if s not in used], min(rng.randint(2, 4), len(core + optional)
                                                                         - len(used)))
    lo, hi = rng.choice([(0, 2), (1, 3), (2, 5), (3, 6), (4, 7), (5, 8), (6, 10), (8, None)])
    if hi is not None and rng.random() < 0.3:
        hi = None  # "4+ years"
    mode = rng.choices(["onsite", "hybrid", "remote", "country"], weights=[38, 40, 16, 6])[0]
    cities: list[str] = []
    if mode in ("onsite", "hybrid"):
        pool = {k: v for k, v in CITIES.items() if k != "remote"}
        cities = [_weighted(rng, pool)]
        if mode == "hybrid" and rng.random() < 0.4:
            cities.append(_weighted(rng, {k: v for k, v in pool.items() if k not in cities}))
    title = rng.choice(titles)
    if lo >= 5:
        title = f"Senior {title}" if not title.startswith("Senior") else title
    return Job(id=f"j{i:03d}", title=title, family=family, stack=stack, must_haves=must, nice_to_haves=nice,
               min_years=lo, max_years=hi, mode=mode, cities=cities, style=rng.choice(JOB_STYLES))


# ------------------------------------------------------------------ corpus


def build(seed: int = 7, n_candidates: int = 1000, n_jobs: int = 50,
          sample_jd: str | None = None) -> tuple[list[Candidate], list[Job]]:
    """Candidates, then jobs resampled until each has MIN_STRONG..MAX_STRONG strong fits."""
    rng = random.Random(seed)
    emails: set[str] = set()
    candidates = [make_candidate(rng, i, emails) for i in range(n_candidates)]
    jobs: list[Job] = [sample_job(sample_jd)] if sample_jd else []
    i = 0
    while len(jobs) < n_jobs + (1 if sample_jd else 0):
        for _ in range(200):
            j = make_job(rng, i)
            strong = sum(fit(c, j, ANCHOR)["strong"] for c in candidates)
            if MIN_STRONG <= strong <= MAX_STRONG:
                jobs.append(j)
                break
        i += 1
    return candidates, jobs


def month_label(ym: str) -> str:
    if ym == "present":
        return "Present"
    y, m = ym.split("-")
    return f"{MONTHS[int(m) - 1]} {y}"
