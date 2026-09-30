# Build Spec: Recruiter Matching MCP Server

Original build spec, with the decisions made during the build recorded in "Overrides" at the top. Where they conflict, Overrides win.

## Overrides (decided 2026-09-29)

- Personal, self-hosted MCP on the user's machine. No S3/MinIO. Original files on local disk under `DATA_DIR/resumes/{candidate_id}/{sha256}.{ext}`. Docker runs only Postgres + pgvector. No presigned URLs; `get_candidate` returns the embedded resource plus the local path.
- The assistant's own model reads/OCRs the PDF (validated against the OpenRouter catalog: 182/460 models take PDFs natively, ~$0.002–0.02 per resume). `ingest_resume` takes `resume_text` (verbatim transcript) plus an optional original file (`file_path` or `file_base64`). No server-side PDF/DOCX parsing in ingest, no `needs_ocr`.
- The server still runs its own structured extraction on the text, so profiles are consistent regardless of the assistant model.
- Dedup hash is `content_sha256`: sha256 of the original file if sent, else of the normalized text.
- Bulk backfill (M6) sends every file to a vision model (`VISION_MODEL`); no local text-layer path.
- LLM and embeddings both via OpenRouter (OpenAI-compatible API). Defaults: `openai/gpt-5-mini` (LLM), `openai/text-embedding-3-small` 1536-dim (embeddings).
- mcp Python SDK 2.x: `FastMCP` is renamed `MCPServer` (`mcp.server.mcpserver`).
- Prompt caching via OpenRouter: automatic for OpenAI/Gemini models; Anthropic models need explicit `cache_control` breakpoints.

## Overrides (decided 2026-09-30)

These supersede the 2026-09-29 entries above where they conflict.

- PDF only. Every other file type is rejected. Files are never sent back to the client: the `resume://` resource and embedded file content are removed, and `get_candidate` returns `resume_file.path` (the stored copy) for the assistant to hand to the user. `ingest_resume` accepts the PDF as `upload_id` (the agent app POSTs the attachment to `/uploads`; a model cannot emit file bytes), or an absolute `file_path`. No base64 tool field: models fabricate PDF bytes to fill it.
- Bulk ingest uses a server-owned inbox (`INBOX_DIR`, default `DATA_DIR/inbox`). The agent calls `get_bulk_ingest_folder`, tells the user to put PDFs there and confirm, then calls `ingest_folder` (no path argument) and polls `get_folder_ingest_status`. The agent never asks the user for a folder path. The server transcribes PDFs with `VISION_MODEL` in a background run. Already-ingested files are skipped by path + size + mtime (`source_files` table) without being read, then by content hash. The JSONL state file is gone.
- Runs on macOS, Linux and Windows.
- Over HTTP, `X-OpenRouter-Api-Key` and the tool's `X-Cost-Approved-{Resume-Ingestion,Job-Match,Search,Folder-Ingestion}` header are required on every paid tool call (`missing_header` otherwise; no `.env` fallback). On stdio the key comes from `.env` and caps are optional (`COST_APPROVED_*`). Over-cap calls are refused before spending (estimate from recent `usage`) or stopped once actual spend reaches the cap. OpenRouter 401/402/403/429 map to `invalid_api_key`, `insufficient_credits`, `key_forbidden`, `rate_limited`.

---

## 1. What you're building

An MCP server that gives a recruiter AI assistant three core abilities:

1. Ingest a resume: store the original, parse it into structured data once, and index it for matching.
2. Match a job: given a job description, return the 10 best candidates from everyone ingested so far, each with reasons.
3. Get a candidate: return a candidate's parsed profile and original resume file.

The recruiter talks to their own AI assistant (separate app). That assistant calls this server's tools. The server holds all data and logic, has no chat UI, and is not an agent.

Scale: 100–200 resumes/day ingested, 20–30 jobs/day matched, corpus growing to tens of thousands.

## 2. Core design decisions

- **Parse once, match many.** All job-independent work happens at ingestion: LLM structured extraction, skill normalization, embedding. Matching never re-reads resumes.
- **No ranking at ingestion.** A rank only makes sense relative to a job. Ingestion produces fields and embeddings; ranking happens at match time.
- **Match is a funnel:**
  1. LLM parses the JD into structured requirements.
  2. SQL hard filters (experience range, location/remote, freshness; optional must-have skill overlap).
  3. pgvector similarity search → top ~50.
  4. LLM rerank of those ~50 in parallel with a fixed rubric → sorted → top N (default 10).
- **Deterministic code does the math.** `years_exp` is computed from parsed role dates in code, not asked of the LLM.
- **Store the raw LLM extraction JSON** so fields can be re-derived without re-parsing.

## 4.2 `match_job`

Input:
```json
{
  "jd_text": "full job description",
  "title": "optional",
  "limit": 10,
  "filters": {
    "locations": ["Mumbai", "Pune"],
    "remote_ok": true,
    "min_years": 3,
    "max_years": 8,
    "max_notice_days": 60,
    "max_resume_age_days": 180
  }
}
```
`filters` is optional. Anything not given explicitly is taken from the parsed JD. Explicit filters override parsed ones.

Behavior: the funnel from §2. Save the job and all scored matches. Rerank runs concurrently (semaphore, default 10), with the JD in a stable prompt prefix so provider prompt caching applies.

