from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class LLMModel(BaseModel):
    """Base for models filled by the LLM. Strict JSON schema mode needs additionalProperties=false."""

    model_config = ConfigDict(extra="forbid")


class Role(LLMModel):
    title: str
    company: str | None
    start: str | None = Field(description='"YYYY-MM", "YYYY" if only the year is known, or null')
    end: str | None = Field(description='"YYYY-MM", "YYYY" if only the year is known, "present", or null')
    highlights: list[str] = Field(description="max 5, short")


class CandidateProfile(LLMModel):
    name: str | None
    email: str | None
    phone: str | None
    location: str | None
    current_title: str | None
    roles: list[Role]
    skills: list[str]
    education: list[str]
    certifications: list[str]
    industries: list[str]
    notice_period_days: int | None
    current_ctc: str | None
    expected_ctc: str | None
    languages: list[str]
    summary: str = Field(description="2-3 sentences, factual, no praise")


class JobRequirements(LLMModel):
    title: str
    must_have_skills: list[str]
    nice_to_have_skills: list[str]
    min_years: float | None
    max_years: float | None
    locations: list[str]
    remote_ok: bool
    industries: list[str]
    dealbreakers: list[str]
    summary: str


class CandidateScore(LLMModel):
    """Evidence first, then points per rubric line. The total is computed in code (see `total`)."""

    must_haves_met: list[str]
    must_haves_missing: list[str]
    concerns: list[str]
    one_line_pitch: str
    must_have_points: int = Field(description="0-40")
    experience_points: int = Field(description="0-25")
    recency_points: int = Field(description="0-15")
    nice_to_have_points: int = Field(description="0-10")
    logistics_points: int = Field(description="0-10")
    dealbreaker_violated: bool

    def breakdown(self) -> "ScoreBreakdown":
        clamp = lambda v, hi: max(0, min(hi, v))  # noqa: E731
        return ScoreBreakdown(
            must_haves=clamp(self.must_have_points, 40),
            experience=clamp(self.experience_points, 25),
            recency=clamp(self.recency_points, 15),
            nice_to_haves=clamp(self.nice_to_have_points, 10),
            logistics=clamp(self.logistics_points, 10),
            dealbreaker_violated=self.dealbreaker_violated,
        )


class ScoreBreakdown(BaseModel):
    must_haves: int
    experience: int
    recency: int
    nice_to_haves: int
    logistics: int
    dealbreaker_violated: bool

    @property
    def total(self) -> int:
        t = self.must_haves + self.experience + self.recency + self.nice_to_haves + self.logistics
        return min(t, 30) if self.dealbreaker_violated else t


# ---- tool I/O ----

Source = Literal["email", "upload", "ats", "other"]


class IngestResult(BaseModel):
    status: Literal["created", "updated", "duplicate_file"]
    candidate_id: str
    name: str | None
    headline: str
    location: str | None
    years_exp: float | None
    top_skills: list[str]
    notice_days: int | None
    warnings: list[str] = []


class ResumeFileInfo(BaseModel):
    path: str = Field(description="Absolute path to the stored PDF on this computer; open or attach it from here")
    mime_type: str
    size_bytes: int


class CandidateMatchRef(BaseModel):
    candidate_id: str
    name: str | None
    email: str | None
    location: str | None
    current_title: str | None
    years_exp: float | None


class CandidateDetail(BaseModel):
    candidate_id: str
    name: str | None
    email: str | None
    phone: str | None
    location: str | None
    headline: str
    years_exp: float | None
    notice_days: int | None
    skills: list[str]
    source: str | None
    notes: str | None
    created_at: str
    updated_at: str
    profile: CandidateProfile
    resume_file: ResumeFileInfo | None = Field(
        description="Stored original PDF, if one was given at ingest"
    )


class FolderFileOutcome(BaseModel):
    path: str
    status: str
    candidate_id: str | None = None
    error: str | None = None


class BulkInboxInfo(BaseModel):
    folder: str = Field(description="Absolute path of the bulk inbox on the server's machine")
    pdf_files: int
    already_ingested: int = Field(description="Unchanged since a previous run; not read again")
    gave_up: int
    to_process: int
    estimated_cost_usd: float
    message_for_user: str = Field(description="Tell the user this, in your own words")


class IngestFolderResult(BaseModel):
    status: Literal["started", "up_to_date", "no_pdfs"]
    folder: str
    run_id: str | None = Field(default=None, description="Pass to get_folder_ingest_status to follow progress")
    pdf_files: int
    already_ingested: int = Field(description="Unchanged since a previous run; not read again")
    gave_up: int = Field(description="Failed max attempts on earlier runs and unchanged since; not retried")
    to_process: int
    estimated_cost_usd: float
    approved_usd: float | None = Field(default=None, description="Spend cap for this run, if one was set")


