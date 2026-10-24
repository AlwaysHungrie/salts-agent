# devcon-humans frontend

Single-page Next.js app over the salts agent and the find-humans MCP server (`../mcp-server`). Users sign in with
their Devcon ticket's `.pkpass` and chat, text only, with an agent of their own that can search the directory and
edit their own profile in it. Data lives in a local MongoDB.

## Run

```sh
brew services start mongodb-community   # or any mongod on 127.0.0.1:27017
cp .env.example .env.local              # fill in every value
pnpm install
pnpm dev                                # http://localhost:3200
```

Before the first run, create the fleet the users' agents live in, from the salts web app: sign in, create a
fleet (any one address will do for its first agent), set its OpenRouter key, then in its **Fleet Settings** under
**Fleet API key** click **Generate** and put the key in `FLEET_API_KEY`.

The find-humans server must be reachable over https by the Worker (`FIND_HUMANS_MCP_URL`, e.g. a tunnel to
`MCP_TRANSPORT=http uv run find-humans-mcp`), with `FIND_HUMANS_SIGNING_KEY` as its `SECRET_SIGNING_KEY` and its
own `OPENROUTER_API_KEY`.

## Behaviour

- **Badge pickup** (`POST /api/badge`): the matchmaker's `.pkpass` check, unchanged. The user id is `dc-` + a
  SHA-256 of pass type and serial; the name is the ticket's email before the `@`. The email is stored: the user's
  agent is found by it. Sets the `devcon_humans_session` cookie (HS256 JWT). The pass itself is never stored.
- **One fleet agent per user**, set up the first time their chat opens, behind a "Getting your agent ready"
  screen: with `FLEET_API_KEY`, the fleet's agent for the ticket's email is looked up
  (`GET /api/fleets/:id/agents?email=`) and added if there is none (`POST /api/fleets/:id/agents`). The fleet key
  then issues the agent's admin key, which makes sure the agent has the find-humans MCP server with one header,
  an `X-Find-Humans-Secret` minted for it (a random 32-byte id signed with `FIND_HUMANS_SIGNING_KEY`, not stored
  here; an agent that already has a secret keeps its id), and its user key, which is kept. Any other header on
  that server is dropped: the agent's member can read and redirect its headers, so it holds nothing shared. Set-up is locked per user for 60 s; a second tab waits for it.
- **Chat** (`/api/chat`): `PUT` starts a new session on the user's agent and deletes the previous one; the page
  calls it every time it opens and on "New chat", so nothing carries over between visits. `POST { message }`
  streams the reply as server-sent events. Messages over 4000 characters, or with any line starting `!word` or
  `/word`, are refused.
- **Admin mode** (`POST /api/admin/session { email }`): off unless `HUMANS_ADMIN_KEY` (32+ characters) is set.
  A browser whose local storage has `HUMANS_ADMIN_KEY` set to the same value (`localStorage.setItem("HUMANS_ADMIN_KEY", "…")`
  in the console) shows a "sign in as" field under the badge. The key goes in the `x-humans-admin-key` header; a
  wrong key answers 404. The session is that email's user (the latest one, if several tickets share it), so the
  chat reaches their own agent with their user key and find-humans secret. An email with no user yet becomes one,
  id `dc-email-` + SHA-256 of the email, its agent found or added in the fleet by email as on first pickup.
- Every chat write needs the session cookie and must come from this origin. Agent errors are logged, never relayed.

## Collection

| Collection | Fields |
| --- | --- |
| `users` | `userId` (unique), `name`, `email`, `createdAt`, `lastSeenAt`, `agentId`, `userKey`, `sessionId`, `provisioningUntil` (during set-up) |

## Checks

```sh
pnpm test && pnpm typecheck && pnpm lint
```
