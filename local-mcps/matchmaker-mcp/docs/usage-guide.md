# Usage guide

How to run recruiter-mcp on your machine, connect it to an assistant, and use it day to day. Tool parameters and
return shapes are in the [README](../README.md); ranking internals in [how-matching-works.md](how-matching-works.md).

## What it is

An MCP server that your AI assistant calls as tools. You talk to the assistant ("add this resume", "who fits this
JD?"); the assistant calls the server; the server keeps the candidate database and does the matching.

```
You ──chat──> Claude (Desktop / Code) ──MCP tools──> recruiter-mcp ──> Postgres + pgvector (Docker)
                                                          │        └─> DATA_DIR/resumes/  (original PDFs)
                                                          └──> OpenRouter (extraction, JD parsing, scoring, embeddings)
```

Two phases:

- **Ingest (once per resume, PDF only).** One resume: the assistant reads the PDF and sends the full text plus the
  file's path. A folder: the assistant sends the folder's path and the server reads the PDFs itself. Either way the
  server extracts a structured profile (name, contacts, roles with dates, skills, location, notice period), computes
  years of experience from the dates, normalizes skill names, embeds the profile, and keeps a copy of the PDF.
  Same file again: skipped. Same person (email or phone) with a new resume: updated, old version kept.
- **Match (per job).** The server parses the JD into requirements, filters on years / location / notice / resume
  age, takes the 50 most similar candidates by embedding, has the LLM score each against a fixed rubric, and
  returns the top N with a pitch, must-haves met/missing and concerns. Every run is saved.

## One-time setup

Works on macOS, Linux and Windows. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Docker
(Docker Desktop on macOS/Windows; Docker Engine with the compose plugin on Linux), then in the repo folder:

```sh
cp .env.example .env            # Windows (PowerShell or cmd): copy .env.example .env
```

Edit `.env` and set `MCP_AUTH_TOKEN` to a random string (`openssl rand -hex 24`, or
`python -c "import secrets; print(secrets.token_hex(24))"` on Windows). The OpenRouter key does not go in `.env` when
you connect over HTTP: the assistant sends it with every request (next section).

```sh
docker compose up -d            # Postgres; data persists in the pgdata volume
uv sync
uv run recruiter-mcp-migrate
uv run python scripts/smoke.py stdio   # expect ping={'ok': True, 'db': True, 'candidates': 0}
```

## Connect an assistant

There are two ways to connect. HTTP is recommended: your OpenRouter key and spending limits travel as request
headers, so nothing secret sits in the server's config. Stdio is simpler to start but has no headers, so the key (and
any limits) must be in `.env`. Both work with Claude and with any other MCP-capable agent (see "Any other agent").

### HTTP (recommended): key and limits in headers

Start the server and leave it running:

```sh
MCP_TRANSPORT=http uv run recruiter-mcp                    # macOS / Linux
$env:MCP_TRANSPORT="http"; uv run recruiter-mcp            # Windows PowerShell
```

It listens on `http://127.0.0.1:8000/mcp`. Connect the assistant with all of these headers:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <MCP_AUTH_TOKEN from .env>` |
| `X-OpenRouter-Api-Key` | Your OpenRouter key, `sk-or-v1-...` |
| `X-Cost-Approved-Resume-Ingestion` | Max USD per resume, e.g. `0.005` |
| `X-Cost-Approved-Job-Match` | Max USD per match, e.g. `0.05` |
| `X-Cost-Approved-Search` | Max USD per search, e.g. `0.001` |
| `X-Cost-Approved-Folder-Ingestion` | Max USD per folder run, e.g. `2.00` |

All are required over HTTP. `LLM_API_KEY` and `COST_APPROVED_*` in `.env` are ignored for HTTP requests. A call
without its headers fails with `missing_header`, naming what is missing: for example `match_job` needs
`X-OpenRouter-Api-Key` and `X-Cost-Approved-Job-Match`. Tools that never call a model (`ping`, `get_candidate`,
`get_job`, `list_jobs`, `record_feedback`, `delete_candidate`) work with `Authorization` alone. Use `0` for a tool
you want blocked entirely.

**Claude Code**:

```sh
claude mcp add --scope user --transport http \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  --header "X-OpenRouter-Api-Key: sk-or-v1-..." \
  --header "X-Cost-Approved-Resume-Ingestion: 0.005" \
  --header "X-Cost-Approved-Job-Match: 0.05" \
  --header "X-Cost-Approved-Search: 0.001" \
  --header "X-Cost-Approved-Folder-Ingestion: 2.00" \
  recruiter http://127.0.0.1:8000/mcp