class FolderIngestStatus(BaseModel):
    run_id: str
    folder: str
    state: Literal["running", "finished", "stopped", "crashed"]
    stopped_reason: str | None = Field(
        default=None,
        description="Why the run ended early (bad API key, out of credits, spend cap). Tell the user; files not "
        "reached are picked up by the next ingest_folder call",
    )
    started_at: str
    finished_at: str | None
    pdf_files: int
    to_process: int
    processed: int
    counts: dict[str, int] = Field(
        description="created, updated, duplicate_file, unchanged, gave_up, failed, stopped (not reached)"
    )
    cost_usd: float
    failures: list[FolderFileOutcome] = Field(
        default=[], description="Failed or given-up files. Calling ingest_folder again retries failures"
    )


class ResumeFileResult(BaseModel):
    status: Literal["found", "no_file", "ambiguous", "not_found"]
    candidate_id: str | None = None
    name: str | None = None
    path: str | None = Field(default=None, description="Absolute path of the stored PDF on the server's machine")
    message_for_user: str = Field(description="Reply with this; include the full path exactly as given")
    matches: list[CandidateMatchRef] = Field(
        default=[], description="When ambiguous: call get_resume_file again with one candidate_id"
    )


class GetCandidateResult(BaseModel):
    status: Literal["found", "ambiguous", "not_found"]
    candidate: CandidateDetail | None = None
    matches: list[CandidateMatchRef] = Field(
        default=[], description="When ambiguous: call get_candidate again with one candidate_id"
    )


class MatchFilters(BaseModel):
    """Hard filters. Anything unset is taken from the parsed JD; anything set here wins."""

    locations: list[str] | None = Field(default=None, description="Accepted cities; metro areas are expanded")
    remote_ok: bool | None = Field(default=None, description="If true, location is not filtered")
    min_years: float | None = None
    max_years: float | None = None
    max_notice_days: int | None = None
    max_resume_age_days: int | None = Field(default=None, description="Only resumes ingested/updated this recently")
    min_must_have_skills: int | None = Field(
        default=None, description="Require at least this many JD must-have skills in the candidate's skill list"
    )


class AppliedFilters(BaseModel):
    """The filters actually used, after merging explicit filters over the parsed JD."""

    location_keys: list[str]
    remote_ok: bool
    min_years: float | None
    max_years: float | None
    max_notice_days: int | None
    max_resume_age_days: int | None
    must_have_skills: list[str]
    min_must_have_skills: int | None


class Funnel(BaseModel):
    total: int
    after_filters: int
    reranked: int
    rerank_failed: int = 0
    rescored: int = Field(default=0, description="Borderline candidates scored twice and averaged")


class MatchCandidate(BaseModel):
    rank: int
    candidate_id: str
    name: str | None
    score: int
    one_line_pitch: str
    must_haves_met: list[str]
    must_haves_missing: list[str]
    concerns: list[str]
    location: str | None
    years_exp: float | None
    notice_days: int | None
    score_breakdown: ScoreBreakdown
    feedback_label: str | None = None


class MatchStats(BaseModel):
    latency_ms: int
    llm_calls: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cost_usd: float | None


class MatchResult(BaseModel):
    job_id: str
    title: str
    created_at: str
    parsed_requirements: JobRequirements
    applied_filters: AppliedFilters
    funnel: Funnel
    candidates: list[MatchCandidate]
    note: str | None = None
    stats: MatchStats | None = None


class JobSummary(BaseModel):
    job_id: str
    title: str
    created_at: str
    funnel: Funnel
    top_candidates: list[str] = Field(description="Names of the top 3")
    feedback_count: int


class ListJobsResult(BaseModel):
    jobs: list[JobSummary]


class SearchFilters(BaseModel):
    locations: list[str] | None = Field(default=None, description="Cities; metro areas are expanded")
    include_remote: bool = Field(default=True, description="With locations set, also include 'Remote' candidates")
    min_years: float | None = None
    max_years: float | None = None
    max_notice_days: int | None = None
    max_resume_age_days: int | None = None
    skills: list[str] | None = Field(default=None, description="Candidates must have ALL of these skills")


class SearchHit(BaseModel):
    candidate_id: str
    name: str | None
    headline: str
    location: str | None
    years_exp: float | None
    notice_days: int | None
    top_skills: list[str]
    matched_skills: list[str] = Field(description="Skills named in the query that this candidate has")
    similarity: float | None = Field(description="Cosine similarity to the query text, 0-1; null without a query")
    updated_at: str


class SearchResult(BaseModel):
    query_skills: list[str] = Field(description="Skills recognised in the query text; used to rank")
    total_matching: int = Field(description="Candidates passing the filters")
    candidates: list[SearchHit]


FeedbackLabel = Literal["shortlisted", "rejected", "interviewed", "placed"]


class FeedbackResult(BaseModel):
    job_id: str
    candidate_id: str
    label: FeedbackLabel
    previous_label: str | None
    in_match_results: bool = Field(description="False if the candidate was not among this job's scored matches")


class DeleteResult(BaseModel):
    candidate_id: str
    deleted: bool
    versions_deleted: int
    matches_deleted: int
    files_deleted: int
