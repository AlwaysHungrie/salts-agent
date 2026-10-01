"""LLM writes resume and JD text from specs. Output is cached per spec under tests/synthetic/data/ and regenerated only
when the spec (or GEN_VERSION) changes, since every call is paid."""

import asyncio
import json
import re
from pathlib import Path

from openai import AsyncOpenAI

from .specs import Candidate, Job, month_label

GEN_VERSION = "v1"
DATA = Path(__file__).parent / "data"
CITY_NAMES = {"bengaluru": "Bengaluru", "pune": "Pune", "mumbai": "Mumbai", "delhi": "Delhi NCR",
              "hyderabad": "Hyderabad", "chennai": "Chennai", "kolkata": "Kolkata", "ahmedabad": "Ahmedabad",
              "jaipur": "Jaipur", "kochi": "Kochi", "indore": "Indore"}

RESUME_STYLES = {
    "founder": """Header: name, then one line "<headline> | <location>", then contacts separated by " | ".
A 2-3 sentence summary paragraph. "Experience": per role, company and dates on one line, title and work mode on the
next, 3-4 bullets with concrete outcomes and numbers. Optional "Projects" with 1-2 side projects. "Skills" grouped into
2-4 labelled lines ("Languages: ...", "Stack: ..."). "Education" last.""",
    "classic": """Name, contact line. "Professional Summary". "Technical Skills" as one comma-separated list.
"Work Experience": "Title, Company (Mon YYYY - Mon YYYY)" then 2-4 bullets. "Education".""",
    "naukri": """Indian job-portal style. Name, then labelled lines: "Total Experience: X years Y months",
"Current Location", "Notice Period", "Key Skills". Then "Employment Details" with company, designation, duration and
2-3 responsibilities each. "Education". Optional "Personal Details" (languages only).""",
    "minimal": """Plain text, few headings. Name and contacts, one line about the person, then roles as short paragraphs
with dates, then a "Skills:" line, then education.""",
}

JOB_STYLES = {
    "enterprise": """Long enterprise JD: Position Summary, Key Responsibilities (grouped sub-headings), Required
Qualifications (Experience, Technical Skills), Preferred Qualifications, Success Metrics.""",
    "startup": """Short startup JD: a punchy intro about the company (invent one), "What you'll do", "What we need",
"Bonus points", a line on location and work mode.""",
    "agency": """Recruitment-agency listing: "Job Title:", "Experience:", "Location:", "Mandatory Skills:",
"Good to have:", then a short responsibilities list.""",
}


def resume_prompt(c: Candidate) -> tuple[str, str]:
    roles = [{"title": r.title, "company": r.company, "dates": f"{month_label(r.start)} - {month_label(r.end)}",
              "mention_in_bullets": r.skills} for r in c.roles]
    move = None
    if c.relocate is True and c.preferred:
        move = "Open to relocating to " + " or ".join(CITY_NAMES[p] for p in c.preferred)
    elif c.relocate is True:
        move = "Open to relocation anywhere in India"
    elif c.relocate is False:
        move = f"Not open to relocation; looking for roles in {c.location_written.split(',')[0]} only"
    facts = {
        "name": c.name, "email": c.email, "phone": c.phone, "location": c.location_written,
        "total_experience": f"{int(c.total_years)} years {round(c.total_years % 1 * 12)} months",
        "relocation_statement": move,
        "notice_period": None if c.notice_days is None else ("Immediate joiner" if c.notice_days == 0
                                                             else f"{c.notice_days} days"),
        "roles_most_recent_first": roles,
        "skills_section": c.written_skills,
        "education": c.education,
    }
    system = f"""You write realistic synthetic resumes used to test a recruiting system. Output only the resume as
plain text: no markdown, no code fences, no commentary.

The facts below are fixed. Rules:
- Include every role exactly as given: title, company and dates written as given. Invent no other jobs.
- The skills section must contain every entry of skills_section, spelled exactly as given, and nothing else.
- In bullets, mention only skills from skills_section (prefer the role's mention_in_bullets). Invent plausible work,
  products and metrics for the company.
- Put the email and phone near the name in every style.
- Write the location exactly as given. If relocation_statement is set, include it as a sentence. If notice_period is
  set, state it. Omit what is null.
- Do not state a total number of years of experience unless the style asks for it; if it does, use
  total_experience.

Style: {RESUME_STYLES[c.style]}"""
    return system, json.dumps(facts, ensure_ascii=False, indent=1)


