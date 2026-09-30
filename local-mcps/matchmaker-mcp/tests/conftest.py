"""Test setup. Uses a separate `recruiter_test` database on the docker-compose Postgres and a temp DATA_DIR.
Env vars are set before recruiter_mcp reads settings."""

import asyncio
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path

import asyncpg
import pytest
from dotenv import dotenv_values

ADMIN_URL = os.environ.get("TEST_ADMIN_DATABASE_URL", "postgresql://recruiter:recruiter@localhost:5432/recruiter")
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + "/recruiter_test"
_env_file = dotenv_values(Path(__file__).parents[1] / ".env")
_live_key = os.environ.get("LLM_API_KEY") or _env_file.get("LLM_API_KEY")
os.environ["DATABASE_URL"] = TEST_URL
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="recruiter-test-")

from recruiter_mcp.billing import ensure_budget  # noqa: E402
from recruiter_mcp.config import get_settings  # noqa: E402
from recruiter_mcp.migrate import migrate  # noqa: E402
from recruiter_mcp.services import Services, load_normalizer  # noqa: E402
from recruiter_mcp.skills import SkillNormalizer, load_seed  # noqa: E402
from recruiter_mcp.storage import LocalStorage  # noqa: E402
from recruiter_mcp.usage import UsageRecord, record  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "resumes"
JOB_FIXTURES = Path(__file__).parent / "fixtures" / "jobs"


def fixture_text(fid: str) -> str:
    return (FIXTURES / f"{fid}.txt").read_text(encoding="utf-8")


def job_fixture(jid: str) -> dict:
    return json.loads((JOB_FIXTURES / f"{jid}.json").read_text(encoding="utf-8"))


class FakeLLM:
    """Offline stand-in. Extraction returns the fixture's expected profile; JD parsing returns the fixture
    job's expected requirements; scoring uses a transparent heuristic over the rubric lines."""

    def __init__(self) -> None:
        self.by_text = {
            p.with_suffix(".txt").read_text(encoding="utf-8").strip(): json.loads(p.read_text(encoding="utf-8"))
            for p in FIXTURES.glob("*.json")
        }
        self.jobs = {j["jd_text"].strip(): j["requirements"] for j in map(json.loads, map(Path.read_text,
                     JOB_FIXTURES.glob("*.json")))}
        self.normalizer = SkillNormalizer(load_seed())
        self.calls = 0
        self.fail_for: set[str] = set()  # candidate current_titles whose scoring call should raise

    async def structured(self, system, user, schema, *, name, reasoning_effort=None):
        ensure_budget()
        self.calls += 1
        record(UsageRecord(kind="llm", model="fake", input_tokens=len(system + user) // 4, output_tokens=200,
                           cost_usd=0.0001))
        if name == "candidate_profile":
            m = re.search(r"<resume>(.*)</resume>", user, re.S)
            golden = self.by_text.get(m.group(1).strip()) if m else None
            if golden is None and m:
                # Transcripts that differ in whitespace/bullets from the fixture: match on the email.
                golden = next((g for g in self.by_text.values()
                               if g.get("email") and g["email"] in m.group(1)), None)
            if golden is None:
                raise AssertionError("FakeLLM got a resume that is not a fixture")
            return schema.model_validate(golden)
        if name == "job_requirements":
            m = re.search(r"<jd>(.*)</jd>", user, re.S)
            golden = self.jobs.get(m.group(1).strip()) if m else None
            if golden is None:
                raise AssertionError("FakeLLM got a JD that is not a fixture")
            return schema.model_validate(golden)
        if name == "candidate_score":
            return schema.model_validate(self._score(system, user))
        raise AssertionError(f"unexpected schema {name}")

    def _score(self, system: str, user: str) -> dict:
        job = json.loads(re.search(r"<job>(.*?)</job>", system, re.S).group(1))
        cand = json.loads(re.search(r"<candidate>(.*)</candidate>", user, re.S).group(1))
        assert not {"name", "email", "phone"} & cand.keys(), "PII must be stripped before scoring"
        if cand.get("current_title") in self.fail_for:
            raise RuntimeError("simulated provider error")
        skills = {s.lower() for s in self.normalizer.normalize_all(cand["skills"])}
        must = job["must_have_skills"]
        met = [s for s in must if s.lower() in skills]
        nice = [s for s in job["nice_to_have_skills"] if s.lower() in skills]
        years = cand.get("years_exp_computed")
        lo, hi = job["min_years"] or 0, job["max_years"] or 99
        in_range = years is not None and lo <= years <= hi
        loc_ok = job["remote_ok"] or any(
            loc.lower() in (cand.get("location") or "").lower() for loc in job["locations"])
        return {
            "must_haves_met": met,
            "must_haves_missing": [s for s in must if s not in met],
            "concerns": [] if in_range else ["experience outside range"],
            "one_line_pitch": f"{cand.get('current_title')} with {', '.join(met) or 'no must-haves'}",
            "must_have_points": round(40 * len(met) / max(1, len(must))),
            "experience_points": 25 if in_range else 10,
            "recency_points": 10,
            "nice_to_have_points": round(10 * len(nice) / max(1, len(job["nice_to_have_skills"]))),
            "logistics_points": 10 if loc_ok else 4,
            "dealbreaker_violated": False,
        }


class FakeEmbedder:
    """Deterministic hashed bag-of-words vectors, so similar text gets similar vectors."""

    def __init__(self, dim: int) -> None:
        self.dim = dim

    async def embed(self, texts):
        ensure_budget()
        out = []
        for t in texts:
            v = [0.0] * self.dim
            for tok in re.findall(r"[a-z0-9+#.]+", t.lower()):
                h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0 if (h >> 64) & 1 else -1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n for x in v])
        return out


@pytest.fixture(scope="session", autouse=True)
def test_database():
    async def setup():
        conn = await asyncpg.connect(ADMIN_URL)
        try:
            await conn.execute("DROP DATABASE IF EXISTS recruiter_test WITH (FORCE)")
            await conn.execute("CREATE DATABASE recruiter_test")
        finally:
            await conn.close()
        await migrate(TEST_URL)

    asyncio.run(setup())
    yield


@pytest.fixture
async def svc():
    from recruiter_mcp.db import create_pool

    settings = get_settings()
    pool = await create_pool()
    await pool.execute("TRUNCATE candidates, candidate_versions, jobs, matches, usage, source_files CASCADE")
    storage = LocalStorage(Path(tempfile.mkdtemp(prefix="recruiter-files-")))
    s = Services(settings=settings, pool=pool, storage=storage, normalizer=await load_normalizer(pool))
    s._llm = FakeLLM()
    s._embedder = FakeEmbedder(settings.embed_dim)
    yield s
    await pool.close()


@pytest.fixture
def live_key():
    if not _live_key:
        pytest.skip("LLM_API_KEY not set in the environment")
    return _live_key
