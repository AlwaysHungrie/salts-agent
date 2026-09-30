# Architecture

How this project is put together, for someone who has just cloned it and has never
deployed anything to Cloudflare. It starts with the platform, because every structural
decision here is downstream of what Cloudflare's primitives can and cannot do, and ends
with the one object in the design that cannot be scaled horizontally.

---

## Two deployables

There are exactly two things that get deployed, and they do not share a process, a
runtime or a repository directory.

**`frontend/`** is a Next.js app, managed with pnpm. It renders every page the user sees
and holds the Clerk session. It never talks to the agent from the browser.

**`agent/`** is a Cloudflare Worker, deployed with `wrangler`. It is the whole backend:
the HTTP API, the storage, the model calls, the Telegram bot, the MCP clients. It has no
UI at all — hitting `/` on it returns a JSON list of its own routes.

The split is not layered in the usual sense. The frontend's `/api/*` route handlers are
thin proxies and nothing more: [proxy.ts](../frontend/src/lib/proxy.ts) forwards the path
to `AGENT_URL`, hands the Worker's response body back with the status unchanged, and
turns a connection failure into a readable JSON 502 instead of an empty error body. There
is no business logic on the Next side.

The proxy layer exists for one reason: **it is where a signed-in user becomes
authority.** [upstream.ts](../frontend/src/lib/upstream.ts) reads the Clerk session on
the server — the module is marked `server-only` so a client component cannot import it —
and forwards the session token to the Worker as `authorization: Bearer <token>`.

That token is the whole credential. **This app holds no shared secret.** There is no
`API_SECRET` in the frontend's environment and nothing for its deploy to leak: the
Worker verifies the token's signature against Clerk's published keys, so the address it
acts on is one Clerk vouched for rather than one this app asserted.

The address is in the token because the Clerk instance was configured to put it there.
Clerk's default session token does not carry an email; this one does, through a
customised session token (Clerk dashboard → Sessions → Customize session token) that
adds `"email": "{{user.primary_email_address}}"`. That configuration lives in the Clerk
dashboard, not in this repo, and a new Clerk instance will not have it — without the
claim the signature verifies, the address comes back empty, and the caller is nobody.

Verification is cached twice over, because it runs on every message, every stream frame
and every thumbnail. The JWKS object is built once per issuer per isolate and refetches
at most every 30 seconds however many unknown-key tokens arrive; each verified token is
then cached by SHA-256 hash until its own `exp`, capped at 500 entries and pruned on
insert, with failures held for 30 seconds so a client retrying a stale token cannot turn
its retries into key lookups. The steady state is a map lookup, not a public-key
operation. See [clerk.ts](../agent/src/clerk.ts).

### API_SECRET

`API_SECRET`, sent as `x-api-secret`, opens the owner's admin routes. It names nobody:
the Worker ignores `x-user-email`, with or without the secret, so the only way to act as
a user is that user's Clerk token.

Two consequences worth stating plainly:

- **The Worker's gate is identity, not origin.** Anyone who can obtain a valid token
  from this Clerk instance can reach the API. Agent access lists still decide what they
  see — an address not on one is told the agent does not exist — but creating agents is
  open to any signed-up user. What that costs is bounded: there is no deployment-wide
  OpenRouter key, so an agent someone else makes spends their key or does not answer.
  Closing Clerk sign-up is what bounds the rest.
- **The middleware no longer protects routes.** [proxy.ts](../frontend/src/proxy.ts)
  establishes the Clerk session and stops. The pages are shells; the gate was always on
  the other side of `AGENT_URL`. What replaces it, for the visitor rather than for the data, is `useIdentity()` — the
  home page draws the front door, and [the agent
  layout](../frontend/src/app/a/[agentId]/layout.tsx) says so and stops. Nothing
  redirects: a page that navigates away on its own takes its own explanation with it,
  so the way out is a button instead. An agent that does not exist, or is not yours,
  is the same sentence — the Worker answers all three cases with a 404 so that an id
  cannot be probed for existence.

