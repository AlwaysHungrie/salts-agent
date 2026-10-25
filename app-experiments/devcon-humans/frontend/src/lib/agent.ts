import "server-only";

/**
 * The salts Worker. Every user has an agent of their own in one fleet, found or added by
 * their email with the fleet's API key (`FLEET_API_KEY`), and reached with that agent's
 * own keys.
 */

function baseUrl(): string {
  const url = process.env.AGENT_URL?.replace(/\/+$/, "");
  if (!url) throw new AgentError("AGENT_URL must be set.", 500);
  return url;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A raw call to the Worker. */
export async function agentFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${baseUrl()}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new AgentError("Cannot reach the agent.", 502);
  }
}

/** The Worker's `{ error }` as a thrown AgentError when the response is not ok. */
export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    detail = (JSON.parse(text) as { error?: string }).error ?? "";
  } catch {}
  throw new AgentError(detail || `The agent returned ${res.status}.`, res.status >= 500 ? 502 : res.status);
}

async function json<T>(path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await ensureOk(
    await agentFetch(path, { ...init, headers: { "content-type": "application/json", ...headers } }),
  );
  return (await res.json()) as T;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/** The agent id inside a key, `salt_<role>_<agentId>_<secret>`. */
export function agentIdOf(key: string): string {
  const id = /^salt_(?:user|admin)_([a-z0-9]+)_/.exec(key)?.[1];
  if (!id) throw new AgentError("Not an agent API key.", 500);
  return id;
}

function fleetKey(): { key: string; fleetId: string } {
  const key = process.env.FLEET_API_KEY ?? "";
  const fleetId = /^salt_fleet_([A-Za-z0-9-]+)_/.exec(key)?.[1];
  if (!fleetId) throw new AgentError("FLEET_API_KEY must be set to a fleet API key.", 500);
  return { key, fleetId };
}

const fleetPath = (fleetId: string, rest: string) => `/api/fleets/${encodeURIComponent(fleetId)}/${rest}`;

/** The fleet agent whose access list holds `email`, or null when there is none. */
export async function findFleetAgent(email: string): Promise<string | null> {
  const { key, fleetId } = fleetKey();
  const body = await json<{ agents: { id: string }[] }>(
    fleetPath(fleetId, `agents?email=${encodeURIComponent(email)}`),
    bearer(key),
  );
  return body.agents[0]?.id ?? null;
}

/** A new fleet agent for `email`, created from the fleet's settings. */
export async function addFleetAgent(email: string): Promise<string> {
  const { key, fleetId } = fleetKey();
  const body = await json<{ agents: { id: string }[] }>(fleetPath(fleetId, "agents"), bearer(key), {
    method: "POST",
    body: JSON.stringify({ allowed_emails: email }),
  });
  const id = body.agents[0]?.id;
  if (!id) throw new AgentError("The fleet added no agent.", 502);
  return id;
}

/** A fresh `admin` or `user` key for one of the fleet's agents, replacing its old one. */
export async function issueAgentKey(agentId: string, role: "admin" | "user"): Promise<string> {
  const { key, fleetId } = fleetKey();
  const body = await json<{ key: string }>(
    fleetPath(fleetId, `agents/${encodeURIComponent(agentId)}/api-keys/${role}`),
    bearer(key),
    { method: "POST" },
  );
  return body.key;
}

export type McpServer = { id: string; name: string; headers: Record<string, string> };

/** The agent's MCP servers, header values shown (the admin's key sees them). */
export async function mcpServers(adminKey: string): Promise<McpServer[]> {
  const body = await json<{ servers: McpServer[] }>(
    `/api/agents/${encodeURIComponent(agentIdOf(adminKey))}/mcp?meta=1`,
    bearer(adminKey),
  );
  return body.servers;
}

/** Attach an MCP server that authenticates with `headers` (the admin's key manages servers). */
export async function addMcpServer(
  adminKey: string,
  server: { name: string; url: string; headers: Record<string, string> },
): Promise<void> {
  await json(`/api/agents/${encodeURIComponent(agentIdOf(adminKey))}/mcp?meta=1`, bearer(adminKey), {
    method: "POST",
    body: JSON.stringify({ ...server, auth: "headers" }),
  });
}

/** Replace a server's headers. */
export async function setMcpHeaders(adminKey: string, serverId: string, headers: Record<string, string>): Promise<void> {
  await json(
    `/api/agents/${encodeURIComponent(agentIdOf(adminKey))}/mcp/${encodeURIComponent(serverId)}?meta=1`,
    bearer(adminKey),
    { method: "PATCH", body: JSON.stringify({ headers }) },
  );
}

const sessionPath = (sessionId: string, rest: string) =>
  `/agents/session-agent/${encodeURIComponent(sessionId)}/${rest}`;

export async function createSession(userKey: string, title: string): Promise<string> {
  const row = await json<{ id: string }>(
    `/api/agents/${encodeURIComponent(agentIdOf(userKey))}/sessions`,
    bearer(userKey),
    { method: "POST", body: JSON.stringify({ title }) },
  );
  return row.id;
}

export async function deleteSession(userKey: string, sessionId: string): Promise<void> {
  await json(`/api/sessions/${encodeURIComponent(sessionId)}`, bearer(userKey), { method: "DELETE" });
}

/** Send a message; the response body is the reply as server-sent events. */
export async function stream(
  userKey: string,
  sessionId: string,
  message: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await ensureOk(
    await agentFetch(sessionPath(sessionId, "stream"), {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(userKey) },
      body: JSON.stringify({ message }),
      signal,
    }),
  );
  if (!res.body) throw new AgentError("The agent sent no reply.", 502);
  return res.body;
}
