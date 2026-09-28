# salts-web — private web search for a salt-agent

salts-web gives an agent web search from your own laptop. It runs
[SearXNG](https://github.com/searxng/searxng), a self-hosted metasearch engine that
queries Google, Bing, DuckDuckGo, Brave, Wikipedia and about 70 others and returns
merged results over a JSON API. There is no account, no API key and no per-query bill.

The CLI does the rest:

- runs SearXNG in Docker behind a bearer-token gate, bound to `127.0.0.1` only
- opens an ngrok tunnel so the deployed Worker can reach it
- writes the tunnel's address into the agent's **SearXNG URL** setting
- rebuilds the tunnel and updates the agent whenever the tunnel drops or moves
- optionally starts at login

It runs on macOS only, because the token is kept in the macOS Keychain.

## Requirements

- Docker: Docker Desktop, OrbStack or Colima. It does not need to start at login.
  salts-web starts it when it is not running.
- ngrok: `brew install ngrok`. salts-web asks for your authtoken if ngrok has none.
- Node 20 or later.

## Install

```bash
cd salts-web
npm link          # puts `salts-web` on your PATH
```

You can also run it without linking: `node salts-web/cli.mjs <command>`.

## First run

```bash
salts-web start
```

1. Checks that Docker and ngrok are installed, that ngrok has an authtoken, and that
   Docker is running. Starts Docker if it is not.
2. Generates an API token if the Keychain does not already hold one.
3. Asks for the agent ID.
4. Shows the token **once**. Paste it into the agent's settings under Capabilities →
   **Web search** → **SearXNG token**, then save. Leave the Brave key blank. When a
   Brave key is set, the agent uses Brave and ignores SearXNG.
5. Picks a free port, starting at 8080, starts the stack and the tunnel, and sets the
   agent's SearXNG URL to the tunnel address.
6. Asks whether to start salts-web at login.

If the agent refuses the token because it was not saved in the agent, you can retry
or generate a new one.

## Commands

| Command | What it does |
| --- | --- |
| `salts-web start` | Checks the machine, runs the first-run steps if needed, then starts everything. |
| `salts-web stop` | Stops the supervisor, the tunnel and the containers. |
| `salts-web restart` | Opens a new tunnel and sends its address to the agent. |
| `salts-web reset` | Deletes `state.json` and the token in the Keychain, so the next `start` is a first run. Stop salts-web first. |
| `salts-web setup` | Runs the first-run questions again, for example to switch agents. |
| `salts-web autostart on` / `off` | Adds or removes the login item (a LaunchAgent). |

## Staging

Add `:staging` to any command to use the staging Worker
(`salt-agent-staging.dhairyashah98.workers.dev`) instead of production:

```bash
salts-web start:staging
salts-web restart:staging
salts-web stop:staging
salts-web reset:staging
salts-web setup:staging
salts-web autostart:staging on
```

Staging runs as a separate instance, with its own token, state, containers, port,
tunnel and login item, so it can run alongside production. `stop:staging` does not
affect production. Staging uses the Keychain account `searxng-token-staging`, state and
logs in `~/.salts-web/staging/`, the Docker project `searxng-staging`, and the login
item `com.salts-web-staging`.

## How it stays up

`start` launches a background supervisor, which checks the following every 30 seconds:

- Docker is reachable. If not, it starts Docker and waits for it.
- The gate answers on `127.0.0.1:<port>`. If not, it runs `docker compose up`.
- ngrok is running. If not, it restarts ngrok.
- The tunnel answers from outside. After three failures in a row it opens a new tunnel.
- The agent has the current address. If not, it sends it, and retries until the Worker
  accepts it. This covers a laptop that wakes up offline.

The address is sent to `POST /searxng/:agentId/url` on the Worker. The request carries
no Clerk session. The Worker accepts it only when the bearer token matches the agent's
saved SearXNG token, and the only setting it changes is `searxng_url`. An agent with no
token saved cannot be updated through this route.

At login, the LaunchAgent runs `salts-web start` without a terminal. That start skips
the Docker wait and leaves it to the supervisor, so login is never held up.

## Where things live

- **Token**: macOS Keychain, service `salts-web`, account `searxng-token`. It is never
  written to a file or passed on a command line. The Caddy container receives it as
  `SALTS_TOKEN`. `docker-compose.yml` refuses to start the gate without it.
- **State**: `~/.salts-web/state.json` holds the agent ID, Worker URL, port and tunnel
  address. It contains no secrets.
- **Log**: `~/.salts-web/supervisor.log`.
- **Login item**: `~/Library/LaunchAgents/com.salts-web.plist`.

To target a different Worker, set `SALTS_WEB_WORKER=https://…` when you run
`salts-web setup`. The default is the production Worker.

To replace the token, reset and start again:

```bash
salts-web stop
salts-web reset
salts-web start
```

## Check it by hand

```bash
T=$(security find-generic-password -s salts-web -a searxng-token -w)
curl -s -H "Authorization: Bearer $T" \
  "$(node -p 'require(process.env.HOME+"/.salts-web/state.json").url')/search?q=solana&format=json" | head -c 400
```

A request without the token gets a 401.

## Running unguarded

To remove the token gate on a machine where nothing else can reach the port, add the
override file. Do not use it with the tunnel, because a public SearXNG with
`format: json` enabled is an open proxy.

```bash
salts-web stop
SALTS_TOKEN=unused docker compose -f docker-compose.yml -f docker-compose.unguarded.yml up -d
curl -s 'http://localhost:8080/search?q=solana&format=json' | head -c 400
```

## Files

- `cli.mjs`: the CLI and the supervisor
- `docker-compose.yml`: the first-run secret generator, SearXNG (no host port), and the
  token gate on loopback
- `docker-compose.unguarded.yml`: an opt-in override that removes the gate
- `settings.yml`: enables the JSON format the agent parses and disables the limiter
- `limiter.toml`: turns off bot-detection throttling on a private instance
- `Caddyfile`: the bearer-token gate, which reads the token from the environment
