# frontend

The Salts web app: sign-in, the agent list, chat, settings, capabilities, fleets, and the
user guide. Next.js 16 (App Router), Clerk, AI SDK. It is a thin shell over the agent
Worker in [`../agent`](../agent/README.md), which holds every piece of data.

## Run it

```bash
cp .env.example .env.local   # then add the Clerk keys
pnpm install
pnpm dev                     # http://localhost:3000, against AGENT_URL
pnpm dev:local               # same, against LOCALHOST_AGENT_URL (a local `wrangler dev`)
```

This package uses pnpm. The agent Worker uses npm.

`.env.local` holds:

- `AGENT_URL`: the Worker every route handler forwards to.
- `LOCALHOST_AGENT_URL`: used instead when `USE_LOCAL_AGENT=true`, which `pnpm dev:local` sets.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`: from the Clerk dashboard.
- `CLERK_JWT_TEMPLATE`: only if your Clerk session token has no `email` claim.

It holds no shared secret. The Worker identifies a caller by the Clerk session token this
app forwards. The Worker's `API_SECRET` back door is read from one browser's
localStorage, never from this app. See the root [README](../README.md#run-it).

## How it talks to the Worker

The browser never calls the Worker. Every request goes to a route handler under
`src/app/api/`, which forwards it with the caller's identity (`src/lib/upstream.ts`,
`src/lib/proxy.ts`). There is no CORS and no key in the browser.

`src/proxy.ts` is Next 16's middleware. It establishes the Clerk session and does not
protect routes: the pages are shells, and the Worker refuses any request it cannot
identify.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Every agent the caller may open, and the fleets they administer |
| `/a/:agentId` | Chat, with the session sidebar |
| `/a/:agentId/settings` | Model, instructions, reasoning, temperature, reply cap, context window |
| `/a/:agentId/capabilities` | Tools, channels (Telegram, WhatsApp) and MCP servers |
| `/guide`, `/guide/:slug` | The user guide |
| `/sign-in`, `/sign-up`, `/sso-callback` | Clerk |

## The user guide

Pages are Markdown in `content/guide/`, one file per page. The front matter sets
`title`, `section`, `order`, `summary` and `featured`. Adding a file adds the page; the
search index at `/guide/search-index.json` is built from the same files.

## Design

`DESIGN.md` is the design system: monochrome ink on white, pill-shaped controls, one
accent blue. The landing page mirrors its tokens.

## Deploy

Vercel project `salts-agent-app`. Merging to `main` deploys production, and pushing to
the `staging` branch deploys staging. Environment variables are managed in Terraform, see
[docs/infra.md](../docs/infra.md).
