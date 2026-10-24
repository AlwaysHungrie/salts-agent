# find-humans

MCP server for a public directory of people. Each person writes about who they are and what they do, adds links,
and can delete any of it later. Anyone connected can search the directory ("who builds AI agents", "who runs brand
deals"), page through results and open one person's details. Built from `local-mcps/matchmaker-mcp` (same billing,
model clients and hybrid search), without files, uploads, share links, jobs or judging.

Python 3.12, `uv`. Data is plain files under `DATA_DIR`; no database. LLM and embeddings through OpenRouter, paid
by each caller's own key.

## Commands

```sh
cp .env.example .env
uv sync
uv run find-humans-mcp                                         # stdio
MCP_TRANSPORT=http SECRET_SIGNING_KEY=... uv run find-humans-mcp   # HTTP on :8000/mcp, GET /healthz open
uv run pytest -q                                               # offline, fake model clients
uvx ruff check src tests
```

## Headers (HTTP)

| Header | Needed for |
|---|---|
| `X-Find-Humans-Secret` | Every request except `/healthz`, sent once. A secret minted with `SECRET_SIGNING_KEY`: `fh1.<id>.<base64url HMAC-SHA256(key, "fh1:secret:" + id)>`, id at least 16 ASCII characters. Your `person_id` is a hash of the id |
| `X-OpenRouter-Api-Key` | Optional. Pays for `save_profile` and `search_people`; without it the server's `OPENROUTER_API_KEY` does |
| `Tool-Call-Max-Charge` | Optional cap in USD per tool call |

Each caller's secret is their only credential. There is no shared token, so a caller who reads or redirects their
own headers (a salts agent's member can do both) learns nothing that reaches another profile or the server as a
whole. Only the app that sets up agents holds `SECRET_SIGNING_KEY`. The server refuses to start without it, or
with one under 32 bytes.

The secret is never stored or logged. Whoever holds it can edit or delete that profile. There is no recovery yet,
so a lost secret means a lost profile.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `search_people {query, offset}` | ~$0.00002 | Saved profiles ranked by BM25 + embedding similarity (reciprocal rank fusion), 10 per page; `next_offset` for more |
| `get_person {person_id}` | free | Saved profile (headline, location, skills, summary, beliefs), everything the person wrote, links |
| `add_info {text?, links?}` | free | Adds to your entries: the text is one entry, each link another |
| `my_info` | free | Your entries with `entry_id`s, the saved profile, `unsaved_changes` |
| `delete_info {entry_ids}` | free | Deletes some of your entries |
| `save_profile` | ~$0.001 | One model call writes the profile (headline, location, skills, summary, beliefs) from your entries, then it is embedded and searchable. With no entries left, you leave search. Unchanged entries: no model call |
| `delete_my_profile` | free | Deletes all your entries and your saved profile |
| `ping` | free | People with a saved profile |

Search and `get_person` read only saved profiles. Added or deleted entries reach them on the next `save_profile`.
Beliefs are what the person says they believe in or care about, so a search like "privacy is a right" finds people
who think alike. Profiles saved before beliefs existed have none until their next save with changed entries.

## HTTP API

For the app that sets up agents, so its pages can show and save a profile without an agent. Same headers as the MCP
endpoint; each route runs the tool of the same name, so the secret, key, cost cap and spend limits apply alike.

| Route | Answer |
|---|---|
| `GET /api/me` | `{info, profile}`: `info` as `my_info`, `profile` the saved profile as `get_person` gives it, or null |
| `POST /api/me/save` | Runs `save_profile`, then the same as `GET /api/me` |
| `GET /api/people/{person_id}` | As `get_person` |

Failures are `{"error": {"code", "message"}}` with a status: 400 `invalid_input`/`missing_header`, 401 no or bad
secret, 402 `cost_limit_exceeded`, 404 `not_found`, 429 `spend_limit_reached`/`rate_limited`, 502 provider errors.

## Spend limits

When the server's own `OPENROUTER_API_KEY` pays (the caller sent no `X-OpenRouter-Api-Key`), each paid call is
charged to the caller's person. Once today's or this month's total (UTC) reaches `PERSON_DAILY_LIMIT_USD` or
`PERSON_MONTHLY_LIMIT_USD`, their paid tools answer `spend_limit_reached` without any model call, until the day or
month turns. 0 means no limit. Calls on the caller's own key do not count. Totals are kept in
`DATA_DIR/spend/<person_id>.json` and survive deleting the profile.

Errors return `isError: true` with `{"error": {"code", "message"}}`. Codes: `invalid_input`, `not_found`,
`missing_secret`, `missing_header`, `cost_limit_exceeded`, `spend_limit_reached`, `invalid_api_key`, `insufficient_credits`,
`key_forbidden`, `rate_limited`, `llm_unavailable`, `llm_invalid_output`, `config_error`, `internal_error`.

## Storage

`DATA_DIR/people/<person_id>/`:

- `entries.json`: what the person added (`entry_id`, `kind` text|link, `value`, `added`)
- `profile.json`: the last save (model profile, rendered profile, links, their texts, entries hash, `saved_at`)
- `embedding.npy`: the saved profile's vector

The search index is rebuilt in memory when any `profile.json` or `embedding.npy` changes.

## Limits (settings)

`MAX_ENTRIES` 100 per person, `MAX_TEXT_CHARS` 4000 per text, `MAX_LINK_CHARS` 500, `PAGE_SIZE` 10. Links must be
http(s); a bare `asha.dev` becomes `https://asha.dev`.