claude mcp list   # recruiter should show Connected
```

**Claude Desktop** has no header setting for local servers; bridge it with `mcp-remote` (needs Node.js). Add under
`mcpServers` in the config file, then quit and reopen Desktop:

```json
"recruiter": {
  "command": "npx",
  "args": ["mcp-remote", "http://127.0.0.1:8000/mcp",
           "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>",
           "--header", "X-OpenRouter-Api-Key: sk-or-v1-...",
           "--header", "X-Cost-Approved-Resume-Ingestion: 0.005",
           "--header", "X-Cost-Approved-Job-Match: 0.05",
           "--header", "X-Cost-Approved-Search: 0.001",
           "--header", "X-Cost-Approved-Folder-Ingestion: 2.00"]
}
```

| OS | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | No official Desktop build; use Claude Code or another MCP client |

The server listens on localhost only. If you expose the port, note that the file and folder tools read any PDF the
server user can read and return local paths.

### Stdio: key and limits in `.env`

The assistant starts the server itself, so nothing needs to be left running. Put your OpenRouter key in both
`LLM_API_KEY` and `EMBED_API_KEY` in `.env`. Limits are optional on stdio: set `COST_APPROVED_RESUME_INGESTION`,
`COST_APPROVED_JOB_MATCH`, `COST_APPROVED_SEARCH` and `COST_APPROVED_FOLDER_INGESTION` to enable them.

The server must start in the repo directory, because `.env` and `./data` are relative paths. Use
`uv --directory`. Find uv's full path with `which uv` (macOS/Linux) or `where uv` (Windows).

**Claude Code**:

```sh
# macOS / Linux
claude mcp add recruiter --scope user -- /opt/homebrew/bin/uv --directory /Users/me/matchmaker-mcp run recruiter-mcp
# Windows
claude mcp add recruiter --scope user -- C:\Users\me\.local\bin\uv.exe --directory C:\Users\me\matchmaker-mcp run recruiter-mcp
```

**Claude Desktop** (config file as above):

```json
"recruiter": {
  "command": "/opt/homebrew/bin/uv",
  "args": ["--directory", "/Users/me/matchmaker-mcp", "run", "recruiter-mcp"]
}
```

On Windows, escape backslashes in JSON or use forward slashes:
`"command": "C:/Users/me/.local/bin/uv.exe", "args": ["--directory", "C:/Users/me/matchmaker-mcp", "run", "recruiter-mcp"]`.

### Any other agent

Any agent or app that speaks MCP can use the server: Cursor, Windsurf, VS Code, Zed, ChatGPT-style desktop apps, the
OpenAI Agents SDK, LangChain/LangGraph, or your own code. Whatever the client, it needs one of these two
descriptions.

**Streamable HTTP** (start the server as above first):

| Field | Value |
|---|---|
| Transport | Streamable HTTP (sometimes labelled "HTTP" or "remote"; not the older SSE transport) |
| URL | `http://127.0.0.1:8000/mcp` |
| Headers | All six from the HTTP table above |

