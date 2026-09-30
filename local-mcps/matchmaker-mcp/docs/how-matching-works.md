# How matching and ranking work

This describes the design in `docs/spec.md` (Overrides applied). It is implemented in `src/recruiter_mcp/match.py`; where details differ (years slack, borderline re-scoring twice and averaged, `MIN_MATCH_SCORE` cutoff, exact scan below 20k rows), the README is current.

## 1. The big picture: parse once, rank per job

The work is split in two because the two halves have different shapes.

**Ingest time** handles everything that depends only on the resume: LLM extraction into a `CandidateProfile`, `years_exp` computed in code from role dates, skill normalization, and one embedding. This costs a few LLM calls per resume and happens once. The results sit in `candidates` as plain columns (`years_exp`, `location`, `notice_days`, `skills[]`) plus `profile` JSON and a vector.

**Match time** handles everything that depends on the job. It never re-reads resume text. It filters on columns, searches vectors, and asks the LLM to judge a small pool.

There is no rank at ingest because a rank is a relationship between a candidate and a job. "How good is Priya?" has no answer until you say "for what?". A global quality score would push generalists with long resumes to the top of every search. What ingest can do is make the candidate cheap to compare later.

## 2. The funnel, with one example JD

Example: *"Senior backend engineer. Python and AWS required, Kafka nice-to-have. 5 to 8 years. Pune or remote."* The corpus holds 20,000 candidates.

```
  20,000  all candidates
     |    SQL: freshness (updated in last 180d)
   9,000
     |    SQL: years_exp 5-8 (nulls pass, flagged)
   2,600
     |    SQL: location Pune OR remote allowed  (no-op here, see below)
   2,600
     |    SQL: skills contain {Python, AWS}  (optional)
     700
     |    pgvector cosine, HNSW  -> top RERANK_POOL_SIZE
      50
     |    LLM rerank, 50 calls, rubric 0-100
      50 scored
     |    sort by score, take limit
      10  returned; all 50 saved to matches
```

### 2.1 JD parsing

One LLM call turns the JD into `JobRequirements`:

```
must_have_skills: [Python, AWS]   nice_to_have_skills: [Kafka]
min_years: 5  max_years: 8        locations: [Pune]  remote_ok: true
dealbreakers: []                  summary: "..."
```

The prompt is told to be strict: only "required/must" goes into must-haves. Parsed skills are passed through the same normalizer as resume skills, so "Amazon Web Services" in the JD and "aws" on a resume both become `AWS`.

Then the caller's `filters` are merged on top. Anything given explicitly wins, key by key. If the recruiter passes `min_years: 4`, the parsed 5 is ignored but the parsed locations still apply. This is the escape hatch for a JD that says one thing when the recruiter means another.

### 2.2 SQL hard filters

These are cheap, exact, and run on indexed columns. Each one removes candidates who cannot be a fit no matter how good they look.

- **Freshness** (`max_resume_age_days`, e.g. 180): `updated_at > now() - interval`. Old resumes often belong to people who have moved on or are no longer looking.
- **Experience** (`min_years`, `max_years`): `years_exp BETWEEN 5 AND 8 OR years_exp IS NULL`. Null means the resume had no parseable dates. Dropping those would silently lose people with badly formatted resumes, so they pass and the reranker adds "experience unknown" to `concerns`.
- **Location / remote**: `location = ANY(locations)`, or skip the check when `remote_ok` is true. Note that candidates have no "open to remote" field, so for a remote-friendly job this filter narrows nothing. That is correct behavior but worth knowing.
- **Notice period** (`max_notice_days`): same null-passes rule.
- **Must-have skill overlap** (optional): `skills @> ARRAY['Python','AWS']`, served by the GIN index. This is the most powerful filter and the most dangerous. It only works if normalization is good. `skill_synonyms` maps aliases to a canonical name (`k8s` → `Kubernetes`, `amazon web services` → `AWS`, `py` → `Python`). The rule is lowercase, strip punctuation, look up the alias, and fall back to the title-cased original. A candidate who wrote "Boto3, Lambda, EC2" but never "AWS" fails this filter, and so does a synonym the table has never seen. A softer variant is "at least k of n must-haves", which is worth considering.

### 2.3 Vector search

Each side is embedded once with `text-embedding-3-small` (1536 dims):

- **Candidate:** current title + summary + skills + the last 3 roles (title, company, highlights). Done at ingest.
- **Job:** title + summary + must-haves + nice-to-haves. Done at match time and stored on `jobs.embedding`.

The query orders the filtered set by cosine distance (`embedding <=> $job_vec`) and takes the top 50. The HNSW index makes this an approximate nearest-neighbour search that stays fast at 50k rows.

This stage exists for cheap recall: it narrows 700 plausible people to 50 who *talk about* similar work, for almost no cost. It is bad at anything that needs counting or logic. It cannot tell "5 years of Python" from "used Python once in college", cannot tell a must-have from a passing mention, and rates "Kafka expert, no Python" close to what you want. That is why it only selects a pool and never produces the final order.

One pgvector subtlety: HNSW with a `WHERE` clause scans about `ef_search` (default 40) neighbours and then filters, so a selective filter can return fewer than 50 rows. Fix it with `hnsw.iterative_scan` (pgvector 0.8+), a larger `ef_search`, or an exact scan when the filtered set is small (700 exact distance computations is trivial).

### 2.4 LLM rerank

Each of the 50 candidates gets one LLM call with a fixed rubric:

| Component | Points |
|---|---|
| Must-have coverage (evidence in roles beats a skills list) | 40 |
| Relevant experience (years in range, similar titles/domain) | 25 |
| Recency and depth of relevant work | 15 |
| Nice-to-haves and industry | 10 |
| Logistics (location, notice, dealbreakers) | 10 |

