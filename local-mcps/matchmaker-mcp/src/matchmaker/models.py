from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class LLMModel(BaseModel):
    """Base for models filled by the LLM. Strict JSON schema mode needs additionalProperties=false."""

    model_config = ConfigDict(extra="forbid")


Relocation = Literal["yes", "likely", "unlikely", "no"]
Answer = Literal["yes", "maybe", "no"]


# ---- filled by the model ----


class Profile(LLMModel):
    name: str | None
    email: str | None
    phone: str | None
    headline: str = Field(description="Current role and focus in at most 12 words, e.g. 'Backend engineer, Python "
                                      "and AWS, payments'")
    current_title: str | None
    seniority: Literal["intern", "junior", "mid", "senior", "lead", "manager", "director", "executive"] | None
    location: str | None = Field(description="Where they are based: city, region, country as far as known")
    open_to_relocate: Relocation = Field(description="See the instructions: 'no' only when they say so")
    relocation_note: str | None = Field(description="One short reason for the value, e.g. 'says open to relocation', "
                                                    "'moved twice for work', 'no statement'")
    work_mode: str | None = Field(description="Remote, hybrid or on-site preference, only if they state one")
    years_experience: float | None = Field(description="Total professional years, generous estimate, see rules")
    work_authorization: str | None = Field(description="As stated, or a hedged guess ('likely US, US education and "
                                                       "roles'); null if nothing to go on")
    notice_period: str | None = Field(description="As stated, e.g. '30 days', 'immediate'; null if not stated")
    languages: list[str]
    education: str | None = Field(description="Highest degree and field, school, year, in one line")
    industries: list[str] = Field(description="Domains they worked in: 'Fintech', 'Healthcare', 'Retail'")
    skills: list[str] = Field(description="10-30 skills, tools and domains under their common names, strongest "
                                          "first, including ones the work clearly implies")
    summary: str = Field(description="3-5 sentences, factual: what they do, at what level, in which domain, notable "
                                     "results")
    notes: list[str] = Field(description="Every fact from the admin's notes, short, newest wording; [] without notes")


class JobCore(LLMModel):
    role_type: str = Field(description="The kind of role in a few words: 'ML platform engineer', 'Staff accountant'")
    core_work: str = Field(description="1-2 sentences: the work this person does every day, not the tools")
    must_haves: list[str] = Field(description="3-6 things a candidate cannot do the job without, each short")
    years_needed: float | None = Field(description="Years of experience the posting asks for; null if it does not say")


class MustHaveCheck(LLMModel):
    must_have: str
    evidence: str = Field(description="The fact from their documents that shows it, in a few words; 'none' if none")
    answer: Answer


class CandidateCheck(LLMModel):
    id: str
    candidate_role_type: str = Field(description="The kind of role this candidate's own work is, in a few words")
    core_work_evidence: str = Field(description="The roles and facts that show the core work, in a few words; "
                                                "'none' if none")
    core_work: Answer = Field(description="Has their actual work been the job's core work?")
    core_work_years: float = Field(description="Years they spent doing the core work; 0 if none")
    same_role_type: Answer
    latest_role_core: Answer = Field(description="Is their latest role the job's core work?")
    level_fit: Answer = Field(description="Is their seniority right for the job?")
    must_haves: list[MustHaveCheck] = Field(description="Every must-have, in the order given")
    reason: str = Field(description="One sentence")


class Checks(LLMModel):
    candidates: list[CandidateCheck]


# ---- results ----


class PersonResult(BaseModel):
    status: Literal["created", "updated", "unchanged"]
    person_id: str
    name: str | None
    headline: str
    folder: str = Field(description="The person's folder: originals, their text, profile.md")


class Person(BaseModel):
    person_id: str
    name: str | None
    email: str | None
    phone: str | None
    documents: list[str] = Field(description="Kinds on file: resume, cover_letter, notes")
    profile: str = Field(description="profile.md: the facts recruiters check, skills and summary")
    folder: str


class JobResult(BaseModel):
    job_id: str
    title: str


class Candidate(BaseModel):
    position: int
    person_id: str
    name: str | None
    keyword_rank: int | None = Field(description="Place on words alone (BM25); null when no query word appears")
    meaning_rank: int = Field(description="Place on meaning alone (embeddings)")
    profile: str
    duplicates: list[str] = Field(default_factory=list,
                                  description="Other person ids filed for the same person, not listed again")


class Page(BaseModel):
    query: str
    total: int = Field(description="Everyone in the pool, in ranked order, each person once")
    offset: int
    candidates: list[Candidate]
    next_offset: int | None = Field(description="Pass to get the next page; null on the last page")


class JudgedCandidate(Candidate):
    score: float | None = Field(description="0-100: the checks (85%) and the search place (15%); null if the judge "
                                            "gave no answer for them")
    check_score: float | None = Field(None, description="0-100 from the judge's answers alone")
    search_score: float | None = Field(None, description="0-100 from the place in the whole ranked pool")
    candidate_role_type: str | None = None
    same_role_type: Answer | None = None
    core_work: Answer | None = None
    core_work_years: float | None = None
    latest_role_core: Answer | None = None
    level_fit: Answer | None = None
    must_haves: dict[str, Answer] = Field(default_factory=dict)
    evidence: dict[str, str] = Field(default_factory=dict, description="Per check, what the judge based it on")
    reason: str | None = None


class JudgedPage(BaseModel):
    job_id: str
    role_type: str
    core_work: str
    must_haves: list[str]
    total: int
    offset: int
    candidates: list[JudgedCandidate] = Field(description="This page, best score first; ties by name")
    next_offset: int | None
