# agent

A Cloudflare Agent built on the [Agents SDK](https://developers.cloudflare.com/agents/).
**One Durable Object instance = one agent session.** The session id is the instance name
in the URL, so `/agents/session-agent/alice` and `/agents/session-agent/bob` are two
isolated DOs with their own SQLite database and message history.

Models are served through OpenRouter. Which model a new agent starts on, and which
models an agent may be switched *between*, are the `default_model` and `models`
deployment settings below — a JSON array of `{ "id", "label", "vision" }`. `vision` is
false for a model that cannot be sent an image, and leaving it out means it can; it is
the one thing that cannot be looked up, and getting it wrong means a photo fails at the
provider instead of at the upload.

Meta settings may go further and name any OpenRouter id at all, with its own answer to
the same question — see the model list in that dialog.

## Deployment settings

Every ceiling this Worker enforces and every value an agent starts out holding lives in
one document the owner edits at runtime — no deploy, no release. Sessions per agent,
file storage per agent, addresses per access list, agents per account, the per-kind
upload ceilings, tool rounds per turn, page sizes, the voice-note length; and on the
soft side the model catalogue, the model a new agent is seeded with, the line every
agent is told first, the starting value of each tuning and capability column, the model
menus the image, transcription and voice fields offer, and which MCP providers the
capabilities page shows.

Three of them are enforced in the browser rather than here — files per message, the size
an image is re-encoded to, how long a take may run — so `/api/agents/:id/config` hands
them to the composer instead of the page holding its own copy. A browser that refuses at
its own number and a Worker that refuses at the deployment's are two limits that drift,
and the browser's is the one the user meets first.

It lives in `AgentDirectory`, is defined in `src/settings.ts`, and is reached over
`/api/admin/settings` — or, in practice, from the `admin-cli` dashboard's **Defaults**
and **Limits** tabs (`enter` to edit a row, `d` to set it to the shipped value).

Every field is required. The Worker has no values of its own to fall back on: until the
stored document is complete it answers every request except `/api/admin/settings` and
`/api/admin/stats` with a 503 saying `Deployment is missing default settings` (the UI
shows it as is; the unset fields are listed by `admin-cli check`), and `npm run deploy`
refuses while the live deployment is in that state. The values a deployment starts from
ship with the admin CLI, in `admin-cli/defaults.json`:

```bash
cd admin-cli
npm run init      # write the shipped default for every field not yet set
npm run check     # exit 1, naming them, if any field is unset (what the deploy runs)
```

Both take `-- --staging` / `-- --dev`. `npm run deploy` runs `init` right after
`wrangler deploy`, which covers the two cases a pre-deploy check cannot: a release that
adds a setting (the live Worker refuses unknown keys, so it cannot be set beforehand),
and the first deploy onto a Worker that predates settings altogether — `check` exits 2
for that one and the preflight lets it through.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # optional: holds API_SECRET, the admin key
npm install
npm run dev                       # wrangler dev on http://localhost:8787
```

A fresh local database has no deployment settings, so every request returns 503 until
they are written. With `npm run dev` running:

```bash
cd ../admin-cli && npm run init -- --dev
```

Every agent needs an OpenRouter key of its own, pasted under **Settings**, and there is
no deployment-wide fallback to stand in for it. One agent's spend and rate limits are
its own, and an agent with no key says so instead of answering. That is deliberate: a
fallback would mean any agent anyone creates here spends the deployment's own credit.

Attachment bytes (images, voice-note clips) live in R2, not in the session's SQLite.
Create the bucket once before deploying — `wrangler dev` simulates it locally:

```bash
wrangler r2 bucket create salt-agent-files
```

Objects are keyed `<session-id>/<attachment-id>`, and a session reset or delete drops
them. Rows written before the move still carry an inline data URL and are served from
there.

## Send a message

```bash
node scripts/chat.mjs my-session "what is a durable object?"
```

Or with curl:

```bash
curl -X POST http://localhost:8787/agents/session-agent/my-session/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what is a durable object?"}'
```

## Routes

| Route | What it does |
|---|---|
| `POST /agents/session-agent/:id/chat` | Send a message, get a reply |
| `POST /agents/session-agent/:id/stream` | Send a message, get an SSE token stream |
| `GET  /agents/session-agent/:id/messages` | One page of transcript, newest last, with per-message tokens and cost. `?limit` (default 30, max 200) and `?before=<message id>` walk backwards |
| `GET  /agents/session-agent/:id/summary` | Message count and total LLM spend |
| `POST /agents/session-agent/:id/reset` | Wipe the session |
| `POST /agents/session-agent/:id/unstick` | Free a session whose turns stopped completing, keeping its transcript |
| `GET  /agents/session-agent/:id/live` | Whether a reply is still in flight, for a browser that reloaded mid-stream |
| `GET\|POST /agents/session-agent/:id/files` | List pending attachments / upload one |
| `GET\|DELETE /agents/session-agent/:id/files/:fileId` | Image bytes / drop a pending attachment |
| `GET /agents/session-agent/:id/tasks` | Tasks this session scheduled |
| `DELETE /agents/session-agent/:id/tasks/:taskId` | Cancel one |
| `GET\|POST /api/agents` | List / create agents — `{ name, openrouter_api_key?, allowed_emails? }`, and a key that OpenRouter rejects is a 400 that creates nothing. `GET` lists only what the caller may open |
| `GET\|PATCH\|DELETE /api/agents/:agentId` | Read / rename / delete an agent and everything it owns. `PATCH` takes `{ name?, allowed_emails? }` |
| `GET\|PATCH /api/agents/:agentId/config` | That agent's settings, capabilities and their metadata |
| `GET\|PATCH\|POST /api/agents/:agentId/meta` | The admin's meta settings: defaults and which of them users may change. `POST` re-applies them. Admin only |
| `GET\|POST /api/agents/:agentId/mcp` | That agent's MCP servers |
| `GET /api/agents/:agentId/telegram/status` | Ask Telegram why the bot is or is not answering |
| `GET /api/agents/catalog` | The model and MCP catalogues the create dialog picks from |
| `GET\|POST /api/agents/:agentId/sessions` | List / create that agent's sessions. GET takes `?limit` (default 30, max 200) and `?cursor`, and answers `{ sessions, has_more, cursor }` |
| `PATCH\|DELETE /api/sessions/:sessionId` | Rename / delete a session |
| `POST /api/sessions/:sessionId/fork` | New session seeded with the first `count` messages of this one |
| `POST /api/sessions/:sessionId/unstick` | Same as the session route above, behind the agent's access list |
| `GET\|PATCH /api/fleets/:fleetId` | A fleet's settings, with the catalogues its dialog picks from. Fleet admin only |
| `POST /api/fleets/:fleetId/agents` | Add agents to a fleet, one per address |
| `DELETE /api/agents?fleet=:fleetId` | Delete a fleet's agents, a page at a time. Fleet admin only |
| `POST /api/business-requests` | A signed-in account asks for a higher agent limit |
| `POST /telegram/webhook/:agentId` | One route per agent, because one bot per agent |
| `GET\|POST /whatsapp/webhook/:agentId` | WhatsApp's subscription handshake (`GET`) and deliveries (`POST`) |
| `POST /searxng/:agentId/url` | salts-tools reports its tunnel address. Bearer token must match the agent's SearXNG token |
| `POST /searxng/:agentId/mcp` | salts-tools points the agent's MCP server `{ name }` at its tunnel `{ url }`: creates it with `Authorization: Bearer <token>`, or repoints one whose Authorization is already that token (409 otherwise). Same token proof |
| `GET /api/mcp/oauth/callback` | Where an MCP provider's OAuth sends the browser back |
| `GET /api/admin/settings` | The stored settings and what they still lack: `{ settings, missing, fields }`. Owner only, via `API_SECRET` |
| `PATCH /api/admin/settings` | Merge a patch: `{ <field>: value }`. No field can be unset. Owner only |
| `GET /api/admin/stats` | Deployment counts. Owner only |
| `GET /api/admin/users[/:email]` | Every address, paged and searchable, or one address with its limit and agents. Owner only |
| `POST /api/admin/business-account` | Set an account's agent limit: `{ email, agent_limit }`. Owner only |
| `GET /api/admin/business-requests`, `POST …/:id/approve`, `DELETE …/:id` | The queue of limit requests. Owner only |

## Agents

An agent is a bot, its settings, its tools and its conversations. Agents share nothing:
each has its own OpenRouter key, its own Telegram bot and WhatsApp number, its own MCP
servers, its own memories and its own sessions. Traffic to one never queues behind another.

That falls out of the object layout. Durable Object namespaces cannot be enumerated —
you can address an instance by name but not ask which instances exist — so there are
three layers of index:

- **`AgentDirectory`**, one well-known object, holding the list of agents. Names only.
- **`SessionRegistry`**, one per agent, holding everything that agent *is*: settings,
  credentials, MCP servers, memories, and the index of its sessions.
- **`SessionAgent`**, one per conversation, holding a transcript and its files.

`SessionAgent` is a single namespace for the whole Worker, so a session id carries the
agent that owns it: `<agentId>~<local>`. Two agents in the same Telegram chat would
otherwise both want `tg-123` and land on the same object. The prefix is also how a
session finds its agent — a Durable Object knows nothing about itself but its own name.

Every `/agents/session-agent/:sessionId/...` route therefore takes that whole prefixed
id, and needs no agent of its own in the path.

A **fleet** is a set of agents one address (the fleet admin) creates for other people,
one per address. The fleet holds a meta-settings document of its own, and each of its
agents gets a copy at creation and at every apply after that. The admin decides the
defaults and which of them users may change, but cannot open a user's agent.

## Who can open an agent

Each agent carries a list of email addresses in `AgentDirectory`. Everyone on it gets
the whole agent — its chats, its settings and its keys — so it is a list of owners, not
of guests.

At creation the list is exactly what was asked for: nothing is added to it, so an agent
created without your own address on it is one you cannot open. The create dialog puts
your address in the box for you, which makes leaving it out a deliberate act rather
than an oversight. Editing the list afterwards is different — the editor is kept on it,
because removing yourself would hand the agent to the remaining addresses and lock you
out of the page that could undo it. Either way the list may not end up empty: an agent
nobody is on is one nobody can get back into.

There is one way to be somebody here.

**A Clerk session token**, sent as `authorization: Bearer <token>`. The Worker verifies
its signature against Clerk's published keys and takes the address out of the verified
claims, so it is an address Clerk vouched for rather than one the caller typed. This is
the only identity a normal user of the app ever has, and it is the gate: everything
under `/api` and `/agents` refuses a caller it cannot identify.

**`x-api-secret`** opens the owner's admin routes (`/api/admin/*` and the other
owner-only operations). It names nobody: an `x-user-email` header is ignored, with or
without the secret, so the secret cannot be used to act as a user. Leave it unset and
the admin routes are closed.

An address not on an agent's access list is told the agent does not exist rather than
that it may not have it, however it was arrived at. Session routes are covered by the
same list — a session id names its agent.

`CLERK_ISSUER` is the exact `iss` your tokens carry —
`https://<subdomain>.clerk.accounts.dev` on a development instance,
`https://clerk.<your-domain>` on a production one. It is a public URL and the key set
under it is public too, so it is a plain `var` in `wrangler.jsonc` rather than a secret,
and the same value serves `wrangler dev` and a deploy because both sign in against the
same Clerk instance. The key set is fetched from `/.well-known/jwks.json` under it and
cached for the life of the isolate, with a 30s floor between refetches, and every
verified token is cached by hash until its own `exp`, so a stream that reconnects a
hundred times costs one signature check.

**The token has to carry the user's address, and Clerk does not put it there by
default.** This instance has a customised session token — Clerk dashboard → Sessions →
Customize session token — adding:

```json
{ "email": "{{user.primary_email_address}}" }
```

Without that claim the signature still verifies but there is no address in it, so the
caller is nobody and the call is refused. The claim is instance-wide configuration and
lives in the Clerk dashboard, not in this repo, so a new Clerk instance needs it added
by hand. The alternative is a JWT template that emits the same claim, named on the
frontend in `CLERK_JWT_TEMPLATE`.

## The Worker refuses to run unconfigured

`CLERK_ISSUER` has no unset case. A Worker without it does not serve a weaker version of
the API — it returns 503 to every request, naming what is missing, before it looks at
the method or the path. See `unconfigured()` in [src/server.ts](src/server.ts).

The reason is that it is what makes ordinary sign-in work at all. With no issuer no
signature can be checked, so no Clerk user can be identified and nobody could sign in.
Refusing to start is better than that.

`API_SECRET` is deliberately **not** required. It only opens the admin routes, and a
deployment without one simply has them closed.

Two layers, because the one that matters is the version that is already live:

- **`npm run deploy`** runs [scripts/preflight.mjs](scripts/preflight.mjs) first, which
  refuses if `CLERK_ISSUER` is missing or if it could not check at all, and says out
  whether `API_SECRET` is set, i.e. whether the admin routes are open. Secrets are listable but not readable, which is all this needs.
- **The Worker itself** refuses to serve, so a deploy made by running `wrangler deploy`
  directly still fails closed.

The same two layers apply to the [deployment settings](#deployment-settings): the
preflight runs `admin-cli check` and refuses while any setting is unset (exit 2, a live
Worker older than the settings route, is let through once), and the Worker returns 503
with `Deployment is missing default settings` until they are written. `npm run deploy` runs `admin-cli
init` after `wrangler deploy`. The root [README](../README.md#deployment-settings) has
the full sequence.

Set the admin key with `wrangler secret put API_SECRET`, or in `agent/.dev.vars` for
`wrangler dev`. The frontend does not hold it; `admin-cli` does.

Two routes are deliberately outside all of this:

- `POST /telegram/webhook/:agentId` — Telegram proves itself with the per-bot secret
  token it echoes back, and per-chat access is the bot's own whitelists.
- `GET /api/mcp/oauth/callback` — arrives from the provider's browser, carrying a state
  token instead of a header.

## Commands

A message that is nothing but a bang command is handled before a turn starts, the same
in the browser, Telegram and WhatsApp: `!new`, `!clear`, `!delete`, `!stop`, `!unstick`,
`!compact`, and `!enable-mcp <name>` / `!disable-mcp <name>`. See
[`src/commands.ts`](src/commands.ts).

## Capabilities

Capabilities are what the agent can *do* beyond writing text. Each one is switched on
under **Capabilities** in the frontend, and starts at the value in the `config_defaults`
deployment setting. The metadata in [`src/capabilities.ts`](src/capabilities.ts) is what
that page renders, so a new capability needs no frontend change.

| Capability | Needs | Tools |
|---|---|---|
| Web search | Brave Search API key, or a SearXNG URL and token (see [salts-tools](../salts-tools/README.md)) | `web_search` |
| Read a URL | — | `fetch_url` |
| File ingest | — | — |
| Image input | a multimodal model | — |
| Image generation | an OpenRouter image model | `generate_image` |
| Audio input | a transcription model | `transcribe_audio` |
| Voice notes | a voice model; Telegram or WhatsApp | `send_voice_note` |
| Schedule tasks | — | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` |
| Telegram | bot token and username, whitelists | — |
| WhatsApp | a Meta app and number ([docs/whatsapp-setup.md](../docs/whatsapp-setup.md)) | — |
| MCP servers | the server's URL, or a catalogue template | the server's own |
| Private Memory | — | `remember`, `recall` |

**Tool capabilities** hand the model functions it may call. A turn runs up to `max_tool_rounds`
tool rounds (a deployment setting) — call, run, feed the results back — before it must answer, on both the streaming
and non-streaming paths. **Input capabilities** change what a turn may carry in: text
files are inlined into the message, images become `image_url` parts, and audio is
transcribed by the `transcribe_audio` tool when the words matter, with the transcript
cached so the model only ever sees text.

Memory is agent-wide rather than per session, and never shared between agents: a fact worth keeping ("I use pnpm") is worth
keeping in the next session too. Recent memories are injected into the system prompt, so
the model can use what it knows without spending a round trip to discover that it knows
it.

MCP servers are the one capability the owner normally builds out themselves, and meta
settings can take that back: `mcp.user_servers` decides whether the capabilities page
may add a server, rename one, repoint one or remove one. Off leaves the list to the meta
dialog — the owner can still switch a server off, choose which of its tools the agent
may call and approve its OAuth, because that is using what they were given rather than
changing what it is. The Worker refuses the difference on `/api/agents/:agentId/mcp`;
the meta dialog passes `?meta=1` to say the call is coming from the page that owns the
setting, the same bypass a locked config column gets on the meta route.

Scheduled tasks use the Agents SDK's own scheduling (`schedule`/`getSchedules`), so they
survive eviction. A scheduled turn writes into the transcript like any other, and bills
like any other: the object wakes up to run it.

**API keys are stored in the registry's SQLite in plain text.** They are redacted on the
way out — a saved key reads back as `••••••••`, and sending that mask back means "leave
it alone" — but anyone with access to the Durable Object can read them. Move them to
Worker secrets or an encrypted store before this handles anyone else's keys.

## Costs

Token cost is reported per message, because OpenRouter returns it in the response.

**Cloudflare's costs are deliberately not measured here.** Counting your own requests and
wall clock from inside a Durable Object gives the wrong answer and costs a row write per
request to maintain. Cloudflare's GraphQL Analytics API reports the units it actually
bills.

See [docs/cloudflare-durable-object-costs.md](../docs/cloudflare-durable-object-costs.md)
for what each charge means, the exact queries and field names, and the traps — the
key-value field names that silently return zero on SQLite-backed objects being the worst.
