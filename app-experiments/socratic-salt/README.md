# socratic-salt

A Next.js app for position-arguing agents. Anyone signed in can create a challenge:
an agent with a brief, a public page, an OpenRouter key and a few tools. The people
the creator lets in try to change its mind.

It runs on the same Worker as `frontend/` (`agent/`), with the same Clerk sign-in.
The browser never talks to the Worker; this server forwards the signed-in user's Clerk
token, and the Worker decides what they may reach.

## How it maps onto the Worker

| socratic-salt | Worker |
|---|---|
| Challenge | An agent created with `metadata: { app: "socratic-salt" }`. Listed with `?with=app:socratic-salt`; `frontend/` lists `?without=app` |
| Creator | The agent's admin (and only member). Edits everything through meta settings |
| Public notes / private notes | `public_notes` / `private_notes` on the agent's config. Private goes into the system prompt; public is shown to challengers and also given to the model |
| Challenger whitelist | The agent's guests: `PATCH /api/agents/:id { guests, guest_emails }`. On with an empty list means anyone signed in |
| A challenger's conversation | A session they own. Guests reach only their own sessions, and only to converse (stream, messages, delete) |
| Conversations page | The creator's session list, with each session's `owner_email`; read-only in the UI |

A challenge is text, web search, reading URLs and MCP. Memory, files, images, audio,
scheduled tasks and messaging channels are switched off at creation. Memory is shared
by every session of an agent, so one challenger could otherwise plant facts for the next.

## Pages

| Route | Who | What |
|---|---|---|
| `/` | Everyone | Sign in; then "Open to you" and "Your challenges" |
| `/new` | Signed in | Name a challenge; counts against your agent limit |
| `/c/:id` | Creator, guests | The brief and the debate |
| `/c/:id/settings` | Creator | Name, notes, whitelist, key, model, spend limit, web search (SearXNG/Brave), URL reading, MCP servers, delete |
| `/c/:id/conversations` | Creator | Every challenger's conversation, read-only |

## Run it

```bash
cp .env.example .env.local   # fill in AGENT_URL and the Clerk keys from frontend/
pnpm install
pnpm dev                     # http://localhost:3100
```

For a local Worker, set `AGENT_URL=http://localhost:8787` (or wherever `wrangler dev`
runs). The same `localStorage.API_SECRET` / `API_EMAIL` back door as `frontend/`
works for the chat routes.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Dev server on port 3100 |
| `pnpm build` | Production build |
| `pnpm test` | Unit tests (vitest) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
