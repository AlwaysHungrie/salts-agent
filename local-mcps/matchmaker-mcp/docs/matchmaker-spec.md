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
their other names. The agent then reads each page against the job and tells the admin who fits, who partly fits
and how closely, and who does not.

The index is in memory and rebuilt when any person's files change (checked by modification time on every search).

## Costs (gpt-5-nano, text-embedding-3-small)

| Event | Model calls |
|---|---|
| Add a document | 1 chat + 1 embedding, ~$0.001 |
| Post a job | 1 embedding |
| Find candidates, next page | 1 embedding with an agent query, else none |

## Evaluation

`tests/benchmarks/resume_job_fit.py --system new` on the Hugging Face resume/job fit set: BM25 alone, embeddings
alone, hybrid on the posting, hybrid on a written query, and both hybrids with a simulated agent judging the top
50. Results are in `tests/benchmarks/out/`.

## Build steps

1. **Core and evaluation** (this). People, jobs, search as a library.
2. **Server.** MCP tools (`add_document`, `get_person`, `delete_person`, `post_job`, `find_candidates`), uploads.
3. **Clean up.** Remove `recruiter_mcp`, update README, usage guide, salts-tools text.