**A Worker without `CLERK_ISSUER` does not run.** There is no unset case: `unconfigured()`
in [server.ts](../agent/src/server.ts) is checked at the top of `fetch`, before CORS and
before routing, and returns 503 naming what is missing. Without an issuer no signature
can be checked and no Clerk user can be identified, so nobody could sign in — worth
refusing to start over. `API_SECRET` is deliberately not required; a deployment without
one has its admin routes closed.

The deploy is guarded ahead of that: `npm run deploy` runs
[scripts/preflight.mjs](../agent/scripts/preflight.mjs), which refuses when
`CLERK_ISSUER` is missing or when it could not check at all — a preflight that passes on
"unknown" is worse than none — and says whether `API_SECRET` (the admin routes) is set
on the deployment it is about to ship to.

Two Worker routes sit outside all of this on purpose. `POST /telegram/webhook/:agentId`
authenticates with a per-bot secret token that Telegram echoes back, derived by SHA-256
from the bot token itself so there is nothing extra to store. `GET /api/mcp/oauth/callback`
arrives from a provider's browser redirect and carries a state token instead of a header;
it is matched before the secret gate for exactly that reason.

---

## The Cloudflare primitives, in plain terms

Three products carry this whole system. If you already know them, skip to the next
section.

**A Worker** is a function that runs on Cloudflare's edge in response to an HTTP request.
It is stateless and short-lived: it starts, handles one request, and goes away. Many
copies run at once, in whichever datacenter is closest to the caller, and no two of them
can see each other. It cannot hold anything between requests — no in-memory cache you can
rely on, no local disk. Here, the Worker is [server.ts](../agent/src/server.ts): it routes,
it checks the two headers, and it forwards the work to something that *can* hold state.

**A Durable Object (DO)** is the thing that can. A DO class is instantiated by *name*, and
Cloudflare guarantees that for a given name there is exactly one live instance in the
world at a time, in one datacenter, running one JavaScript thread. Ask for the object
named `root` from ten Workers in ten countries and all ten calls land on the same object.
Each instance gets its own private SQLite database — a real embedded database with tables
and indexes and transactions, not a key-value bag. Because there is only ever one
instance, serialization is free: two concurrent writers cannot race, and you never need a
lock.

The word *durable* means the object and its storage survive being evicted from memory. An
idle object is hibernated; the next request wakes it and its SQLite is still there. It
also means a DO namespace can be **addressed but not enumerated** — you can ask for the
object named `alice`, but you cannot ask "which objects exist?". That single limitation is
the reason two of the three DO classes below exist at all.

DOs are *not* strictly serial. They are ordinary JavaScript, so `await` yields and a
second request can interleave while the first is waiting on the network; Cloudflare's
input and output gating is what keeps storage consistent across those interleavings. One
thread, not one request at a time.

**R2** is object storage — a bucket you put blobs in and get blobs out of, addressed by
key, priced for bulk, with no query language. It is where bytes go when they are too big
to want in a SQLite row. Here that is `salt-agent-files`, bound as `FILES` in
[wrangler.jsonc](../agent/wrangler.jsonc).

The bindings in [wrangler.jsonc](../agent/wrangler.jsonc) are how the Worker reaches any of
this: three DO namespaces (`SessionAgent`, `SessionRegistry`, `AgentDirectory`), one R2
bucket, and a plain `var` for `CLERK_ISSUER`. The model catalogue and every other
ceiling and default are runtime deployment settings, not `vars`. The `migrations` array there is Cloudflare's own class-registration mechanism
— `new_sqlite_classes` tells the platform a class exists and is SQLite-backed. It has
nothing to do with table schemas; those are handled separately, and the difference matters
later.

---

## The three Durable Object classes

Each class answers a question the layer below it cannot.

### AgentDirectory — one object, named `root`

There is exactly one instance of this class in the entire deployment:
`env.AgentDirectory.get(env.AgentDirectory.idFromName("root"))`. It holds the index of
which agents exist.

It exists *only* because a DO namespace cannot be enumerated. "List the agents" is not a
question the platform can answer, so the answer has to be written down somewhere, and
somewhere has to be one agreed place. It is deliberately thin: an agent's id, name,
timestamps, its access list and its admin. Everything an agent actually *is* lives one
layer down.

