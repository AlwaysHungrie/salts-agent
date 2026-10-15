import type { Env } from "../env";
import { type McpServerRow, parseHeaders } from "../mcp";
import { EMPTY_MCP_SERVER } from "../registry";
import { readJson } from "../worker/http";
import { syncMcpTools } from "../worker/integrations";
import { directory, type Registry, readConfig, registry, writeConfig } from "../worker/stores";

/** Equal strings, compared in time that does not depend on where they first differ. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

/**
 * The agent's registry and SearXNG token when the request's bearer matches that token,
 * else undefined. The tunnel host has no Clerk session; the token is its only proof.
 */
async function tokenHolder(request: Request, env: Env, agentId: string) {
  const offered = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!offered) return undefined;
  // Checked against the directory first, so a made-up id never seeds a store of its own.
  if (!(await directory(env).get(agentId))) return undefined;

  const reg = registry(env, agentId);
  const config = await readConfig(env, reg);
  const token = config.searxng_token.trim();
  if (!token || !(await sameSecret(offered, token))) return undefined;
  return { reg, token };
}

/**
 * Repoint an agent's SearXNG URL using its SearXNG token as proof. Agents without a token
 * cannot be repointed. Only the URL changes.
 */
export async function handleSearxngUrl(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const holder = await tokenHolder(request, env, agentId);
  if (!holder) return unauthorized();

  const body = await readJson<{ url?: unknown }>(request);
  let parsed: URL;
  try {
    parsed = new URL(String(body.url ?? ""));
  } catch {
    return Response.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Response.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });
  }
  const url = parsed.toString().replace(/\/+$/, "");
  await writeConfig(env, holder.reg, { searxng_url: url });
  return Response.json({ searxng_url: url });
}

/** Whether a server's saved `Authorization` header is exactly this bearer token. */
async function trustsToken(row: McpServerRow, token: string): Promise<boolean> {
  const headers = parseHeaders(row.headers);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  return (
    row.auth === "headers" &&
    key !== undefined &&
    (await sameSecret(headers[key], `Bearer ${token}`))
  );
}

/**
 * Called as the user removes a server: one salts-tools set up (its `Authorization` is the
 * agent's SearXNG token) is remembered, so the next push does not add it back.
 */
export async function rememberRemoval(env: Env, reg: Registry, row: McpServerRow): Promise<void> {
  const token = (await readConfig(env, reg)).searxng_token.trim();
  if (token && (await trustsToken(row, token))) await reg.markMcpRemoved(row.name);
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SEEDED_HEADERS = 8;

/**
 * Header names to put on the server with empty values, for the user to fill in (an API
 * key the server's tools need). Undefined when the list is not a short list of plain
 * header names; `Authorization` is never one, since the token is.
 */
function seededHeaders(raw: unknown): string[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SEEDED_HEADERS) return undefined;
  const names = raw.map((n) => (typeof n === "string" ? n.trim() : ""));
  if (names.some((n) => !HEADER_NAME.test(n) || n.toLowerCase() === "authorization")) return undefined;
  return names;
}

/** `headers` with each of `names` it lacks (in any case) added empty; values it has stay. */
function withEmpty(headers: Record<string, string>, names: string[]): Record<string, string> {
  const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const out = { ...headers };
  for (const name of names) if (!have.has(name.toLowerCase())) out[name] = "";
  return out;
}

/**
 * Point one of the agent's MCP servers at a local server behind the salts-tools tunnel,
 * with the SearXNG token as proof. A server of that name is created when there is none
 * (unless the user removed it: 410), authenticated with the same token. An existing one is repointed only when its saved
 * `Authorization` is that token, so the token never redirects a server (and the headers
 * it carries) that was set up for anything else. `headers` names headers to add empty
 * when missing, so the user only fills in their values; values already set are kept.
 */
export async function handleSearxngMcp(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const holder = await tokenHolder(request, env, agentId);
  if (!holder) return unauthorized();
  const { reg, token } = holder;

  const body = await readJson<{ name?: unknown; url?: unknown; headers?: unknown }>(request);
  const name = String(body.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    return Response.json({ error: "name must be a short lowercase slug" }, { status: 400 });
  }
  const seeded = seededHeaders(body.headers);
  if (!seeded) {
    return Response.json(
      { error: `headers must be up to ${MAX_SEEDED_HEADERS} header names, not Authorization` },
      { status: 400 }
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(String(body.url ?? ""));
  } catch {
    return Response.json({ error: "url must be an absolute https URL" }, { status: 400 });
  }
  // Credentials travel on every call, so the transport has to be encrypted.
  if (parsed.protocol !== "https:") {
    return Response.json({ error: "url must be an absolute https URL" }, { status: 400 });
  }
  const url = parsed.toString();

  if (!(await reg.meta()).mcp.user_servers) {
    return Response.json({ error: "this agent's MCP servers are managed for it" }, { status: 403 });
  }

  const existing = (await reg.mcpServers()).find((s) => s.name.toLowerCase() === name);
  if (!existing && (await reg.mcpRemoved(name))) {
    return Response.json(
      { error: `MCP server "${name}" was removed in this agent; it is not added back` },
      { status: 410 }
    );
  }
  if (!existing) {
    const row: McpServerRow = {
      ...EMPTY_MCP_SERVER,
      id: crypto.randomUUID().slice(0, 8),
      created_at: Date.now(),
      name,
      url,
      auth: "headers",
      headers: JSON.stringify(withEmpty({ Authorization: `Bearer ${token}` }, seeded)),
      enabled: 1,
    };
    await reg.addMcpServer(row);
    await syncMcpTools(reg, row);
    return Response.json({ name, url, created: true });
  }
  if (!(await trustsToken(existing, token))) {
    return Response.json(
      { error: `MCP server "${existing.name}" does not use this token; it was not changed` },
      { status: 409 }
    );
  }
  const current = parseHeaders(existing.headers);
  const headers = withEmpty(current, seeded);
  if (Object.keys(headers).length !== Object.keys(current).length) {
    await reg.updateMcpServer(existing.id, { headers: JSON.stringify(headers) });
  }
  if (existing.url !== url) {
    const updated = await reg.updateMcpServer(existing.id, { url, tools_json: "" });
    if (updated) await syncMcpTools(reg, updated);
  }
  return Response.json({ name, url, created: false });
}