Any violated dealbreaker caps the score at 30 and is listed in `concerns`. The output is a `CandidateScore`: score, must-haves met and missing, concerns, and a one-line pitch.

Name, email, and phone are removed before the call and re-attached afterwards by `candidate_id`. The model cannot be swayed by a name it never sees.

Calls run concurrently behind a semaphore (`RERANK_CONCURRENCY`, default 10). Each has a timeout and 2 retries. A candidate whose call still fails is dropped, and the match still completes.

Prompt layout matters for cost. The instructions, the JD requirements, and the rubric form an identical prefix across all 50 calls, and the candidate comes last. Providers cache a repeated prefix and bill it at a discount. Through OpenRouter this is automatic for OpenAI and Gemini models. Anthropic models need explicit `cache_control` breakpoints on the prefix. OpenAI only caches prefixes of 1,024 tokens or more, and the first concurrent wave may all miss because none has finished writing the cache.

### 2.5 Sort, cut, persist

Sort by score descending and return the top `limit` (10). If fewer than 10 survive the filters, return what exists with a `note`. Do not pad with poor fits: a recruiter trusts a short honest list more than ten names where the last four are noise.

Write one `jobs` row (requirements, effective filters, funnel counts, embedding) and a `matches` row for **all 50** scored candidates with score and rank. Keeping ranks 11 to 50 is what makes later evaluation possible.

## 3. How far to trust the scores

The scores are relative, not calibrated. An 82 means "better than the 74 in this pool", not "82% likely to be hired". Scores from different jobs are not comparable. The same candidate can also score 78 on one run and 84 on the next, so ranks 8 to 12 are close to a coin flip.

Cheap fixes:

- Temperature 0 (or the lowest the model allows) and a fixed prompt.
- Deterministic tie-breaks: score, then must-haves met count, then vector similarity.
- Re-score borderline candidates (for example, anyone within 5 points of the #10 cut) two more times and use the median.
- Ask for the five sub-scores and sum them in code. That is more stable than one holistic number and shows *why*.

## 4. Failure modes and levers

A good candidate can be lost at three places.

**At the filters.** Strict must-have overlap drops someone whose resume says "EC2, S3, Lambda" but not "AWS". A location stored as "Pune, Maharashtra" or "Poona" fails an exact match on "Pune". Levers: grow `skill_synonyms`, normalize locations at ingest, make must-have overlap "k of n", or turn it off.

**At the vector stage.** The pool of 50 is too small when many filtered candidates look similar, or a strong candidate has a thin summary and few highlights, so their embedding is vague. Levers: raise `RERANK_POOL_SIZE`, enrich the embedding text.

**At rerank.** The model misreads a profile or over-weights a keyword. Levers: a stronger model, prompt fixes, and multi-run scoring on borderline cases.

What each knob does:

- `RERANK_POOL_SIZE`: more recall, linear increase in cost and in latency per wave.
- `RERANK_CONCURRENCY`: lower latency, same cost, bounded by provider rate limits.
- `LLM_MODEL`: judgment quality against price and speed. It is shared with JD parsing and ingest extraction unless split.

## 5. Cost and latency per match

Assumptions: gpt-5-mini at $0.25/M input and $2.00/M output, embeddings at $0.02/M. JD parse ~2k in / 400 out. Rerank ~1.5k in / 200 out per call. No caching in the base case.

| Step | Arithmetic | Cost |
|---|---|---|
| JD parse | 2,000 × $0.25/M + 400 × $2/M | $0.0013 |
| JD embedding | ~300 × $0.02/M | ~$0.00001 |
| Rerank input | 50 × 1,500 = 75k × $0.25/M | $0.0188 |
| Rerank output | 50 × 200 = 10k × $2/M | $0.0200 |
| **Total** | | **~$0.04** |

At 30 matches a day that is about $1.20 a day, or $36 a month. Output dominates, so caching helps less than you might expect. If a 1.1k-token prefix is cached at the ~10% rate on 49 of 50 calls, input drops by about $0.012, and the total lands near $0.028.

Caveat: gpt-5-mini is a reasoning model, and hidden reasoning tokens bill as output. If each call reasons for 500 tokens, rerank output triples and the match costs about $0.09. Set reasoning effort to minimal for rerank.

Latency: JD parse 3 to 6 s, embedding and SQL under 0.5 s, then rerank. 50 calls at concurrency 10 is 5 waves of roughly 4 to 8 s, so 20 to 40 s. That total of about 25 to 45 s is right at the 45 s target. Raising concurrency to 25 gives 2 waves and roughly 15 s total, if rate limits allow.

## 6. Closing the loop

`record_feedback` writes a label (shortlisted, rejected, interviewed, placed) onto the existing `matches` row. That is ground truth from the recruiter's own decisions.

`eval.py` uses it. For each fixture JD, take the candidates labeled positive and measure **recall@10**: the fraction that appear in the top 10. The target is 0.8 or higher. Because all 50 scored matches and the funnel counts are stored, you can also see *where* a positive was lost: removed by a filter, outside the vector top 50, or scored below the cut. That tells you which lever to pull.

"Learned ranking" (out of scope for v1) would stop hand-weighting the rubric. You would collect features per candidate-job pair (vector similarity, each rubric sub-score, years delta, must-have coverage, notice days) and train a model on the feedback labels to predict "shortlisted". The rubric weights stop being 40/25/15/10/10 by fiat and become whatever predicts this recruiter's choices. That needs a few hundred labeled pairs first, which the v1 feedback loop is designed to collect.
