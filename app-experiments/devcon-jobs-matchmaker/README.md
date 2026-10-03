# devcon-jobs-matchmaker

Standalone Next.js app on top of the staging agent (`acdab9e7`), reached with the agent's user API key. Data lives in a local MongoDB.

Users sign in with their Devcon ticket's `.pkpass` and work under `/u/<userId>`.

## Run

```sh
brew services start mongodb-community   # or any mongod on 127.0.0.1:27017
cp .env.example .env.local              # fill in AGENT_API_KEY, SESSION_SECRET, OPENROUTER_API_KEY
pnpm install
pnpm dev                                # http://localhost:3100
```

## Behaviour

- **Badge pickup** (`POST /api/badge`, form field `pass`, max 5 MB, same-origin only): unzips the `.pkpass` in memory, checks every file against `manifest.json` (SHA-1), checks the detached CMS signature over the manifest chains to Apple Root CA (via WWDR G4) from a currently valid Pass Type ID certificate whose UID/OU match the pass's `passTypeIdentifier`/`teamIdentifier`, and that those are Devcon's (`pass.devcon-test` / `B6ZYYG9TU6`, in `DEVCON_ISSUER`). The rest of `pass.json` may vary; a `voided` or past-`expirationDate` ticket is refused. The user id is `dc-` + a SHA-256 of pass type and serial; the name is the ticket's email before the `@`. Creates the user if new, answers `{ token, userId, name }` and sets the same HS256 JWT (`sub` = user id, `name`) as the http-only `devcon_session` cookie. Neither the pass nor the full email is stored.
- **Auth**: every `/api/users/:userId/*` route and `/u/:userId` needs a session (cookie, or `Authorization: Bearer <token>`) for that same user: 401 without one, 403 for anyone else's. Cookie-borne writes must come from this origin. Agent errors are logged, never relayed.
- **Resume upload** (`POST /api/users/:userId/resume`, PDF, max 10 MB): one resume per user, replaceable once every 6 hours (429 before then; `GET` returns `updatableAt`), one upload at a time (409 while one runs). If the user already has a candidate, the agent is first asked, in a throwaway session, to `delete_candidate` it; the upload stops unless that reply says it is gone. Then a new session gets the PDF and `Add candidate`, and is deleted. The candidate id in the reply is stored in `resumes`; a reply with none fails the upload and stores nothing.
- **Chat** (`/api/users/:userId/chat`): one agent session per user, stored in `chats` with a count of messages sent. A user may send 25 messages; after that the chat must be cleared (`DELETE`), which deletes the agent session. The next message starts a new one.
- Messages whose any line starts with `!word` or `/word` are refused, so no agent command reaches the session.
- **Small model** (`src/lib/llm.ts`, `mistralai/mistral-nemo` on OpenRouter, `OPENROUTER_API_KEY`): run by this app, not the agent. Reads the candidate id from the agent's add reply (only a UUID the reply contains is accepted), reads whether a delete worked, and screens every chat message before it is counted or sent: off-topic messages and requests to remove any candidate are refused with 400. If it cannot answer, the message or upload fails.

## Collections

| Collection | Fields |
| --- | --- |
| `users` | `userId` (unique), `name`, `createdAt`, `lastSeenAt`, `resumeBusyUntil` (while an upload runs) |
| `chats` | `userId` (unique), `sessionId`, `sent`, `createdAt` |
| `resumes` | `userId`, `candidateId`, `fileName`, `bytes`, `reply`, `createdAt` (one per user) |

## Checks

```sh
pnpm test && pnpm typecheck && pnpm lint
```

`test/pkpass.test.ts` signs throwaway passes with its own CA via `openssl`. A real ticket at `test/fixtures/devcon.pkpass` (gitignored: it is a live ticket) is also checked against Apple's root.
