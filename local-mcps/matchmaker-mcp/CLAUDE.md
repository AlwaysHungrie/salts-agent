# recruiter-mcp

Personal, self-hosted MCP server for a recruiter's AI assistant. Ingests resumes, matches job descriptions against
the candidate pool, fetches candidates. Python 3.12, `uv`, Postgres 16 + pgvector (Docker), OpenRouter for LLM and
embeddings. No UI; the assistant (Claude Desktop / Claude Code) is the UI.

Docs: `README.md` (tool reference, setup), `docs/usage-guide.md` (how to wire it up and use it day to day),
`docs/how-matching-works.md` (ranking design), `docs/spec.md` (original spec; its "Overrides" section wins).

## Commands

```sh
docker compose up -d                      # Postgres on 127.0.0.1:5432 (user/pass/db: recruiter)
uv sync
uv run recruiter-mcp-migrate              # applies migrations/*.sql, re-seeds skill_synonyms (server also does this on start)
uv run recruiter-mcp                      # stdio server
MCP_TRANSPORT=http uv run recruiter-mcp   # HTTP on :8000/mcp, needs MCP_AUTH_TOKEN
uv run pytest -q                          # 93 tests, ~20 s; needs Postgres up; uses recruiter_test DB
uv run python scripts/smoke.py stdio      # calls ping through a real MCP client
uv run python scripts/eval.py             # recall@10 on fixtures, real LLM, recruiter_eval DB, ~$0.05
uv run python scripts/bulk_ingest.py DIR --dry-run
uv run ruff check src tests scripts
docker compose exec -T postgres psql -U recruiter   # inspect DB
```

## Layout (src/recruiter_mcp)

| File | Role |
|---|---|
| `server.py` | MCP tool definitions, `tool_handler` (key/budget from headers, usage, error mapping), stdio/HTTP entry |
| `billing.py` | OpenRouter key + `X-Cost-Approved-*` caps (required headers over HTTP, settings on stdio), preflight estimate, OpenRouter error mapping |
| `ingest.py` | `ingest_resume`: PDF path load/validate, sha256 dedup, LLM extraction, email/phone person dedup, versioning, storage |
| `match.py` | `match_job` funnel (parse JD, merge filters, SQL filters, vector top-K, rerank, borderline rescore), `get_job`, `list_jobs`, `record_feedback` |
| `search.py` | `search_candidates`: embedding + filters, no LLM |
| `candidates.py` | `get_candidate` (id / name / email lookup), `get_resume_file` (path + reply only), `delete_candidate` |
| `bulk.py` | Folder ingest: PDF discovery, `source_files` skip (path+size+mtime), hash dedup, vision transcription, background `FolderRuns` |
| `models.py` | All Pydantic models: `CandidateProfile`, `JobRequirements`, `CandidateScore`, filters, tool results |
| `llm.py` | OpenRouter structured-output client (JSON schema, 1 validation retry), vision transcriber |
| `embeddings.py` | OpenRouter embeddings, dim check |
| `skills.py` | Skill alias normalization (`seeds/skill_synonyms.csv` -> `skill_synonyms` table) |
| `locations.py` | City aliases + metro expansion (India-focused: Mumbai incl. Thane, Delhi incl. Gurugram/Noida...) |
| `experience.py` | `years_exp` from role dates, overlap-merged; computed in code, never by LLM |
| `storage.py` | Local disk under `DATA_DIR/resumes/{candidate_id}/{Name}_Resume_{sha8}.pdf` (older rows keep `{sha256}.pdf` keys), atomic writes |
| `usage.py` | contextvar-based token/cost tracking per tool call -> `usage` table |
| `config.py` | `Settings` (pydantic-settings, reads `.env` from **cwd**) |
| `prompts.py` | Loads `prompts/*.md`; `<!-- user -->` splits cacheable system prefix from per-call user part |

Other dirs: `migrations/` (SQL, `{EMBED_DIM}` substituted), `prompts/` (versioned prompt files),
`scripts/` (bulk, eval, smoke, fixtures, vector bench), `tests/fixtures/` (20 synthetic resumes, 5 JDs with expected
matches).

