# devcon-jobs-matchmaker

Standalone Next.js app on top of the staging agent (`acdab9e7`), reached with the agent's user API key. Data lives in a local MongoDB.

No auth yet: the user types a user id on the home page and works under `/u/<userId>`.

## Run

```sh
brew services start mongodb-community   # or any mongod on 127.0.0.1:27017
cp .env.example .env.local              # fill in AGENT_API_KEY
pnpm install
pnpm dev                                # http://localhost:3100
```

## Behaviour

- **Resume upload** (`POST /api/users/:userId/resume`, PDF, max 10 MB): creates an agent session, uploads the PDF, sends `Add candidate`, waits for the reply, then deletes the session. The reply is stored in `resumes`.
- **Chat** (`/api/users/:userId/chat`): one agent session per user, stored in `chats` with a count of messages sent. A user may send 25 messages; after that the chat must be cleared (`DELETE`), which deletes the agent session. The next message starts a new one.
- Messages whose any line starts with `!word` or `/word` are refused, so no agent command reaches the session.

## Collections

| Collection | Fields |
| --- | --- |
| `chats` | `userId` (unique), `sessionId`, `sent`, `createdAt` |
| `resumes` | `userId`, `fileName`, `bytes`, `reply`, `createdAt` |

## Checks

```sh
pnpm test && pnpm typecheck && pnpm lint
```
