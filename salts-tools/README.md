# salts-tools — local services for a salt-agent, behind one tunnel

salts-tools runs services for an agent on your own laptop and puts all of them on the
internet through a single ngrok tunnel:

| Service | What it is | The agent reaches it at |
| --- | --- | --- |
| `web` | [SearXNG](https://github.com/searxng/searxng), a self-hosted metasearch engine (Google, Bing, DuckDuckGo, Brave, Wikipedia and about 70 others, merged, over a JSON API). No account, no API key, no per-query bill. | **SearXNG URL** setting: `<tunnel>/web` |
| `matchmaker` | [local-mcps/matchmaker-mcp](../local-mcps/matchmaker-mcp/README.md): resume ingestion and job matching as an MCP server, with Postgres in Docker. | MCP server named `matchmaker`: `<tunnel>/matchmaker/mcp` |
| `analyst` | [local-mcps/analyst-mcp](../local-mcps/analyst-mcp/README.md): Excel and CSV analysis as an MCP server. It reads workbooks sent in the chat, answers questions about them, previews tables and charts, and returns built workbooks. It needs no Docker. | MCP server named `analyst`: `<tunnel>/analyst/mcp` |

The CLI:

- runs each service bound to `127.0.0.1` only
- runs a gateway on loopback that routes by the first path segment and refuses anything
  without the token
- opens one ngrok tunnel to the gateway, so every service shares its address
- writes each service's address into the agent
- rebuilds the tunnel and updates the agent whenever the tunnel drops or moves
- optionally starts at login

It runs on macOS, Linux and Windows. It was called salts-web; see
[Moving from salts-web](#moving-from-salts-web).

## Requirements

- Docker with the compose plugin, for `web` and `matchmaker`. `analyst` alone does
  not need Docker. Docker does not need to start at login.
  - macOS: Docker Desktop, OrbStack or Colima. salts-tools starts it when it is not running.
  - Windows: Docker Desktop. salts-tools starts it when it is not running.
  - Linux: Docker Engine, Docker Desktop or Colima. salts-tools starts Docker Desktop and
    Colima itself. Docker Engine runs as a system service, so start it with
    `sudo systemctl enable --now docker`, and add your user to the `docker` group so
    `docker info` works without `sudo`.
- ngrok: `brew install ngrok` (macOS), `winget install ngrok.ngrok` (Windows), or
  [ngrok.com/download](https://ngrok.com/download) (Linux). salts-tools asks for your
  authtoken if ngrok has none.
- Node 20 or later.
- For `matchmaker` and `analyst`: [uv](https://docs.astral.sh/uv/). salts-tools runs
  `uv sync` the first time.
- Linux only, optional: `secret-tool` (package `libsecret-tools` on Debian/Ubuntu,
  `libsecret` on Fedora/Arch) to keep the token in the desktop keyring. See
  [Where things live](#where-things-live).

## Install

```bash
cd salts-tools
npm link          # puts `salts-tools` on your PATH
```

You can also run it without linking: `node salts-tools/cli.mjs <command>`.

## First run

```bash
salts-tools start web
```

1. Checks that Docker and ngrok are installed (and uv, for `matchmaker`), that ngrok has
   an authtoken, and that Docker is running. Starts Docker if it is not.
2. Generates a token if the OS secret store does not already hold one.
3. Asks for the agent ID.
4. Shows the token **once**. Paste it into the agent's settings under Capabilities →
   **Web search** → **SearXNG token**, then save. Leave the Brave key blank. When a
   Brave key is set, the agent uses Brave and ignores SearXNG. This one token guards
   every service, and it is how the Worker knows the addresses come from you.
5. Starts the gateway, the service and the tunnel, and sends the service's address to
   the agent.
6. Asks whether to start salts-tools at login.

If the agent refuses the token because it was not saved in the agent, you can retry
or generate a new one.

## Adding the matchmaker

```bash
salts-tools start matchmaker
```

With salts-tools already running, this joins the same tunnel, so the address does not
change. It starts Postgres (`docker compose` in `local-mcps/matchmaker-mcp`), runs
`uv sync` the first time, starts the server on loopback with the token as its
`MCP_AUTH_TOKEN`, and tells the agent.

The agent gets an MCP server named `matchmaker`, with `Authorization: Bearer <token>`
already set. The tools that call a model also need these headers, which you add once on
that server in the agent's settings (they stay when the address changes):

| Header | Suggested value | Covers |
| --- | --- | --- |
| `X-OpenRouter-Api-Key` | your OpenRouter key | pays for its model calls |
| `X-Cost-Approved-Resume-Ingestion` | `0.01` | one resume, ~$0.002 |
| `X-Cost-Approved-Job-Match` | `0.10` | one job match, ~$0.01–0.04 |
| `X-Cost-Approved-Search` | `0.001` | one candidate search, ~free |
| `X-Cost-Approved-Folder-Ingestion` | `5.00` | a whole inbox run, ~$0.004 a file |

Caps are the most one call may spend, in US dollars; `0` blocks that tool. `start`
prints this list once the matchmaker is connected.

The matchmaker's own `.env` in `local-mcps/matchmaker-mcp` still applies (models,
`DATA_DIR`, and so on). salts-tools overrides the transport, host, port, token and
database URL. Its log is `~/.salts-tools/matchmaker.log`.

## Adding the analyst

```bash
salts-tools start analyst
```

This joins the same tunnel, runs `uv sync` in `local-mcps/analyst-mcp` the first time,
starts the server on loopback with the token as its `MCP_AUTH_TOKEN`, and tells the agent.

The agent gets an MCP server named `analyst`, with `Authorization: Bearer <token>`
already set. Turn on **File ingest** and **MCP** in the agent's capabilities. Users can
then attach .xlsx and .csv files in the chat. The agent shows previews of the tables
and charts it builds, and sends the finished workbook as a download.

The analyst's own `.env` in `local-mcps/analyst-mcp` still applies (`DATA_DIR`,
`INBOX_DIR`, `ALLOW_PYTHON`, and so on). salts-tools overrides the transport, host, port
and token. Its log is `~/.salts-tools/analyst.log`.

## Commands

| Command | What it does |
| --- | --- |
| `salts-tools start` | Checks the machine, runs the first-run steps if needed, then starts the services that were on last time (`web` if none were). The login item runs this. |
| `salts-tools start <service>…` | Starts those services only, on the running tunnel if there is one. Services already running keep running; others are not started. |
| `salts-tools stop <service>` | Turns one service off and stops it. The others and the tunnel keep running. Stopping the last one stops everything. |
| `salts-tools stop` | Stops the supervisor, the tunnel and the containers. The next `start` brings back the same services. |
| `salts-tools restart` | Opens a new tunnel and sends its addresses to the agent. |
| `salts-tools reset` | Back to a first run: deletes the token, `~/.salts-tools` (state and logs), the login item and any salts-web leftovers. Keeps the matchmaker's database. Stop salts-tools first. |
| `salts-tools setup` | Runs the first-run questions again, for example to switch agents. Starts nothing. |
| `salts-tools autostart on` / `off` | Adds or removes the login item. See [Where things live](#where-things-live). |

Services: `web`, `matchmaker`, `analyst`.

## Staging

Add `:staging` to any command to use the staging Worker
(`salt-agent-staging.dhairyashah98.workers.dev`) instead of production:

```bash
salts-tools start:staging web matchmaker
salts-tools restart:staging
salts-tools stop:staging
salts-tools reset:staging
salts-tools setup:staging
salts-tools autostart:staging on
```

Staging runs as a separate instance, with its own token, state, containers, ports,
tunnel and login item, so it can run alongside production. `stop:staging` does not
affect production. Staging uses the token account `searxng-token-staging`, state and
logs in `~/.salts-tools/staging/`, the Docker projects `searxng-staging` and
`matchmaker-mcp-staging`, and a login item with a `-staging` suffix. A free ngrok
account allows one tunnel at a time, so running both needs a paid one.

## How it stays up

`start` launches a background supervisor. It runs the gateway on `127.0.0.1` and checks
the following every 30 seconds:

- Each service that is on answers on loopback. If not, it starts Docker if needed and
  brings the service up. A service turned off with `stop <service>` is taken down.
- ngrok is running. If not, it restarts ngrok.
- The tunnel answers from outside. After three failures in a row it opens a new tunnel.
- The agent has each service's current address. If not, it sends it, and retries until
  the Worker accepts it. This covers a laptop that wakes up offline.

Addresses go to the Worker with the token as `Authorization: Bearer`, and no Clerk
session. The Worker accepts them only when the token matches the agent's saved SearXNG
token; an agent with no token saved cannot be updated this way.

- `web`: `POST /searxng/:agentId/url { url }`. The only setting it changes is
  `searxng_url`.
- `matchmaker`: `POST /searxng/:agentId/mcp { name, url }`. Creates the MCP server
  `matchmaker` if the agent has none, with the token as its `Authorization`. An existing
  server of that name is repointed only if its `Authorization` is already this token;
  otherwise the Worker answers 409 and changes nothing, so the token can never redirect
  an MCP server (and the headers it carries) that you set up some other way.

At login, the login item runs `salts-tools start` without a terminal. That start skips
the Docker wait and leaves it to the supervisor, so login is never held up.

## Security

- Every service listens on `127.0.0.1` only. ngrok reaches only the gateway.
- The gateway refuses any request without `Authorization: Bearer <token>` (compared in
  constant time) and passes the header on, so SearXNG's Caddy gate and the matchmaker
  check the same token again.
- The gateway sends each request on with a loopback `Host`, which the matchmaker's MCP
  library requires.
- Whoever holds the token can search through your SearXNG, call the matchmaker's tools,
  and point the agent's SearXNG URL and `matchmaker` server elsewhere. Keep it in the
  secret store and the agent's settings only.

## Where things live

- **Token**: never passed on a command line. It reaches SearXNG's Caddy container as
  `SALTS_TOKEN` and the matchmaker as `MCP_AUTH_TOKEN`. The Keychain entry keeps its
  salts-web name, so an existing token keeps working.

  | Platform | Stored in |
  | --- | --- |
  | macOS | Keychain, service `salts-web`, account `searxng-token` |
  | Linux with `secret-tool` and a running keyring | Secret Service keyring, attributes `service=salts-web`, `account=searxng-token` |
  | Linux without a keyring (headless) | `~/.salts-tools/token`, mode `0600` |
  | Windows | `%USERPROFILE%\.salts-tools\token.dpapi`, encrypted with DPAPI for the current user |

- **State**: `~/.salts-tools/state.json` holds the agent ID, Worker URL, which services
  are on, their ports, and the tunnel address. It contains no secrets.
- **Logs**: `~/.salts-tools/supervisor.log`, `~/.salts-tools/matchmaker.log`,
  `~/.salts-tools/analyst.log`.
- **Login item**:

  | Platform | Login item |
  | --- | --- |
  | macOS | LaunchAgent `~/Library/LaunchAgents/com.salts-tools.plist` |
  | Linux | systemd user unit `~/.config/systemd/user/salts-tools.service` |
  | Windows | `salts-tools.cmd` in the Startup folder (`shell:startup`) |

To target a different Worker, set `SALTS_TOOLS_WORKER=https://…` when you run
`salts-tools setup`. The default is the production Worker.

To replace the token, reset and start again:

```bash
salts-tools stop
salts-tools reset
salts-tools start
```

## Moving from salts-web

The first `salts-tools` command on a machine that ran salts-web stops the salts-web
supervisor and its tunnel, copies its agent ID, Worker and port from `~/.salts-web` into
`~/.salts-tools` (the old `state.json` is renamed `state.json.migrated`), turns `web` on,
and replaces a salts-web login item with a salts-tools one. The token stays where it is.
The SearXNG containers are the same Docker project, so they are reused. The agent's
SearXNG URL gains `/web` the next time the supervisor pushes it.

## Check it by hand

```bash
T=$(security find-generic-password -s salts-web -a searxng-token -w)   # macOS
# T=$(secret-tool lookup service salts-web account searxng-token)      # Linux, keyring
# T=$(cat ~/.salts-tools/token)                                        # Linux, no keyring
U=$(node -p 'require(process.env.HOME+"/.salts-tools/state.json").url')
curl -s -H "Authorization: Bearer $T" "$U/web/search?q=solana&format=json" | head -c 400
curl -s -H "Authorization: Bearer $T" "$U/matchmaker/healthz"
```

A request without the token gets a 401.

## Running SearXNG unguarded

To remove the token gate on a machine where nothing else can reach the port, add the
override file. Do not use it with the tunnel, because a public SearXNG with
`format: json` enabled is an open proxy.

```bash
salts-tools stop
cd web
SALTS_TOKEN=unused docker compose -f docker-compose.yml -f docker-compose.unguarded.yml up -d
curl -s 'http://localhost:8080/search?q=solana&format=json' | head -c 400
```

## Files

- `cli.mjs`: the CLI and the supervisor
- `gateway.mjs`: the token check and path routing in front of every service
- `test/`: gateway tests (`npm test`)
- `web/docker-compose.yml`: the first-run secret generator, SearXNG (no host port), and
  the token gate on loopback
- `web/docker-compose.unguarded.yml`: an opt-in override that removes the gate
- `web/settings.yml`: enables the JSON format the agent parses and disables the limiter
- `web/limiter.toml`: turns off bot-detection throttling on a private instance
- `web/Caddyfile`: the bearer-token gate, which reads the token from the environment
