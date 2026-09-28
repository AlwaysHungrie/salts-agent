# SearXNG — self-hosted web search

Replaces the Brave Search API key. SearXNG is a metasearch engine: it queries
Google, Bing, DuckDuckGo, Brave, Wikipedia and ~70 others on your behalf and
returns merged results over a JSON API. No account, no key, no per-query bill.

It is guarded by default: port 8080 serves a bearer-token gate, and SearXNG
itself is not reachable from the host.

## Run it

```bash
cp .env.example .env   # optional: the defaults work as-is
docker compose up -d
```

The first run generates two things:

- the instance secret, written into `settings.yml`
- the **API token**, written into `token.txt`

The token is never printed to the logs. Read it from the file:

```bash
cat token.txt
```

Later runs reuse both. To force new ones, delete the `secret_key` value in
`settings.yml` and/or delete `token.txt` **and** `token.conf`, then bring the
stack back up.

If `docker compose` reports it cannot reach the daemon, Docker Desktop is not
running — launch it (`open -a Docker`), give it a minute, and retry.

Check it:

```bash
curl -s -H "Authorization: Bearer $(cat token.txt)" \
  'http://localhost:8080/search?q=solana&format=json' | head -c 400
```

Requests without a valid token get a 401. Right after startup the gate can
return 502 for a few seconds while SearXNG warms up.

## Point the agent at it

In the agent's **Web search** capability settings:

- **SearXNG URL** — `http://localhost:8080` (or wherever the instance lives)
- **SearXNG token** — the contents of `token.txt`

The agent sends it as `Authorization: Bearer <token>`. When the URL is set the
agent uses SearXNG and ignores the Brave key. Leave the URL blank to fall back
to Brave.

Cloudflare Workers cannot reach `localhost`, so a deployed agent needs the
instance on a public host (or a tunnel, e.g. `cloudflared tunnel`).

## Running unguarded

To drop the token gate, add the override file:

```bash
docker compose down                                                  # if it is up
docker compose -f docker-compose.yml -f docker-compose.unguarded.yml up -d
curl -s 'http://localhost:8080/search?q=solana&format=json' | head -c 400
```

Same port, no gate: Caddy does not start and SearXNG takes 8080 itself. Run
`docker compose down` before switching modes, or the old container keeps the
port and the new one fails to bind.

Only do this where nothing else can reach the port — a public SearXNG with
`format: json` on is an open proxy.

## Files

- `docker-compose.yml` — the first-run generator, SearXNG (no host port), and the token gate on 8080
- `docker-compose.unguarded.yml` — opt-in override that drops the gate and gives 8080 to SearXNG
- `settings.yml` — enables the JSON format the agent parses; disables the limiter
- `limiter.toml` — no bot-detection throttling on a private instance
- `Caddyfile` — the bearer-token gate
- `token.txt` — the generated API token (gitignored)
- `token.conf` — the same token as a Caddy snippet (gitignored)