## DB tables

`candidates` (current profile, embedding, skills[], location_key, file_key, content_sha256 unique),
`candidate_versions` (previous profiles on re-ingest), `jobs` (parsed requirements, filters, funnel, stats),
`matches` (every scored candidate per job, score, rank, result JSON, feedback_label), `source_files` (folder ingest
outcome per absolute path, size, mtime; cascades on candidate delete), `skill_synonyms`, `usage`, `schema_migrations`.

## Decisions that must not be undone

- PDF only. Files are never sent back to the client: `get_candidate` returns `resume_file.path`, no resources.
  Into the server, `ingest_resume` takes `upload_id` (agent app POSTs the attachment to `/uploads`; models cannot
  emit file bytes, so this is the chat-attachment path) or `file_path`. Never expose `file_base64` as a tool
  field or mention it in errors: models fabricate a PDF or loop trying to encode one (both seen). File errors end
  with `NO_FILE_HINT` (retry text-only, tell the user);
  bulk goes through the server-owned inbox (`INBOX_DIR`): `get_bulk_ingest_folder` gives the agent the path to hand
  the user, `ingest_folder` takes no path. The agent must never ask the user where files are. No S3. Local disk.
- For single resumes the assistant reads the PDF and sends `resume_text`; no server-side parsing in `ingest_resume`.
  Folder ingest (`ingest_folder`, `scripts/bulk_ingest.py`) is the only place PDFs are read server-side (vision model).
- Must run on macOS, Linux and Windows: `encoding="utf-8"` on every text read/write, `pathlib` for paths, no
  platform-only tools (the old macOS `textutil` path is gone).
- Server still runs its own extraction prompt so profiles are consistent across assistant models.
- LLM and embeddings both via OpenRouter, one key. `EMBED_DIM` fixed at first migration.
- mcp SDK 2.x: `MCPServer` from `mcp.server.mcpserver` (not `FastMCP`). Types from `mcp_types`.
- Tools that call models take `ctx: Context | None = None` so `tool_handler` can read HTTP headers (`ctx.headers`,
  `None` on stdio). Paid clients call `billing.ensure_budget()` before each request; `usage.record` charges the
  budget. Fatal errors (`billing.FATAL_CODES`) must propagate: rerank re-raises them, folder runs stop without
  counting an attempt.
- Logs: IDs, counts, error codes only. Never resume text or exception messages (they can quote PII).
- Scores: LLM returns 5 sub-scores, code sums them (40/25/15/10/10), dealbreaker caps at 30. Name/email/phone
  stripped before scoring.

## Conventions

- Tool errors: raise `ToolFailure(code, message)`; `tool_handler` converts to `isError` JSON. Codes listed in README.
- New prompt: add `prompts/<name>.md` with a version comment, render via `prompts.render`.
- New migration: next number `migrations/00N_*.sql`; never edit applied ones.
- Tests use a fake LLM that returns each fixture's expected JSON (`tests/conftest.py`), so they run offline.
  `tests/test_live.py` hits OpenRouter only when `LLM_API_KEY` is set.
- After changing match/rerank/prompt logic, run `scripts/eval.py` and report recall@10 and cost. Target >= 0.8.
- ruff line length 120.

## Gotchas

- `.env` and `DATA_DIR=./data` resolve relative to the process cwd. MCP client configs must launch with
  `uv --directory <repo> run recruiter-mcp`. Otherwise no API keys load (`config_error` on first LLM call; `ping`
  still works because the DB URL has a default) and files land under the wrong cwd.
- Changing `EMBED_MODEL`/`EMBED_DIM` needs a new migration and re-embedding every candidate.
- `match_job` takes 15-45 s and ~$0.01-0.04. `search_candidates` is instant and ~free; prefer it for browsing.
- Folder run state (`FolderRuns`) is in memory; a server restart loses progress reporting but not per-file outcomes.
  Background tasks copy the calling context, so the header key and cap apply to the whole run.
- HNSW index builds need `shm_size: 1g` (set in docker-compose).