def job_prompt(j: Job) -> tuple[str, str]:
    years = f"{j.min_years:g}-{j.max_years:g} years" if j.max_years is not None else f"{j.min_years:g}+ years"
    names = " or ".join(CITY_NAMES[c] for c in j.cities)
    location = {
        "onsite": f"{names}, on-site 5 days a week. No remote option.",
        "hybrid": f"Hybrid: {names}, 3 days a week in the office.",
        "remote": "Fully remote within India.",
        "country": "India",
    }[j.mode]
    facts = {"title": j.title, "experience": years, "location_and_work_mode": location,
             "required_skills": j.must_haves, "nice_to_have_skills": j.nice_to_haves}
    system = f"""You write realistic job descriptions used to test a recruiting system. Output only the JD as plain
text: no markdown symbols, no code fences, no commentary.

The facts below are fixed. Rules:
- Every required_skills entry appears in a required/mandatory section, spelled as given. "A or B" stays one
  requirement worded as alternatives.
- nice_to_have_skills appear only under preferred/good-to-have. Add no other required skills.
- State the experience range and the location/work mode exactly as given.
- Invent a fictional company, responsibilities and context that fit the role.

Style: {JOB_STYLES[j.style]}"""
    return system, json.dumps(facts, ensure_ascii=False, indent=1)


def resume_problems(c: Candidate, text: str) -> list[str]:
    low = text.lower()
    out = [f"skill {s!r}" for s in c.written_skills if s.lower() not in low]
    out += [f"company {r.company!r}" for r in c.roles if r.company.lower() not in low]
    out += [f"start {r.start[:4]}" for r in c.roles if r.start[:4] not in text]
    if c.email not in low:
        out.append("email")
    return out


def job_problems(j: Job, text: str) -> list[str]:
    low = text.lower()
    out = [f"must {a!r}" for m in j.must_haves for a in m.split(" or ") if a.lower() not in low]
    out += [f"city {c}" for c in j.cities if CITY_NAMES[c].split()[0].lower() not in low]
    return out


class Generator:
    def __init__(self, api_key: str, base_url: str, model: str, concurrency: int = 12) -> None:
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=120, max_retries=2)
        self.model = model
        self.sem = asyncio.Semaphore(concurrency)
        self.cost = 0.0
        self.calls = 0
        self.failed: list[str] = []

    async def _write(self, system: str, user: str) -> str:
        async with self.sem:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                extra_body={"usage": {"include": True}, "reasoning": {"effort": "minimal"}},
            )
        self.calls += 1
        self.cost += float(getattr(resp.usage, "cost", 0) or 0) if resp.usage else 0.0
        text = (resp.choices[0].message.content or "") if resp.choices else ""
        return re.sub(r"^```[a-z]*\n|\n```$", "", text.strip()).strip()

    async def _one(self, path: Path, key: str, prompt: tuple[str, str], problems) -> None:
        last: list[str] = []
        for _ in range(3):
            text = await self._write(*prompt)
            last = problems(text)
            if not last:
                path.write_text(json.dumps({"hash": key, "text": text}, ensure_ascii=False, indent=1) + "\n",
                                encoding="utf-8")
                return
        self.failed.append(f"{path.stem}: missing {', '.join(last[:5])}")

    async def run(self, candidates: list[Candidate], jobs: list[Job]) -> None:
        tasks = []
        for kind, items, prompt, problems in (
            ("resumes", candidates, resume_prompt, resume_problems),
            ("jobs", [j for j in jobs if j.jd_text is None], job_prompt, job_problems),
        ):
            (DATA / kind).mkdir(parents=True, exist_ok=True)
            for item in items:
                path = DATA / kind / f"{item.id}.json"
                key = f"{GEN_VERSION}:{item.text_hash()}"
                if cached(path) == key:
                    continue
                tasks.append(self._one(path, key, prompt(item), lambda t, it=item, p=problems: p(it, t)))
        if not tasks:
            print("generation: everything cached")
            return
        print(f"generation: {len(tasks)} texts to write with {self.model}")
        done = 0
        for fut in asyncio.as_completed(tasks):
            await fut
            done += 1
            if done % 50 == 0 or done == len(tasks):
                print(f"  {done}/{len(tasks)}  ${self.cost:.3f}  failed {len(self.failed)}", flush=True)


def cached(path: Path) -> str | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8")).get("hash")


def load_text(kind: str, item) -> str | None:
    """Cached text for this exact spec, or None (never generated, or failed validation, or spec changed)."""
    path = DATA / kind / f"{item.id}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["text"] if data.get("hash") == f"{GEN_VERSION}:{item.text_hash()}" else None


