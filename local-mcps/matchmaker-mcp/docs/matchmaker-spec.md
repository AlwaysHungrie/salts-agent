# Matchmaker: folders, hybrid search, the agent judges (spec)

Replaces the recruiter funnel (`src/recruiter_mcp`). Redesigned 2026-10-15: the attribute design (people's own
strength-scored attributes, job readings with synonym lists, focus levels) gave poor rankings and is gone. The old
package stays until this one passes its evaluation, then it is removed.

## Scope

- One user: the admin. The admin adds people's resumes and cover letters, posts jobs, and asks for ranked
  candidates. No self-service profiles, no person dedup (later).
- Runs on the admin's laptop through salts-tools, like analyst. Model calls use the caller's OpenRouter key
  (`X-OpenRouter-Api-Key`); the server has no key of its own. Optional `Tool-Call-Max-Charge` caps one tool call.
- No database. Everything is files under `MM_DATA_DIR`.

## Files

```
people/<person_id>/
  resume.pdf | .docx | .txt | .md   the original, when a file was sent
  resume.txt                        its text
  cover_letter.<ext>, cover_letter.txt
  notes.txt                         the admin's facts, one dated line each, added to and never replaced
  profile.md                        written by the server; no contact details
  person.json                       name, email, phone, the profile's fields, documents (sha256, original)
  embedding.npy                     the profile's embedding
jobs/<job_id>/
  job.md, job.json, embedding.npy
```

## Flows

### Add a document

1. A resume or cover letter, as a file (PDF text layer, DOCX, TXT, MD; parsed in code, no model) or as text.
   A second document of the same kind replaces the first.
2. One model call (`gpt-5-nano`) writes the profile from all of the person's documents: headline, current title,
   seniority, location, open to relocate, work mode, years of experience, work authorization, notice period,
   languages, education, industries, skills (common names, implied ones included) and a summary.
3. The profile is embedded. Nothing is written until both calls succeed.

The profile reads generously, because it decides who the admin calls:
- Open to relocate is `no` only when the person says so, `yes` when they say they are open; otherwise `likely`
  (the default) or `unlikely` with a concrete reason, which is written next to it.
- Years of experience count every role, internships and freelance included; without dates, an estimate.
- Work authorization is copied when stated, else "likely <country>" from education and roles.

### Post a job

The posting is saved and embedded. No chat call.

### Find candidates

One embedding call (none when searching with the posting itself), no chat call.

1. BM25 (`bm25s`, English stemming and stopwords) over each person's profile, resume and cover letter.
2. Cosine similarity of the query's embedding and each profile's.
3. Reciprocal rank fusion: each list adds `1 / (60 + rank)`. Everyone is listed; people with no query word rank on
   meaning alone.
4. Pages of 50 with `next_offset`. Each candidate carries their profile and both ranks.

The query is the posting, or a query the agent writes: the role and its other titles, the must-have skills and
their other names. The same person filed twice (same email or phone, or resumes sharing half their word 5-grams)
is listed once.

### Judge a page

1. The job's core is read once per job by `gpt-5-mini` (reasoning) and kept as `jobs/<id>/core.json`: role type
   and core work (no product names), 3-5 must-haves that separate a fit from a near miss (the role-defining
   experience first), years needed.
2. Each candidate on the page is checked alone by `gemini-2.5-flash` at temperature 0, from their full
   documents: evidence first, then yes / maybe / no for core work, same role type, latest role is core work,
   seniority, and each must-have; plus years of core work. "yes" only when the written evidence shows all of it.
3. The score is computed in code: core work 30, years of core work against years needed 15, role type 15,
   latest role 10, seniority 5, must-haves 25 (first counts double); then 85% that and 15% the search place
   (100 for first in the pool, 0 for last). No ceilings: one flipped answer moves a score by its own points.
4. The page is ordered by score, ties by name. The next page is judged when asked for.

Measured on the benchmark job: the same page judged twice ranks the same (Spearman 0.993, same top 10);
gpt-4.1-mini gave 0.94 and gpt-5-mini 0.84 with a worse order. About $0.10 per page of 50.

The index is in memory and rebuilt when any person's files change (checked by modification time on every search).

## Costs (gpt-5-nano, text-embedding-3-small)

| Event | Model calls |
|---|---|
| Add a document | 1 chat + 1 embedding, ~$0.001 |
| Post a job | 1 embedding |
| Find candidates, next page | 1 embedding with an agent query, else none |
| Judge a page of 50 | 1 job-core call per job, 50 judge calls, ~$0.10 |

## Evaluation

`tests/benchmarks/resume_job_fit.py --system new` on the Hugging Face resume/job fit set: BM25 alone, embeddings
alone, hybrid on the posting, hybrid on a written query, and both hybrids with a simulated agent judging the top
50. Results are in `tests/benchmarks/out/`.

## Build steps

1. **Core and evaluation.** People, jobs, search and judging as a library. Done.
2. **Server** (`matchmaker-mcp`, `src/matchmaker/server.py`). Done; salts-tools runs it as `matchmaker`.
   Tools: `add_document` (upload_id or text), `add_note` (a fact about a person; it wins over the documents and
   is read by the profile, search and the judge), `get_person`, `get_person_files_link` (a signed browser link to the
   person's files), `delete_person`, `post_job`, `list_jobs`,
   `find_candidates` (search, then the page judged), `search_people` (unjudged), `ping`, and bulk ingest:
   `get_upload_link` (a signed browser link to an upload page that writes into the inbox; the inbox folder when the
   caller did not come through the salts-tools gateway), `ingest_inbox` (a background run, each file a new
   person's resume; files added before and unchanged are skipped by path, size and modification time, text
   already on file costs nothing, failures retried up to 3 times; the whole run must fit Tool-Call-Max-Charge),
   `get_ingest_status`. `scripts/export_hf_resumes.py FOLDER` writes the benchmark's resumes as text files. `POST /uploads` takes
   PDF, DOCX or text bytes and returns an upload_id; `/healthz` is open, so is `/share/<token>…` (links.py: the token
   is HMAC-signed with a key from MCP_AUTH_TOKEN and expires after `MM_LINK_TTL_HOURS`, 24 by default; the public
   address comes from the gateway's X-Forwarded-* headers), everything else needs the bearer token.
3. **Clean up.** Remove `recruiter_mcp`, its migrations, Postgres and docker-compose, update the package README.
