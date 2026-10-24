# devcon-humans frontend

Next.js app over the salts agent and the find-humans MCP server (`../mcp-server`). Users sign in with their Devcon
ticket's `.pkpass`, then search the directory through an agent of their own and build their profile in it. Data
lives in a local MongoDB.

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
own `OPENROUTER_API_KEY`. This app also calls its HTTP API (`/api/me`, `/api/me/save`, `/api/people/:id`) at the same
address without the `/mcp`.

## Behaviour

- **Front page** (`/`): the mooned landing page (from `~/one-day-builds/mooned`), copied with its assets: the
  WebGL rain scene (`CyberScene`, `public/scene/`), rain audio (`RainAudio`, `public/audio/`), street signs
  in Marathi and Gujarati with plain marks of Ethereum and other layer 1 chains (`src/data/sign-words.ts`, subset fonts in `public/fonts/`) and the "What is this?" ink dialog (`InkDialog`). Its dark body styles
  also dress search and profile (`body:has(.mooned, .terminal-page)`). The rain audio is mounted in the root
  layout, so it keeps playing from page to page. Green terminal text sits on the vending machine's two
  screens (`VendingScreens`, an HTML overlay matched to where the shader draws the machine): the big one reads
  `ENTER` with a blinking cursor and opens the same ink dialog with the ticket form (and the admin form, see
  below). After signing in, the dialog stays open while `PUT /api/agent` sets up the user's agent (waiting out a
  409 from another tab), then opens search; from then on `ENTER` leads straight to it, and the small one shows `PROFILE FOUND` and the email.
  The name and email are kept in local storage (`HUMANS_PROFILE`) for that; the session stays in its cookie,
  and a stored profile without a valid cookie is cleared.
- **Search** (`/search`, the first view after signing in): one line to type who you are looking for, or something
  you believe in. The header shows `VIEW PROFILE (ACTIVE)` once a profile is saved,
  `(INCOMPLETE)` when the user has told the agent things but never saved, `(NOT ADDED)` before that, then
  the email and, at the end of the row, "Sign out" (on the profile page too), which clears the stored profile. Each answer
  shows the query, the agent's reply, and every person it links as a result card (`GET /api/people/:id`);
  follow-ups keep the thread. A new session each time the page opens, nothing kept.
- **Profile** (`/profile`): the saved profile (headline and location, then the page the profile writer made from everything the user said: short sections under bold labels), **Save**
  (`POST /api/profile`, publishes it to search) and **Share on X** (an X post with the site's address). Telling
  the agent about yourself is one message at a time (`POST /api/profile/message`): each runs in a session of its
  own, deleted once the reply ends, so there is no back and forth; the page reloads the profile after each
  (`GET /api/profile`). The agent adds or deletes entries but never saves; the button does. On the front page the
  machine's small screen ("PROFILE FOUND") opens this page.
- **Link previews**: Open Graph and Twitter card from `layout.tsx`, the image `src/app/opengraph-image.jpg` (and
  `twitter-image.jpg`), a 1200 × 630 capture of the front page. Set `SITE_URL` so its address is absolute (on
  Vercel, Next.js uses the deployment's own).
- **Badge pickup** (`POST /api/badge`): the matchmaker's `.pkpass` check, unchanged. The user id is `dc-` + a
  SHA-256 of pass type and serial; the name is the ticket's email before the `@`. The email is stored: the user's
  agent is found by it. Sets the `devcon_humans_session` cookie (HS256 JWT). The pass itself is never stored.
- **One fleet agent per user**, set up when they sign in: with `FLEET_API_KEY`, the fleet's agent for the ticket's email is looked up
  (`GET /api/fleets/:id/agents?email=`) and added if there is none (`POST /api/fleets/:id/agents`). The fleet key
  then issues the agent's admin key, which makes sure the agent has the find-humans MCP server with one header,
  an `X-Find-Humans-Secret` minted for it (a random 32-byte id signed with `FIND_HUMANS_SIGNING_KEY`; an agent that
  already has a secret keeps its id), and its user key, which is kept. The id is kept too (`findHumansId`), so
  the profile page reaches the same profile; users set up before that have it read from their agent once. Any other header on
  that server is dropped: the agent's member can read and redirect its headers, so it holds nothing shared. Set-up is locked per user for 60 s; a second tab waits for it.
- **Search API** (`/api/chat`): `PUT` starts a new session on the user's agent and deletes the previous one; the
  search page calls it every time it opens. `POST { message }` streams the reply as server-sent events. Messages
  over 4000 characters, or with any line starting `!word` or `/word`, are refused. The server puts the page's
  instructions before each message (`src/lib/prompts.ts`): search asks the agent to link each person as
  `[Name](humans:<person_id>)`, which the page turns into result cards; profile tells it not to save.
- **Admin mode** (`POST /api/admin/session { email }`): off unless `HUMANS_ADMIN_KEY` (32+ characters) is set.
  A browser whose local storage has `HUMANS_ADMIN_KEY` set to the same value (`localStorage.setItem("HUMANS_ADMIN_KEY", "…")`
  in the console) shows a "sign in as any email" form in the Enter dialog, under the ticket form. The key goes in the `x-humans-admin-key` header; a
  wrong key answers 404. The session is that email's user (the latest one, if several tickets share it), so the
  pages reach their own agent with their user key and find-humans secret. An email with no user yet becomes one,
  id `dc-email-` + SHA-256 of the email, its agent found or added in the fleet by email as on first pickup.
- Every write needs the session cookie and must come from this origin. Agent errors are logged, never relayed.

## Collection

| Collection | Fields |
| --- | --- |
| `users` | `userId` (unique), `name`, `email`, `createdAt`, `lastSeenAt`, `agentId`, `userKey`, `findHumansId`, `sessionId` (search), `provisioningUntil` (during set-up) |

## Checks

```sh
pnpm test && pnpm typecheck && pnpm lint
```