Most clients take a JSON block like this (key names vary slightly: `url` or `serverUrl`, `headers` or
`requestInit.headers`; check the client's MCP docs):

```json
{
  "mcpServers": {
    "recruiter": {
      "url": "http://127.0.0.1:8000/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>",
        "X-OpenRouter-Api-Key": "sk-or-v1-...",
        "X-Cost-Approved-Resume-Ingestion": "0.005",
        "X-Cost-Approved-Job-Match": "0.05",
        "X-Cost-Approved-Search": "0.001",
        "X-Cost-Approved-Folder-Ingestion": "2.00"
      }
    }
  }
}
```

If the client supports only stdio servers, bridge with `mcp-remote` exactly as in the Claude Desktop example.

**Stdio**:

| Field | Value |
|---|---|
| Command | full path to `uv` (`which uv` / `where uv`) |
| Arguments | `--directory`, `<repo path>`, `run`, `recruiter-mcp` |
| Environment | Optional. `LLM_API_KEY`/`EMBED_API_KEY` here override `.env` |

**From your own code** (Python, official `mcp` SDK):

```python
import asyncio
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

HEADERS = {
    "Authorization": "Bearer <MCP_AUTH_TOKEN>",
    "X-OpenRouter-Api-Key": "sk-or-v1-...",
    "X-Cost-Approved-Resume-Ingestion": "0.005",
    "X-Cost-Approved-Job-Match": "0.05",
    "X-Cost-Approved-Search": "0.001",
    "X-Cost-Approved-Folder-Ingestion": "2.00",
}

async def main():
    http = create_mcp_http_client(headers=HEADERS)
    async with Client(streamable_http_client("http://127.0.0.1:8000/mcp", http_client=http)) as client:
        tools = await client.list_tools()           # hand these to your agent's model as tools
        res = await client.call_tool("search_candidates", {"query": "Python backend, Pune"})
        print(res.structured_content)

asyncio.run(main())
```

In TypeScript, `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` takes the same URL and headers via
`requestInit: { headers }`.

**Chat attachments (agent app code).** If your agent lets users attach a resume in chat, the app must upload the
file; the model cannot. The model sees the PDF's content but cannot copy its bytes into a tool call, so without this
it ingests the text only (no stored file, and it may invent a file path). When a PDF is attached:

```ts
// TypeScript (fetch)
const res = await fetch(`${MCP_BASE}/uploads`, {
  method: "POST",
  headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}`, "Content-Type": "application/pdf" },
  body: pdfBytes,                       // Blob / ArrayBuffer / Buffer of the attachment
});
const { upload_id } = await res.json();
// Add to the model's context alongside the attachment:
userMessageText += `\n\n[Attachment ${fileName} uploaded to recruiter-mcp: upload_id=${upload_id}]`;
```

```python
# Python (httpx)
r = httpx.post(f"{MCP_BASE}/uploads", content=pdf_bytes,
               headers={"Authorization": f"Bearer {MCP_AUTH_TOKEN}", "Content-Type": "application/pdf"})
upload_id = r.json()["upload_id"]
user_text += f"\n\n[Attachment {file_name} uploaded to recruiter-mcp: upload_id={upload_id}]"
```

`MCP_BASE` is the server URL without `/mcp` (e.g. your ngrok URL). The model then calls `ingest_resume` with the
text and `upload_id`, and the original PDF is stored.

If your agent caches the server's tool list, refresh it after upgrading recruiter-mcp. An agent still holding an old
list does not know about `upload_id` (so it never uploads) and may see a removed `file_base64` field, which models
fill with a fake PDF.

**Instructions for the agent.** The server sends its own instructions and tool descriptions, which capable models
follow. If your agent needs a system prompt, this covers the non-obvious parts:

```
You have recruiter-mcp tools for a candidate database on this computer.
- Resumes are PDF only. For one resume, read it and call ingest_resume with the full verbatim text plus the
  upload_id given for the attachment. Use file_path only for a real file on the server's machine; never guess
  a path.
- For more than a few resumes, call get_bulk_ingest_folder and tell the user to put their PDFs in the
  folder it returns and say when they are done. Never ask where their files are. After they confirm, call
  ingest_folder (do not open the files yourself), then poll get_folder_ingest_status every 30-60 s and
  report progress and failures.
