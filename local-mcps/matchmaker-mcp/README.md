# recruiter-mcp

Self-hosted MCP server for a recruiter's AI assistant: ingest resumes, match job descriptions, fetch candidates.
Runs on your machine (macOS, Linux or Windows). Postgres + pgvector in Docker; original resume PDFs on local disk
under `DATA_DIR`. LLM and embedding calls go through OpenRouter. Files never travel over MCP: tools take and return
absolute paths on this machine (a resume PDF can also be uploaded with `ingest_resume`).

## Setup

```sh
cp .env.example .env          # set MCP_AUTH_TOKEN; LLM_API_KEY/EMBED_API_KEY only for stdio (Windows: copy)
docker compose up -d          # Postgres 16 + pgvector on 127.0.0.1:5432
uv sync
uv run recruiter-mcp-migrate  # applies migrations/*.sql (the server also applies pending ones on start)
```

Requirements: [uv](https://docs.astral.sh/uv/) and Docker (Docker Desktop on macOS/Windows, Docker Engine + compose
plugin on Linux). The commands are the same on every platform. Paths may be given in the platform's own form
(`/home/me/cv.pdf`, `C:\Users\me\cv.pdf`, `~/cv.pdf`); surrounding quotes are ignored. `LLM_API_KEY` and
`EMBED_API_KEY` are needed only for stdio; over HTTP each client sends its own key (see below). Client setup for
Claude and any other MCP agent: [docs/usage-guide.md](docs/usage-guide.md#connect-an-assistant).

## Run

stdio (local clients, MCP Inspector):

```sh
uv run recruiter-mcp
npx @modelcontextprotocol/inspector uv run recruiter-mcp
```

Streamable HTTP (requires `MCP_AUTH_TOKEN`):

```sh
MCP_TRANSPORT=http uv run recruiter-mcp
# endpoint: http://127.0.0.1:8000/mcp   header: Authorization: Bearer $MCP_AUTH_TOKEN
# health:   GET /healthz (no auth)
```

### API key and spend caps (required headers over HTTP)

| Header | Effect |
|---|---|
| `X-OpenRouter-Api-Key` | OpenRouter key for this request's LLM, embedding and vision calls |
| `X-Cost-Approved-Resume-Ingestion` | Max USD for one `ingest_resume` call |
| `X-Cost-Approved-Job-Match` | Max USD for one `match_job` call |
| `X-Cost-Approved-Search` | Max USD for one `search_candidates` call |
| `X-Cost-Approved-Folder-Ingestion` | Max USD for a whole `ingest_folder` run |

Values are US dollars (`0.05` or `$0.05`; `0` blocks the tool). Over HTTP, a paid tool call must carry
`X-OpenRouter-Api-Key` and its own cost header, or it fails with `missing_header`; `.env` keys and caps are not
used as a fallback. Tools that make no model call need only `Authorization`. On stdio there are no headers: the key
comes from `LLM_API_KEY` / `EMBED_API_KEY`, and caps are optional via `COST_APPROVED_RESUME_INGESTION`,
`COST_APPROVED_JOB_MATCH`, `COST_APPROVED_SEARCH`, `COST_APPROVED_FOLDER_INGESTION`.

A capped call is checked twice:

1. Before any model call, its cost is estimated from the average actual cost of the last 20 calls of that tool (the
   `usage` table), or a default if there is no history ($0.002 per resume, $0.03 per match, $0.0035 per folder
   file). If the estimate is over the cap, the call fails with `cost_limit_exceeded` and a message such as
   `resume ingestion not started: estimated cost $0.0050, average of the last 20 runs, exceeds the $0.0005 approved`.
   Nothing is spent. `ingest_resume` checks after the duplicate lookup, so re-sending a known file is never refused.
2. While running, actual spend is added up; once it reaches the cap, no further model call starts and the call fails
   with `cost_limit_exceeded` (`... stopped: spent $0.0051 of the $0.0050 approved`). Calls already in flight finish,
   so spend can pass the cap by at most one call (or `RERANK_CONCURRENCY` calls during a match).

OpenRouter errors are returned with a reason the assistant can pass on: `invalid_api_key` (401), `insufficient_credits`
(402: account or key out of credit, with OpenRouter's own message), `key_forbidden` (403), `rate_limited` (429),
`llm_unavailable` (5xx, timeout, no network).

Smoke test both transports: `uv run python scripts/smoke.py both` (start the HTTP server first).

## How ingestion works

Only PDF resumes are accepted. For a single resume, the assistant reads it itself and sends a verbatim transcript in
`resume_text`, plus the original PDF: an `upload_id` (the agent app uploaded a chat attachment to `/uploads`) or,
for a file on the server's machine, its absolute `file_path`. For many files, see the bulk inbox. The server then:

1. Hashes the original file (or the normalized text if no file) and returns `duplicate_file` if it has seen it.
2. Extracts a `CandidateProfile` with its own prompt (`prompts/extract_resume.md`) and model, validated by Pydantic.
3. Normalizes skills via `skill_synonyms` (seeded from `seeds/skill_synonyms.csv`), computes `years_exp` from role
   dates in code, and embeds title + summary + skills + recent roles.
4. Matches the person by email, then by the last 10 digits of their phone. A match updates the candidate and keeps
   the previous version in `candidate_versions`.
5. Copies the PDF to `DATA_DIR/resumes/{candidate_id}/{Name}_Resume_{first 8 of sha256}.pdf` (e.g.
   `Priya_Sharma_Resume_3f0c9a1b.pdf`), so it survives the original being moved.

Day-to-day use and client setup: [docs/usage-guide.md](docs/usage-guide.md). Matching design: [docs/how-matching-works.md](docs/how-matching-works.md). Full spec: [docs/spec.md](docs/spec.md).

## Tools

### `ingest_resume`

```json
{
  "resume_text": "PRIYA SHARMA\nSenior Backend Engineer\npriya.sharma@example.com | +91 98765 43210 | Pune\n...",
  "file_path": "/Users/me/Downloads/priya_sharma_cv.pdf",
  "source": "email",
  "notes": "referred by Amit"
}
```

The original PDF is optional, max 10 MB, passed one of two ways:

- `upload_id` (chat attachments): the model passes the app's `attachment:<id>` reference; when it calls
  this tool, the agent *app* uploads the attachment with `POST /uploads` and swaps in the returned `upload_id`.
- `file_path`: absolute path to a `.pdf` on the machine running the server.

There is deliberately no base64 field. A model can read an attached PDF but cannot reproduce its bytes; offered a
base64 field, models write a small fake PDF instead, which is stored and never opens. Programmatic clients upload
through `/uploads` too.

### `POST /uploads` (HTTP only)

```sh
curl -X POST https://<host>/uploads -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/pdf" --data-binary @resume.pdf
# {"upload_id": "2fe904d4…", "size_bytes": 184233}
```

Raw PDF bytes in, `upload_id` (the file's sha256) out. Same bearer auth as `/mcp`; max `MAX_FILE_BYTES`; non-PDFs get
400 `invalid_input`. The upload is kept under `DATA_DIR/uploads/` until `ingest_resume` claims it, then deleted
(the PDF is stored under `resumes/`). Uploading the same file twice returns the same id.

Other file types are rejected with `unsupported_file_type`. Returns:

```json
{
  "status": "created",
  "candidate_id": "3f0c...",
  "name": "Priya Sharma",
  "headline": "Senior Backend Engineer, 7.7 yrs, Python/Django/AWS",
  "location": "Pune",
  "years_exp": 7.7,
  "top_skills": ["Python", "Django", "AWS", "AWS Lambda", "PostgreSQL"],
  "notice_days": 30,
  "warnings": []
}
```

`status` is `created`, `updated` (same person by email/phone; old version kept) or `duplicate_file`.

### `get_candidate`

`{"candidate_id": "3f0c..."}` or `{"query": "Priya Sharma"}` (name or email). Returns `status` `found`, `ambiguous`
(with `matches` to choose from) or `not_found`. A found candidate includes the full profile and `resume_file`
(absolute path of the stored PDF, mime type, size). The file itself is never sent; when the recruiter asks for a
resume, the assistant gives them the path. Candidates ingested without a file have no `resume_file`.

### `get_resume_file`

`{"query": "Priya Sharma"}` or `{"candidate_id": "..."}`. For "get me the resume of X". Returns `status` (`found`,
`no_file`, `ambiguous`, `not_found`), `path` (absolute path of the stored PDF) and `message_for_user`, e.g.
"Priya Sharma's resume is stored on your computer at: /…/data/resumes/3f0c…/9a1b….pdf". No profile data, so the
agent answers with the location instead of summarising the candidate. The file itself is never sent.

### Bulk ingest: `get_bulk_ingest_folder` then `ingest_folder`

The server owns one inbox folder, `INBOX_DIR` (default `DATA_DIR/inbox`, created at startup). The user never has to
say where their files are:

1. The agent calls `get_bulk_ingest_folder` (free, read-only). It returns the inbox's absolute path, `pdf_files`,
   `already_ingested`, `gave_up`, `to_process`, `estimated_cost_usd` and a `message_for_user`: "Put the PDF resumes
   you want to add in `/…/data/inbox` (subfolders are fine; other file types are ignored), then tell me to go
   ahead and I'll process them."
2. The user copies the PDFs in and confirms.
3. The agent calls `ingest_folder {"source": "other"}` (no path argument) and polls `get_folder_ingest_status`.

`ingest_folder` ingests every `.pdf` in the inbox, subfolders included, hidden files skipped. The server reads and
transcribes the PDFs itself with `VISION_MODEL`, so the agent does not open them. Files can stay in the inbox
afterwards. Per file, cheapest check first:

1. Same path, size and modification time as an earlier successful run (`source_files` table): skipped without
   reading the file. A re-run over 10,000 already-ingested files is one query plus one `stat` per file.
2. Same bytes already in the database (renamed or copied file, or ingested one-by-one earlier): skipped after
   hashing, before any model call.
3. Otherwise: transcribe, then the normal ingest pipeline with the PDF attached.

Returns at once with `status` (`started`, `up_to_date`, `no_pdfs`), `run_id`, `folder`, `pdf_files`,
`already_ingested`, `gave_up`, `to_process`, `estimated_cost_usd` and `approved_usd`. The run continues in the
background (`FOLDER_CONCURRENCY` files at once, default 4). Only one run at a time; a second call while one is
running fails with `already_running`. Failed files are retried on the next call, up to `FOLDER_MAX_ATTEMPTS` (3);
a file that changes on disk starts over. A bad key, no credits or a reached spend cap stops the run without
counting against any file, and the next call picks up the rest.

### `get_folder_ingest_status`

`{"run_id": "..."}` (omit for the latest run). Returns `state` (`running`, `finished`, `stopped`, `crashed`),
`stopped_reason`, `processed` of `to_process`, `counts` by outcome (`created`, `updated`, `duplicate_file`,
`unchanged`, `gave_up`, `failed`, `stopped`), `cost_usd`, and `failures` with paths and reasons. Run state lives in
memory; per-file outcomes persist in `source_files`.

### `match_job`

```json
{
  "jd_text": "Senior Backend Engineer ... 5-8 years ... Python, AWS required ... Pune, remote OK",
  "limit": 10,
  "filters": {"max_notice_days": 60, "locations": ["Pune", "Mumbai"]}
}
```

The funnel:

1. The LLM parses the JD into `JobRequirements` (`prompts/parse_job.md`). Skills are normalized like resume skills.
   Examples in a requirement ("Python (Django, Flask or FastAPI)") become nice-to-haves under one must-have
   ("Python"); alternatives with no umbrella term stay one requirement ("Tally or SAP"), met by either.
2. Filters are merged: anything in `filters` wins field by field; the rest comes from the JD. Years parsed from the JD
   get slack (`YEARS_SLACK_BELOW`/`ABOVE`, default -1/+2, so "5-8 yrs" admits 4-10); explicit years are exact.
   Locations expand to metro areas (Mumbai includes Thane and Navi Mumbai). `remote_ok` skips the location filter.
   Unknown values (no dates, no location, no notice period) pass every filter.
3. SQL hard filters, then cosine similarity against the job embedding picks `RERANK_POOL_SIZE` (50) candidates.
   Up to 20k filtered rows this is an exact scan; above that HNSW with iterative scan.
4. The LLM scores each candidate in parallel (`RERANK_CONCURRENCY`) against the rubric in
   `prompts/score_candidate.md`, with name, email and phone removed. It returns five sub-scores; code sums them
   (40/25/15/10/10) and caps the total at 30 if a dealbreaker is violated. A failed call drops that one candidate.
   Candidates within `RERANK_BORDERLINE_MARGIN` (8) points of a cutoff (`MIN_MATCH_SCORE`, or the gap between
   rank `limit` and the next) are scored a second time and the two runs averaged; `funnel.rescored` counts them.
   A dealbreaker counts only if both runs agree; otherwise it becomes a concern. `must_haves_met`/`missing` are
   mapped back to the job's skill names in code.
5. Sorted by score, then must-haves met, then similarity. Candidates below `MIN_MATCH_SCORE` (35) are left out
   instead of padding the list, and `note` says so. The job and every scored candidate are saved.

Returns `job_id`, `parsed_requirements`, `applied_filters`, `funnel` (`total`, `after_filters`, `reranked`,
`rerank_failed`), `candidates` (rank, score, `score_breakdown`, pitch, must-haves met/missing, concerns, location,
years, notice), `note`, and `stats` (latency, tokens, cost).

Filter fields: `locations`, `remote_ok`, `min_years`, `max_years`, `max_notice_days`, `max_resume_age_days`,
`min_must_have_skills` (require at least N of the JD's must-have skills in the candidate's skill list; off by default).

### `get_job` / `list_jobs`

`get_job {"job_id": "...", "limit": 10, "include_low_scores": false}` reopens a saved match without LLM calls, with
current candidate details and any feedback labels. `list_jobs {"limit": 20}` lists recent runs with their top 3.

### `search_candidates`

```json
{"query": "Python backend developers", "filters": {"locations": ["Pune"], "max_notice_days": 30}, "limit": 20}
```

No JD and no LLM call, so it is fast and nearly free. `query` is embedded and ranked by similarity; skills named in
it (recognised via `skill_synonyms`, e.g. "k8s") rank first. `filters`: `locations` (metro-expanded),
`include_remote` (default true), `min_years`, `max_years`, `max_notice_days`, `max_resume_age_days`, `skills`
(candidate must have all). Without a query, returns the most recently updated matches. Each hit has headline, top
skills, `matched_skills` and `similarity`; `total_matching` counts everyone passing the filters.

### `record_feedback`

`{"job_id": "...", "candidate_id": "...", "label": "shortlisted", "note": "strong payments background"}`

Labels: `shortlisted`, `rejected`, `interviewed`, `placed`. Re-labelling replaces the label and returns
`previous_label`. Candidates outside the job's scored matches (e.g. found via search) get a match row with no score.
These labels are the evaluation dataset.

### `delete_candidate`

`{"candidate_id": "..."}` permanently deletes the candidate row, all versions, match rows and every stored file.
Marked `destructiveHint` so clients can confirm first. If a delete was interrupted after the DB commit, calling it
again removes the leftover files.

### `ping`

Health check: DB reachability and candidate count.

### Errors

Failures return `isError: true` with `{"error": {"code": "...", "message": "..."}}`. Codes: `invalid_input`,
`unsupported_file_type`, `file_not_found`, `folder_not_found`, `file_too_large`, `not_found`, `already_running`,
`missing_header`, `cost_limit_exceeded`, `invalid_api_key`, `insufficient_credits`, `key_forbidden`, `rate_limited`,
`llm_unavailable`, `llm_invalid_output`, `rerank_failed`, `config_error`, `internal_error`.

## Bulk backfill from the command line

Same pipeline and `source_files` tracking as `ingest_folder`, with progress printed per file:

```sh
uv run python scripts/bulk_ingest.py ~/resumes --dry-run     # count files, estimate cost
uv run python scripts/bulk_ingest.py ~/resumes --limit 5     # try a few
uv run python scripts/bulk_ingest.py ~/resumes               # everything (subfolders included)
```

- Only PDFs; other files are ignored. Each is transcribed by `VISION_MODEL` (default
  `google/gemini-3.1-flash-lite`), then goes through the normal ingest pipeline with the original attached.
- Safe to stop and re-run; skipping and retries work as described under `ingest_folder` (`--max-attempts`, default 3).
- `--concurrency` (default 4) bounds files in flight and memory. Other flags: `--source`, `--no-recursive`,
  `--json`. Exits 1 if any file failed.
- Measured: ~$0.002 and 7-19 s per PDF; with concurrency 4, about 25 PDFs a minute.

## Evaluation

```sh
uv run python scripts/eval.py                  # fixture JDs vs expected candidates (separate recruiter_eval DB)
uv run python scripts/eval.py --reingest       # re-extract the fixture resumes first
uv run python scripts/eval.py --feedback       # agreement with real record_feedback labels
uv run python scripts/eval.py --json report.json
```

Fixture mode ingests the synthetic resumes once with the real LLM (reused on later runs), runs each JD in
`tests/fixtures/jobs/` through `match_job`, and reports recall@10, each expected candidate's rank, the funnel stage
that lost any miss (filters, vector top-K, or score), and latency, tokens and cost per match. Exits non-zero if
recall@10 is below 0.8. Feedback mode reports recall@10 and precision@10 of positive labels (shortlisted,
interviewed, placed), average scores of positives vs rejections, and positives the recruiter found outside the
results.

Latest run (2026-09-30, `openai/gpt-5-mini`, 20 candidates, 5 JDs): recall@10 1.00; ~15 s and ~$0.010 per
match; ingest 6.8 s and $0.0014 per resume. With `RERANK_POOL_SIZE=10`, recall stays 1.00. Between identical
runs, scores differ by 3.8 points on average; candidates from an adjacent field (e.g. an SRE scored for a backend
role) can still swing 20+ points, since whether that experience is "relevant" is a judgment call.

## Security and privacy

- HTTP transport requires `Authorization: Bearer $MCP_AUTH_TOKEN` (constant-time compare). `/healthz` is open.
- Logs contain IDs, counts and error codes only. Crash logs record the exception type and frame locations, not the
  message, since messages can quote row values.
- `ingest_resume.file_path` reads any PDF the server process can access, and
  `get_candidate` returns local paths. Fine for a personal machine; restrict the process user if you expose the
  HTTP port. An `X-OpenRouter-Api-Key` header is used only for that request's calls; it is never logged or stored.
- Token usage and OpenRouter cost for every LLM and embedding call are written to the `usage` table, tagged with
  the tool and a per-call request id. Match runs also store latency, tokens and cost in `jobs.stats`.

## Tests

```sh
uv run pytest            # unit + integration (needs docker compose Postgres; uses a recruiter_test DB)
uv run python scripts/make_fixtures.py   # regenerate synthetic fixture resumes
uv run python scripts/bench_vector.py    # filter + vector latency/recall at 50k rows (separate recruiter_bench DB)
```

Integration tests use a fake LLM that returns each fixture's expected profile, so they run offline.
`tests/test_live.py` calls OpenRouter for real and runs only when `LLM_API_KEY` is set.