Its copy of the access list is a **derived index**, not the authority. It exists so the
home page can answer "which agents may this address open" in one query, and it decides
nothing — see [One authority, one index](#one-authority-one-index).

### SessionRegistry — one per agent

Named by the agent id. This is the agent: its settings and secrets (`config`), the meta
document that decides what its own pages may change (`meta`), its long-lived `memories`,
its `mcp_servers` with their OAuth tokens, the index of its `sessions` — which exists for
the same reason the directory does, one level down — and its `access` table, which is the
authority on who may open the agent at all.

Because it is one object per agent, two agents share nothing. One agent's OpenRouter key
and bot token are unreachable from the other's object, and a burst of traffic to one
queues on its own thread rather than on anybody else's.

### SessionAgent — one per chat session

This is the one that actually runs turns. It extends `Think` from `@cloudflare/think`,
which owns the agentic loop, the transcript, tool execution, streaming and recovery — see
[think-migration.md](think-migration.md) for the division of labour. This class keeps the
four side tables Think has no opinion about (`attachments`, `message_files`,
`message_text`, `usage`) plus `file_cache`, and a workspace — a virtual filesystem the
model reads with its own tools — whose large files spill into R2 under the session's own
key prefix.

`SessionAgent` is a single namespace for the whole Worker, so a session id carries the
agent that owns it: **`<agentId>~<local>`**. Without the prefix, two agents in the same
Telegram chat would both want the session named `tg-123` and would land on the same
object. The prefix is also how a session finds its own agent, since a DO knows nothing
about itself except its own name — `agentIdOf()` splits on the `~` and that is the whole
lookup. It is why every `/agents/session-agent/:sessionId/...` route needs no agent id of
its own in the path.

---

## Where every kind of data lives

| Data | Lives in | Notes |
| --- | --- | --- |
| Which agents exist, names, timestamps | `AgentDirectory` (`agents`) | One object, named `root`. |
| **Who may use an agent — the decision** | `SessionRegistry` (`access.allowed_emails`) | **Authoritative.** Every access check reads this. |
| **Who administers an agent — the decision** | `SessionRegistry` (`access.admin_email`) | **Authoritative.** Written once at creation, never again. |
| Who may use / administer an agent — the index | `AgentDirectory` (`agent_members`, `agents.allowed_emails`, `agents.admin_email`) | Derived. Used by `list()` and by response bodies, never to decide a request. |
| Agent settings, model, prompt, capability flags | `SessionRegistry` (`config`) | One row, `id = 1`. |
| OpenRouter key, Brave key, Telegram bot token | `SessionRegistry` (`config`) | Plain text. See [Known rough edges](#known-rough-edges). |
| The meta document and its locks | `SessionRegistry` (`meta`) | JSON in one row. |
| Memories | `SessionRegistry` (`memories`) | Per agent, not per session — a fact worth keeping is worth keeping next session. |
| MCP servers and their OAuth tokens | `SessionRegistry` (`mcp_servers`) | Credentials never reach the browser; the Worker strips them. |
| The session index for one agent | `SessionRegistry` (`sessions`) | Paged by cursor. |
| Transcript, messages, tool calls | `SessionAgent`, owned by Think | Tree-structured session storage. |
| What the user actually typed | `SessionAgent` (`message_text`) | The stored message also names the files the turn carried; that annotation is for the model. |
| Attachment metadata and message→file links | `SessionAgent` (`attachments`, `message_files`) | |
| Per-message tokens, cost, duration | `SessionAgent` (`usage`) | |
| Attachment bytes, model-written files, PDF page renders | The session workspace, spilling to R2 under the session's key prefix | |
| **User identity, passwords, profiles, sessions** | **Clerk. Not here.** | The only thing this system stores about a person is their email address, as a string, in `allowed_emails` / `agent_members` / `admin_email`. |

That last row is worth dwelling on. There is no users table anywhere in this codebase.
An identity is an email string that Clerk vouched for — in the signature on the session
token the Worker checks, or failing that in the header the frontend forwarded. Nothing
is keyed on a user; everything is keyed on an agent or a session. Access is by address
rather than by account id because an agent is usually shared before the people it is
shared with have signed in — the address is what the owner knows, and Clerk hands the same
address back once they do.

---

## The request lifecycle of a chat message

The path a single message takes, end to end. The chat route is the one frontend route
that does not use `proxy()`: it translates the Worker's SSE frames into the AI SDK's UI
message protocol, so it calls `fetch` itself and adds the same headers by hand.

```
  browser
    │  useChat POST /api/sessions/<agentId>~<local>/chat   { messages, trigger }
    ▼
  Next route handler — frontend/src/app/api/sessions/[id]/chat/route.ts
    │  pulls the last user message's text out of the UI messages
    │  retry? trigger === "regenerate-message"
    │  agentHeaders() → reads Clerk server-side
    │        → authorization: Bearer <session token>
    ▼
  POST {AGENT_URL}/agents/session-agent/<id>/stream   { message, retry }
    │
    ▼
  Worker fetch() — agent/src/server.ts
    │  1. callerEmail() must name somebody, or 401 — no anonymous callers
    │  2. session-route gate: agentIdOf(id) → mayUseAgent()
    │        └── callerEmail() → clerkEmail(): verify the bearer token against
    │              Clerk's JWKS (cached)
    │        └── agentAccess() → SessionRegistry(agentId).access()
    │              the AGENT'S OWN object answers. The directory is not read.
    │              (unwritten access row only: one directory read, then seedAccess())
    │            → emailAllowed(access.allowed_emails, email)
    │            not allowed → 404, never 403
    │  3. ctx.waitUntil(SessionRegistry(agentId).touch(sessionId)   ← exact, sidebar order
    │                   → AgentDirectory.touch(agentId))           ← a no-op unless the
    │                       agent's date is 5+ minutes stale; off the response path
    │                       either way
    │  4. routeAgentRequest(request, env) → the SessionAgent DO named <id>
    ▼
  SessionAgent.onRequest() — agent/src/agent.ts
    │  ensureSchema(); loadConfig()  ← reads its SessionRegistry, per turn, so a
    │                                  settings change takes effect on the next message
    │  streamChat(message, retry)
    │    beforeTurn(): model, system prompt, temperature, reply cap, reasoning
    │                  effort, context window, memories, capability + MCP tools
    │    runTurn({ mode: "stream" }) → Think → OpenRouter
    │      the turn runs against the OBJECT, not against this request; every
    │      event is banked, so a reloading browser can reattach via /live
    │    onEvent → SSE frames: delta / tool / tool_done / usage / done / error
    │    onChatResponse → one `usage` row against the assistant message
    ▼
  SSE back up through the Worker (CORS headers added), streamed, not buffered
    ▼
  bridge() in the Next chat route
    │  delta      → text-delta   (one text part per tool round, in order)
    │  tool/_done → data-tool
    │  usage      → data-usage   (tokens, cost, latency)
    ▼
  useChat renders it
```

The Durable Object stays resident — and billable — for the whole stream, which is why
model latency shows up in the Cloudflare bill as well as the OpenRouter one; see
[cloudflare-durable-object-costs.md](cloudflare-durable-object-costs.md). Pressing stop
cancels the browser's stream, but the turn itself finishes inside Think and the partial
reply is persisted along with the tokens OpenRouter already charged for.

---

## The access model: admin is not membership

Two things carry the word "owner" in most systems. Here they are separate, and they do
not overlap.

**`admin_email`** is the address that created the agent. It is written exactly once, at
creation, and no route anywhere changes it — an agent whose administrator can be handed
over is an agent that can be taken. When the creating call named nobody, it falls back to
the first address on the access list, so an agent is never left without one.

**`allowed_emails`** is who may *use* the agent. Everyone on it gets the whole agent — its
chats, its settings, its keys — so it is a list of owners, not of guests. At creation the
list is exactly what was asked for and the creator is **not** silently appended to it; the
create dialog pre-fills the box with their address, so leaving it out is a deliberate act.
Editing the list later is different: the editor is always kept on it, because removing
yourself would hand the agent to the remaining addresses and lock you out of the only page
that could undo that. Either way the list may not end up empty — an agent nobody is on is
one nobody can reach, including to delete it.

The consequence worth internalising: **an admin who is not on the access list is refused
the agent's pages exactly like a stranger.** `mayUseAgent()` checks `allowed_emails` and
nothing else — it never looks at `admin_email` — so every session route, every stream,
every file operation is closed to an admin who did not put themselves on the list. A
member reaches `/config` and the chats; an admin who is not a member does not, and reaches
`/meta` and `DELETE` instead. A stranger is refused everywhere.

`handleAgents()` in [server.ts](../agent/src/server.ts) computes both flags once and then
gates section by section:

| Route | Who | Why |
| --- | --- | --- |
| `GET /api/agents/:agentId` | Either | The row is what the admin dialog's header shows, and it says nothing an admin does not already know about the agent they made. |
| `PATCH /api/agents/:agentId` (rename, edit access list) | User only | These are settings-page edits. |
| `DELETE /api/agents/:agentId` | **Admin only** | Someone given access to use an agent should not be able to take it from everyone else who was. |
| `/config` | User only | |
| `/meta` | **Admin only** | It decides the defaults and the locks, so a user who could edit it could unlock everything locked away from them. |
| `/mcp` | User only — except `?meta=1` | That one query is the server list inside the admin dialog; connecting a server or approving its OAuth is using the agent. |
| `/sessions` | User only | |
| `/telegram/status` | User only | |
| `/agents/session-agent/:sessionId/*`, `/api/sessions/:sessionId/*` | User only | Gated in `fetch()` before routing, via the agent id embedded in the session name. |

A caller who is neither is refused before any section is reached. The catch-all after the
per-section checks is one line — `if (!isUser && section !== "meta" && section !== "mcp")
return notFound();` — so a section added later is closed to a non-member by default.

Refusals are **404, not 403**, everywhere. An agent you were not given is an agent that
does not exist; a 403 would confirm the id is real.

Neither flag has an escape hatch. There is no deployment where they are both true for
want of an identity to check: a request that named nobody was refused at the top of
`fetch`, so `email` is non-empty by the time this runs.

### One authority, one index

Access data exists in two Durable Objects, and which one is in charge is the single most
important invariant in this system.

**`SessionRegistry.access` is the authority.** One row, `id = 1`, holding
`allowed_emails`, `admin_email` and `seeded`. Every access decision — `mayUseAgent()` for
session routes, `isUser` and `isAdmin` for every section of `handleAgents()` — is taken
from here, through `agentAccess()` in [server.ts](../agent/src/server.ts).

The reason it lives there is the subject of [the single-object limit](#the-single-object-limit):
the registry is one object per agent and scales horizontally, the directory is one object
for the whole deployment and does not. An access check that read the directory would put
every message every user sends through one thread in one datacenter.

**`AgentDirectory`'s `agents` / `agent_members` is a derived index.** It is read by
`list()` to build the home page, and by `handleAgents()` to fill in the name and
timestamps of a response body. **It never decides whether a request is allowed.** Where
the two can disagree, the response body says what the authority says: `handleAgents()`
overlays the registry's `allowed_emails` and `admin_email` onto the directory row before
returning it, so the settings page cannot contradict the gate.

Access lives in its **own table and not in `config`**, and that is deliberate to the point
of being the most important implementation detail here. The `config` row is walked by
`redact()` and `validateConfig()` in the Worker, returned whole by `GET /config`, and
patched by `PATCH /config`. An access column living there would therefore be shipped to
the browser *and* editable by anyone the access list already admits — the gate would be
reachable from the thing it guards, and any member could quietly add themselves as admin
or remove everyone else. A separate table is what makes that structurally impossible
rather than merely unlikely.

`admin_email` immutability is enforced *inside* `setAccess()` rather than trusted to call
sites: a write carrying an admin for an agent that already has one keeps the one it has.
No route moves it in any case, but the rule lives with the data.

### Write order, and which way a failure falls

**No transaction spans two Durable Objects.** Two writes, two round trips, and either can
land without the other. So the order is not a style choice — it decides which way a
partial failure falls.

**Registry first, directory second**, on agent creation and on `PATCH allowed_emails`
(which is a normal, frequent operation: any member may edit the list at any time).

| | Registry first (what the code does) | Directory first (rejected) |
| --- | --- | --- |
| Second write fails | The gate is already correct. A removed address is denied immediately but still sees the agent on their home page until the list is saved again — an entry that 404s when opened. | Struck off the index but **still admitted by the gate**. Somebody keeps access they were meant to lose. |
| Verdict | Cosmetic | A security hole |

On creation, a failure between the two leaves an agent nobody can see and nobody can open:
an orphan object, not a leak.

**`deleteAgent()` is the deliberate exception — the directory row goes *first*.** The
reason is the seeding rule below: `wipe()` leaves the registry's access row unwritten, and
an agent with an unwritten access row asks the directory. Wiping first would let a request
arriving mid-teardown read the directory row that is still there and seed the access list
straight back into the object being destroyed. Removing the name first closes both doors
at once — the gate finds no agent to seed from, and every control-plane route 404s from
that moment on. The bot is unhooked before any of it, because a webhook Telegram keeps
retrying against a 404 is how a deleted agent goes on costing requests.

### An agent whose access row has not been written

An agent can exist in the directory with nothing yet in its registry's `access` table.
`seeded` is the flag that distinguishes the two states that would otherwise look alike:
an agent with a genuinely empty list is `seeded = 1` with `allowed_emails = ''`, and it
denies everyone. `seeded = 0` means nobody has asked yet, not that nobody is allowed.

The first access check on such an agent reads the directory once, calls `seedAccess()` to
adopt that list, and serves from the registry from then on. That agent still admits its
members, still preserves its admin, and still refuses strangers, because the answer it
seeds from is the same list the index was built from. It costs the directory one read per
agent for the life of the deployment, not one per message, and there is no loop over all
agents anywhere — the work is driven entirely by the first request that needs the answer.

`seedAccess()` only ever fills in an agent nobody has written access for; it returns early
on an already-seeded row and never overwrites a decision. It also contains no `await`, so
a Durable Object runs it to completion before a second caller starts — and two concurrent
seeders would be writing byte-identical rows anyway, both having read the same directory
row. The race is benign even where it is visible.

---

## The directory's membership index

Everything in this section is about the **index**, not the gate. Nothing here decides a
request; it exists so that one query can answer "which agents may this address open" for
the home page.

Inside the directory, membership is stored twice, and those two *are* written in one
transaction — they are in the same object, so they can be. `agent_members` is one row per
`(agent_id, email)`, with an index on `email`: it is what makes the listing an index
lookup instead of a walk over every agent in the deployment. `agents.allowed_emails` is
the same list as newline-separated text on the agent row — a denormalized projection, not
a second opinion. `writeMembers()` is the only method that writes either of them and it
writes both inside one `transactionSync`.

Keeping the column is what lets `get()` stay a single-row read with no join, which is the
shape every control-plane response body is built from.

### Why `list()` uses UNION

There are two ways onto an agent's list — you administer it, or you are a member — and the
obvious query is `WHERE admin_email = ? OR EXISTS (SELECT 1 FROM agent_members …)`. That
returns the right rows and is the wrong query: **SQLite cannot use an index for an `OR`
spanning two tables.** It falls back to scanning every agent and running the subquery per
row, which is precisely the walk `agent_members` exists to remove.

Split into a `UNION` of two selects, each half is an index lookup — `idx_agents_admin_email`
for the left, `idx_agent_members_email` for the right. `UNION` rather than `UNION ALL`
because it deduplicates, which is what keeps an admin who is also on the access list from
appearing twice in the list of agents. An admin sees the agent they made whether or not
they may open it, which is why the left half is there at all.

### Why schema work happens on first touch

Cloudflare's `migrations` in `wrangler.jsonc` register DO *classes*; they say nothing about
tables. There is no deploy-time hook that could run SQL against every Durable Object,
because a DO's storage only exists where the object does, and an object that has never
been woken has nowhere for a migration to run. So schema work happens in `ensureSchema()`,
called at the top of every public method and guarded by an in-memory `ready` flag, so it
costs one branch after the first call in an instance's life.

Additive changes are idempotent and need no bookkeeping: `CREATE TABLE IF NOT EXISTS`, and
`ALTER TABLE … ADD COLUMN` wrapped in a `try` that swallows "column already present". The
`admin_email` backfill is in the same category, because "no admin" is a state the data can
express, so re-running it is harmless.

Membership is not in that category, and that is what `schema_version` is for. An agent
with no rows in `agent_members` is indistinguishable from one the table has never been
populated for, and guessing wrong would silently re-add addresses somebody deliberately
removed. So the version number is written down, in its own table, inside the same
transaction as the backfill it guards. The v1 step reads `allowed_emails` and populates
`agent_members` from it; it drops nothing.

The registry's `seeded` flag is the same pattern one object down, for the same reason: a
state the data cannot otherwise express has to be recorded rather than inferred. The
difference is that `schema_version` guards work that runs once inside one object, while
`seeded` guards work that pulls from a *different* object — so it is driven by the first
request that needs the answer rather than by a version number.

---

## The single-object limit

This is the known structural limit of the design, and it is worth reading even if nothing
about it is urgent today.

### The shape of the problem

`AgentDirectory` is **one object**. Not one per tenant, not one per region — one, named
`root`, for the entire deployment. It is single-threaded and it lives in exactly one
datacenter.

### Why Cloudflare cannot scale it away

This is not a configuration problem and there is no flag to set. A Durable Object is
single *by definition* — the singleness **is** the consistency guarantee. The reason you
never need a lock when writing to `agent_members` is the same reason there cannot be a
second copy of the directory: if there were two, they would not be a Durable Object any
more.

Cloudflare scales the *number* of Durable Objects, essentially without limit. It never
scales one. The platform's answer to "this object is too busy" is always "use more
objects", which works beautifully for `SessionRegistry` and `SessionAgent` and not at all
for a singleton index.

DOs do handle requests concurrently — it is JavaScript, so an `await` on a subrequest
yields, and input/output gating is what keeps storage consistent across the interleaving.
So this is not strictly serial, and a slow call does not stall everything behind it. But
it is still one thread, one core's share of one machine, in one place.

### What reaches the directory, and how often

The access check does not: `mayUseAgent()` resolves through `agentAccess()` to the agent's
own `SessionRegistry`, and for an agent whose access row is written, the session path does
not read the directory at all. What does reach it:

| Reaches the directory | How often |
| --- | --- |
| `GET /api/agents` — the home page listing | Once per home page load. One indexed `UNION`. |
| `POST /api/agents` — create | Once per agent ever. |
| `DELETE /api/agents/:agentId` — delete | Once per agent ever. |
| `dir.get()` in `handleAgents()`, to build a response body | Once per `/api/agents/:agentId/*` request — settings pages, not messages. |
| `dir.rename()` / `dir.setAllowedEmails()` on `PATCH /api/agents/:agentId` | Once per rename, once per membership edit. |
| `dir.touch()` on `POST /api/agents/:agentId/sessions` | Once per session created, awaited. |
| `dir.touch()` on `stream` / `chat` | At most one row write per agent per five minutes; a row read that returns early otherwise, and off the response path in `waitUntil`. |
| One read to seed an agent whose access row has not been written | Once per agent, ever. |

So **a chat message costs the directory nothing but a throttled `touch()`** — no read for
the gate, and on all but the first message in any five-minute window that `touch()` is a
single row read that returns without writing.

The remaining exposure is therefore **control-plane and listing traffic, not message
traffic**: a user loads the home page occasionally and opens a settings page rarely, where
they send messages continuously. The ceiling and the single-datacenter latency floor apply
to that traffic. The object is placed near whoever first created it and stays there, so a
user in Sydney whose directory object lives in Frankfurt pays that round trip when they
load the home page or open a settings page — and not when they send a message.

### What to measure

Do not plan against a number from this document. Measure:

1. **Requests per second reaching the directory object**, which Cloudflare's per-object
   analytics will tell you. The DO id is recorded on session rows as `object_id` for
   exactly this kind of attribution — see
   [cloudflare-durable-object-costs.md](cloudflare-durable-object-costs.md).
2. **The ratio of directory hits per user action**, which is the number to watch for
   regressions: roughly zero per message and roughly one per page load. Any change that
   puts a `directory(env)` call on a session route inverts this section, and that is the
   thing to catch in review.

Writes are the expensive half — row writes cost about a thousand times row reads in
Cloudflare's own pricing, a fair proxy for how much more work they are, and a write must
be durably committed where a read can often be served from memory. What the directory
writes is creates, deletes, renames, membership edits and a heavily throttled `touch()`.

Any specific requests-per-second figure you find — including any you might be tempted to
add to this document later — should be checked against current Cloudflare documentation
rather than trusted from a doc. The numbers move.

### The structural option: Postgres behind Hyperdrive

If listing and control-plane traffic ever saturates one object, the remedy is to stop
using a Durable Object for the index at all: **move `AgentDirectory` to Postgres, reached
via Hyperdrive.** A real database can be read from everywhere at once and indexed however
you like.

The tradeoffs are real and should not be glossed. Connection pooling becomes your problem
(Hyperdrive helps; it does not eliminate it), because a Worker is many short-lived
isolates and a Postgres connection is not free. There is added network latency on calls
that are currently an in-process SQLite read. You lose the free serialization a
single-threaded object gives, and inherit transactions and isolation levels as things you
have to think about — `writeMembers()` is one `transactionSync` today precisely because
there is only one writer. And the blast radius changes: data that currently sits in an
isolated object, unreachable from anything else, would sit in one database that one
credential opens.

The blast radius argument is narrower than it looks here, because the directory holds
nothing that decides access. Moving it moves an index; the authority stays distributed
across the per-agent objects, and the per-agent secrets stay where they are. It is still
the largest change available, and the one to justify most carefully.

### What is not affected

`SessionRegistry` and `SessionAgent` do not have this limit and will not develop it. They
are per-entity: one object per agent, one per session. Ten thousand agents are ten
thousand independent objects on ten thousand independent threads, placed near whoever uses
them, sharing nothing. `SessionAgent` never reads the directory at all — it finds its own
agent by splitting its own name and talks only to that agent's registry. The access check
rides that same per-agent object, which is why it scales the same way.

**Only the singleton has this problem.** Everything else scales the way the platform
intends.

---

## Known rough edges

**API keys are stored in plain text.** The OpenRouter key, the Brave key, the Telegram bot
token and MCP OAuth tokens all sit as ordinary text columns in `SessionRegistry`'s SQLite.
They are redacted on the way out — a saved key reads back as a mask, and sending the mask
back means "leave it alone" — so they do not reach the browser, but anyone with access to
the Durable Object can read them. [agent/README.md](../agent/README.md) flags this
explicitly as deliberate for now, with the note that they should move to Worker secrets or
an encrypted store before this handles anyone else's keys.

**The dual-write window is real and unreconciled.** A membership change writes the
registry, then the directory, and nothing spans both. If the second write fails, the two
disagree until someone saves the list again: the gate is correct and the home page is
stale. The window is bounded to a single RPC and always falls in the safe direction (see
[Write order](#write-order-and-which-way-a-failure-falls)), and there is no background
reconciler or repair pass. Adding one is the obvious next step if the window ever proves
to matter.

**Concurrent access-list edits are last-write-wins.** `setAccess()` replaces the whole
list and there is no compare-and-set, so two members saving the page at the same time can
have one edit silently lost — the second save is built on a list read before the first one
landed. Worth knowing given that any member may edit the list at any time.

**`deleteAgent()` is not atomic.** It is a multi-step teardown: unhook the Telegram
webhook, remove the row from the directory, walk every page of the session index
destroying each session object, then wipe the registry. A crash partway through the walk
leaves orphaned `SessionAgent` objects that nothing points at any more — invisible,
unreachable, and still billed for the bytes they store, along with the registry that would
have been wiped last. Nothing retries or sweeps them. The ordering is chosen deliberately
at both ends, but there is no compensating transaction.

**No cross-agent queries are possible.** By construction. Each agent's data lives in its
own Durable Object with its own database, and there is no join across objects. "How many
messages did every agent send this week" cannot be answered without fanning out to every
registry one at a time. The directory holds names and access lists and nothing else, so it
cannot answer it either. This is the price of the isolation that makes agents share
nothing — but it does mean analytics across agents needs a different store, not a cleverer
query.