- Files are never sent through the chat. When the user asks for a resume or CV, call get_resume_file and
  reply with its message_for_user (the full path on their computer). Do not paste the profile instead.
- Prefer search_candidates for browsing (instant, nearly free). match_job takes 15-45 s; reopen past results
  with get_job instead of re-running.
- If a tool fails with cost_limit_exceeded, missing_header, invalid_api_key or insufficient_credits, do not
  retry. Tell the user the reason from the error message and what they need to change.
- Call record_feedback whenever the user shortlists, rejects, interviews or places someone.
```

### Spending limits and key errors

A call expected to cost more than approved is refused before anything is spent, and the assistant tells you why (e.g. "job match not started: estimated cost $0.0300 ... exceeds the $0.0100 approved"). A call that
reaches its limit while running stops there. If the key is wrong or out of credit, the assistant says so
(`invalid_api_key`, `insufficient_credits`).

Docker must be running whenever the assistant uses the tools. Check with `docker compose ps` in the repo.

## Daily use

Talk to the assistant in plain language. It picks the tools.

**Add resumes**

> Ingest ~/Downloads/priya_sharma_cv.pdf

> Add C:\Users\me\Downloads\priya_sharma_cv.pdf. Source: LinkedIn. Note: referred by Amit.

Only PDFs are accepted. Attach the PDF in chat (your agent app uploads it and gives the assistant an `upload_id`; see
"Chat attachments" above), or give a path on the server's machine and it passes `file_path`. Either way the original
is kept, named like `Priya_Sharma_Resume_3f0c9a1b.pdf`.

The reply shows `created`, `updated` or `duplicate_file`, a one-line headline, and warnings such as "no email found"
or "years_exp unknown".

**Add many resumes at once**

> I have 10 PDFs to add.

The assistant replies with the server's inbox folder, e.g. "Put the PDF resumes you want to add in
`/Users/me/matchmaker-mcp/data/inbox`, then tell me to go ahead." Copy the files there (subfolders are fine; other
file types are ignored) and say "go ahead". The server reads the PDFs itself and works in the background; ask "how
is the import going?" for progress and failures. The inbox location is `INBOX_DIR` in `.env` (default
`DATA_DIR/inbox`).

Files can stay in the inbox. Ones already ingested and unchanged are skipped without being opened, so next time you
can drop in a few new PDFs and only those are processed. About $0.002 per new PDF, ~25 PDFs a minute. Failed files
are retried on the next run (up to 3 times).

The same thing from a terminal, with per-file output:

```sh
uv run python scripts/bulk_ingest.py ~/resumes --dry-run    # counts files, estimates cost
uv run python scripts/bulk_ingest.py ~/resumes              # all; safe to stop and re-run
```

**Match a job**

> Find the best 10 candidates for this JD: *(paste JD)*

> Same JD but only people with 30 days notice or less, in Pune or Mumbai.

Takes 15-45 s, ~$0.01-0.04. Results show rank, score (0-100), breakdown, pitch, must-haves met/missing and
concerns. Scores compare candidates within one job only; a 72 on one job and a 72 on another mean different things.
Candidates under 35 are left out rather than padding the list.

Things you can override (they win over what the JD says): `locations`, `remote_ok`, `min_years`, `max_years`,
`max_notice_days`, `max_resume_age_days`, `min_must_have_skills`. Years parsed from the JD get slack (JD "5-8 yrs"
admits 4-10); years you state explicitly are exact.

**Browse without a JD** (instant, ~free):

> Search Python backend devs in Pune with under 30 days notice.

> Who has Kubernetes and Terraform?

**Reopen past matches** (no cost):

> List my recent job matches. / Show the results for the senior backend job again, top 20.

**Get a resume**

> Get me the resume of Priya Sharma.

The file is not sent through the chat. The assistant answers with where it is stored, e.g. "Priya Sharma's resume is
stored on your computer at: /Users/me/matchmaker-mcp/data/resumes/3f0c…/9a1b….pdf". If only the text was ingested,
it says there is no stored file. If several people match a name, it asks which.

**Look someone up**

> Show me Priya Sharma's profile.

Returns the parsed profile: contacts, roles, skills, summary.

**Record decisions** — do this; it is how ranking quality gets measured.

> Shortlist Priya for that job. Reject Arjun, notice too long. Mark Neha as placed.

Labels: shortlisted, rejected, interviewed, placed. Re-labelling replaces the old label.

**Delete** (privacy requests): "Delete candidate Priya Sharma permanently." Removes profile, versions, match rows and
files. Irreversible; the assistant should confirm first.

## Checking quality and cost

```sh
uv run python scripts/eval.py --feedback      # how often your shortlisted/placed people ranked top 10
uv run python scripts/eval.py                 # synthetic benchmark; recall@10 should be >= 0.8
```

Spend per tool, last 7 days:

```sh
docker compose exec -T postgres psql -U recruiter -c \
  "select tool, count(distinct request_id) calls, round(sum(cost_usd),4) usd
   from usage where created_at > now() - interval '7 days' group by tool order by usd desc"