Output:
```json
{
  "job_id": "uuid",
  "parsed_requirements": { "...": "JobRequirements" },
  "funnel": { "total": 5230, "after_filters": 412, "reranked": 50 },
  "candidates": [
    {
      "rank": 1, "candidate_id": "uuid", "name": "Priya Sharma", "score": 88,
      "one_line_pitch": "6 yrs Python/AWS backend, led payments migration",
      "must_haves_met": ["Python", "AWS", "REST APIs"], "must_haves_missing": [],
      "concerns": ["90-day notice"], "location": "Pune", "years_exp": 6.2
    }
  ]
}
```
If fewer than `limit` pass the filters, return what exists and say so in a `note`. Don't pad with poor fits.

Supporting: `search_candidates(query, filters, limit=20)` (free text + filters, no JD), `record_feedback(job_id, candidate_id, label ∈ {shortlisted, rejected, interviewed, placed}, note?)` (the eval dataset), `get_job` / `list_jobs`, `delete_candidate`.

## 5. Schema (as implemented in `migrations/001_init.sql`)

`candidates` (name, email, phone, location, years_exp, notice_days, skills text[] normalized, profile jsonb, raw_extraction jsonb, summary, resume_text, embedding vector(DIM), content_sha256, file_key, updated_at, ...), HNSW index on embedding (cosine), GIN on skills, trigram on name. `jobs` (requirements jsonb, filters, funnel, embedding). `matches` (job_id, candidate_id, score, rank, result jsonb, feedback_label, feedback_note). `skill_synonyms(alias, canonical)`. `usage` (token logging).

Skill normalization: lowercase + strip punctuation → look up alias → fall back to title-cased original.

## 6. Models

```python
class Role(BaseModel):
    title: str; company: str | None
    start: str | None   # "YYYY-MM"
    end: str | None     # "YYYY-MM", "present", or null
    highlights: list[str]

class CandidateProfile(BaseModel):
    name, email, phone, location, current_title: str | None
    roles: list[Role]; skills, education, certifications, industries, languages: list[str]
    notice_period_days: int | None; current_ctc, expected_ctc: str | None
    summary: str

class JobRequirements(BaseModel):
    title: str; must_have_skills: list[str]; nice_to_have_skills: list[str]
    min_years: float | None; max_years: float | None
    locations: list[str]; remote_ok: bool; industries: list[str]
    dealbreakers: list[str]; summary: str

class CandidateScore(BaseModel):
    score: int  # 0-100
    must_haves_met: list[str]; must_haves_missing: list[str]
    concerns: list[str]; one_line_pitch: str
```

`years_exp` in code: merge overlapping role date ranges, sum months, "present" = today. No dates → null (null passes filters but is flagged in concerns).

Embedding text: `current_title + summary + skills + last 3 role titles/companies/highlights`. Jobs: `title + summary + must_haves + nice_to_haves`.

## 7.2 JD parsing prompt

```
You extract hiring requirements from a job description. Output JSON only.
- must_have_skills: only skills stated as required/mandatory/must. Be strict.
- nice_to_have_skills: preferred/plus/bonus.
- Years: "5+ years" → min 5, max null. "3-6 years" → 3, 6.
- remote_ok true only if remote/hybrid is explicitly allowed.
- dealbreakers: explicit hard constraints (clearance, specific degree, language).
<jd>{jd_text}</jd>
```

## 7.3 Rerank scoring prompt

JD + rubric is the stable prefix; candidate profile comes last (prompt caching).
```
You are screening candidates for a recruiter. Score how well the candidate fits this job.
<job>{requirements_json}</job>
Rubric (total 100):
- Must-have skills coverage: 40 (proportional; evidence in roles counts more than a skills list)
- Relevant experience (years in range, similar titles/domain): 25
- Recency and depth of relevant work: 15
- Nice-to-haves and industry match: 10
- Logistics (location, notice period, dealbreakers): 10
Any dealbreaker violated → cap score at 30 and list it in concerns.
Rules:
- Judge only on the profile. Ignore name, gender, age, photo, marital status, religion, nationality.
- must_haves_met only if there is evidence in the profile.
- one_line_pitch: ≤20 words, factual.
- concerns: gaps or risks a recruiter should check. Empty if none.
<candidate>{profile_json_without_name_email_phone}</candidate>
```
Name/email/phone are stripped before scoring and re-attached by candidate_id.

## 9. Non-functional

Bearer auth on HTTP. Never log resume text or contact details. Idempotent re-ingest. Targets: ingest < 20s, `match_job` < 45s for a 50-candidate rerank, vector+filter query < 200 ms at 50k candidates. LLM calls: timeouts + 2 retries with backoff; one failed rerank drops that candidate, not the match. Token usage logged per tool call.

## 10. Milestones

1. Skeleton (done). 2. Ingest. 3. Match (`match_job`, `get_job`, `list_jobs`). 4. Supporting tools, auth, usage logging. 5. Eval script: recall@10 on 5 fixture JDs, latency, cost; reads `record_feedback` labels. 6. Bulk backfill CLI.

Definition of done includes `eval.py` recall@10 ≥ 0.8 on fixtures. Out of scope v1: OCR on server, UI, multi-tenant, ATS integrations, inbox polling, fine-tuning/learned ranking.
