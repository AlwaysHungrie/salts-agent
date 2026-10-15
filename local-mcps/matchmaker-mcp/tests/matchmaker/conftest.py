"""Matchmaker test setup: a temp DATA_DIR and fake model clients, so tests run offline and need no database.

Test documents use a tiny line format the fake LLM reads:
  Name: / Email: / Headline: / Location: / Relocate: yes|likely|unlikely|no / Years: 6 / Skill: Python
and, for the fake judge: Core: yes|maybe|no / Role: yes|maybe|no / Musts: yes,maybe,no
"""

import hashlib
import math
import re
import tempfile
from pathlib import Path

import pytest

from matchmaker.billing import ensure_budget
from matchmaker.config import Settings
from matchmaker.services import Services
from matchmaker.usage import UsageRecord, record


def _fields(text: str, name: str) -> list[str]:
    return [m.strip() for m in re.findall(rf"^{name}:\s*(.+)$", text, re.M)]


def _last(text: str, name: str) -> str | None:
    found = _fields(text, name)
    return found[-1] if found else None


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.prompts: list[str] = []

    async def structured(self, system, user, schema, *, name, reasoning_effort=None):
        ensure_budget()
        self.calls.append(name)
        self.prompts.append(system + "\n" + user)
        record(UsageRecord(kind="llm", model="fake", input_tokens=len(system + user) // 4, output_tokens=100,
                           cost_usd=0.0001))
        return schema.model_validate(getattr(self, "_" + name)(user))

    def _person_profile(self, user):
        headline = _last(user, "Headline") or "Unknown"
        years = _last(user, "Years")
        return {
            "name": _last(user, "Name"), "email": _last(user, "Email"), "phone": _last(user, "Phone"),
            "headline": headline, "current_title": headline, "seniority": None,
            "location": _last(user, "Location"), "open_to_relocate": _last(user, "Relocate") or "likely",
            "relocation_note": None, "work_mode": None, "years_experience": float(years) if years else None,
            "work_authorization": None, "notice_period": None, "languages": [], "education": None,
            "industries": [], "skills": list(dict.fromkeys(_fields(user, "Skill"))),
            "summary": f"Works as {headline}.",
        }


class FakeJudge(FakeLLM):
    """Job core: three fixed must-haves. Checks: each candidate's Core / Role / Musts lines; `skip` ids are left
    out of the answer."""

    def __init__(self) -> None:
        super().__init__()
        self.skip: set[str] = set()

    def _job_core(self, user):
        return {"role_type": "Backend engineer", "core_work": "Builds services.",
                "must_haves": ["Services in production", "Python", "Postgres"]}

    def _checks(self, user):
        out = []
        for cid, body in re.findall(r'<candidate id="(\w+)">(.*?)</candidate>', user, re.S):
            if cid in self.skip:
                continue
            musts = (_last(body, "Musts") or "no,no,no").split(",")
            out.append({"id": cid, "candidate_role_type": _last(body, "Headline") or "?",
                        "same_role_type": _last(body, "Role") or "no", "core_work": _last(body, "Core") or "no",
                        "must_haves": [{"must_have": f"m{n}", "answer": a} for n, a in enumerate(musts)],
                        "reason": "fake"})
        return {"candidates": out}


class FakeEmbedder:
    """Hashed bag-of-words vectors, so texts sharing words get similar vectors."""

    def __init__(self, dim: int = 64) -> None:
        self.dim = dim
        self.calls = 0

    async def embed(self, texts):
        ensure_budget()
        self.calls += 1
        record(UsageRecord(kind="embedding", model="fake", input_tokens=10, cost_usd=0.00001))
        out = []
        for t in texts:
            v = [0.0] * self.dim
            for tok in re.findall(r"[a-z0-9+#]+", t.lower()):
                h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n for x in v])
        return out


@pytest.fixture
def svc():
    settings = Settings().model_copy(update={"data_dir": Path(tempfile.mkdtemp(prefix="mm-test-")),
                                             "page_size": 2, "embed_dim": 64})
    s = Services(settings=settings)
    s._llm = FakeLLM()
    s._embedder = FakeEmbedder(64)
    s._judge = FakeJudge()
    return s


def resume(name: str, headline: str, skills: str, location: str = "Pune", relocate: str | None = None,
           years: float | None = 5, extra: str = "", phone: str | None = None) -> str:
    """skills: "Python, Django"."""
    phone = phone or "+91 9" + str(int(hashlib.md5(name.encode()).hexdigest(), 16))[:9]
    lines = [f"Name: {name}", f"Email: {name.split()[0].lower()}@example.com", f"Phone: {phone}",
             f"Headline: {headline}", f"Location: {location}"]
    if relocate:
        lines.append(f"Relocate: {relocate}")
    if years is not None:
        lines.append(f"Years: {years}")
    lines += [f"Skill: {s.strip()}" for s in skills.split(",") if s.strip()]
    return "\n".join(lines) + ("\n" + extra if extra else "") + "\n"