```

## Tuning (`.env`, restart the assistant after changing)

| Setting | Default | Effect |
|---|---|---|
| `LLM_MODEL` | `openai/gpt-5-mini` | Extraction, JD parsing and scoring quality vs cost |
| `RERANK_POOL_SIZE` | 50 | Candidates scored per match. Lower = cheaper and faster, may miss people |
| `RERANK_CONCURRENCY` | 10 | Parallel scoring calls. Higher = faster, may hit rate limits |
| `MIN_MATCH_SCORE` | 35 | Cutoff below which candidates are hidden |
| `RERANK_BORDERLINE_MARGIN` | 8 | Points from a cutoff that trigger a second scoring run; 0 disables |
| `YEARS_SLACK_BELOW` / `ABOVE` | 1 / 2 | Slack on JD-parsed years |
| `VISION_MODEL` | `google/gemini-3.1-flash-lite` | Folder ingest transcription only |
| `FOLDER_CONCURRENCY` | 4 | PDFs transcribed at once during folder ingest |
| `FOLDER_MAX_ATTEMPTS` | 3 | Failures before a folder file is given up on (until it changes) |
| `COST_APPROVED_*` | unset | Stdio only: spend caps in USD. Over HTTP, headers are required instead |

Skill aliases (e.g. `k8s` -> `Kubernetes`): add rows to `seeds/skill_synonyms.csv`, then
`uv run recruiter-mcp-migrate`. City aliases and metro areas live in `src/recruiter_mcp/locations.py`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tools missing in assistant | `claude mcp list`; HTTP: is the server running? Stdio: check the `--directory` path; restart Desktop |
| `ping` says `db: false` | `docker compose up -d` in the repo |
| `missing_header` | HTTP: add the headers the message names to the client's connection settings |
| `config_error: no OpenRouter API key` | Stdio: set `LLM_API_KEY`/`EMBED_API_KEY` in `.env`, and start the server in the repo dir (`--directory`) |
| `invalid_api_key` / `insufficient_credits` | Fix or top up the OpenRouter key; a folder run stops and resumes on the next `ingest_folder` |
| `cost_limit_exceeded` | Approve a higher limit (header or `COST_APPROVED_*`), or ingest fewer files |
| `unsupported_file_type` | Only PDF is accepted; export DOCX/images to PDF first |
| `llm_invalid_output` | Model returned bad JSON twice; retry, or try a stronger `LLM_MODEL` |
| Good candidate missing from a match | Ask for `get_job` with `include_low_scores`; check filters in `applied_filters` (location/years/notice); add a skill alias |
| Wrong years of experience | Resume dates unparseable; `years_exp` is null and shows a concern |

## Backups

All state is the Docker volume `matchmaker-mcp_pgdata` plus `./data/`.

```sh
docker compose exec -T postgres pg_dump -U recruiter recruiter > backup.sql
tar czf data.tgz data      # tar ships with Windows 10+ too
```

Note: `docker compose down -v` deletes the database volume.
