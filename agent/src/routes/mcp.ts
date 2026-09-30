import type { Env } from "../agent";
import { SECRET_MASK } from "../capabilities";
import {
  type McpServerRow,
  type McpServerView,
  parseHeaders,
  parseNames,
  parseTools,
} from "../mcp";
import { EMPTY_MCP_SERVER } from "../registry";
import { deploymentSettings } from "../settings";
import { assertNameFree, mergeHeaders, validateMcpBody } from "../validation/mcp";
import { errorMessage, json, jsonError, readJson } from "../worker/http";
import { syncMcpTools } from "../worker/integrations";
import { readConfig, registry } from "../worker/stores";
import { redirectUri, startMcpOauth } from "./mcp-oauth";
import { recommendMcpTools } from "./mcp-recommend";

/**
 * A server as the browser may see it: tokens stay in the Worker. Header values go back
 * to a caller that may edit them; anyone else gets the names with each value masked.
 */
export function mcpView(row: McpServerRow, reveal: boolean): McpServerView {
  const {
    oauth_client_secret: _secret,
    oauth_access_token: token,
    oauth_refresh_token: _refresh,
    oauth_verifier: _verifier,
    oauth_state: _state,
    headers,
    tools_json,
    disabled_tools,
    ...rest
  } = row;
  return {
    ...rest,
    headers: Object.fromEntries(
      Object.entries(parseHeaders(headers)).map(([key, value]) => [
        key,
        reveal ? value : SECRET_MASK,
      ])
    ),
    tools: parseTools(tools_json),
    disabled_tools: parseNames(disabled_tools),
    connected: row.auth !== "oauth" || token !== "",
  };
}

/** The fields of an MCP server that are the list rather than the use of it. */
const LIST_FIELDS = ["name", "url", "auth", "headers"] as const;

/** Fields whose change the server itself would answer differently, so tools are re-read. */
const REREAD_FIELDS = ["url", "auth", "headers", "enabled"] as const;

type McpCall = {
  request: Request;
  env: Env;
  url: URL;
  agentId: string;
  reg: ReturnType<typeof registry>;
  /**
   * Whether this call may change *which* servers the agent has (add, repoint, remove).
   * That is a meta setting; `?meta=1` is the admin dialog that owns it. Using a server
   * the agent already has is never refused.
   */
  manages: () => Promise<boolean>;
};

const refused = () => jsonError("This agent's MCP servers are managed for you.", 403);
const noSuchServer = () => jsonError("no such server", 404);

/**
 * Everything under `/api/agents/:agentId/mcp`. `rest[0]` is a server id and `rest[1]`
 * an action on it. Servers live in the agent's own registry.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  url: URL,
  agentId: string,
  rest: string[]
): Promise<Response | undefined> {
  const reg = registry(env, agentId);
  const call: McpCall = {
    request,
    env,
    url,
    agentId,
    reg,
    manages: async () =>
      url.searchParams.get("meta") === "1" || (await reg.meta()).mcp.user_servers,
  };
  const [id, action] = rest;
  const method = request.method;

  if (!id) {
    if (method === "GET") return await listServers(call);
    if (method === "POST") return await addServer(call);
    return undefined;
  }
  if (method === "POST" && action === "connect") return await connectServer(call, id);
  if (method === "POST" && action === "disconnect") return await disconnectServer(call, id);
  if (method === "POST" && action === "refresh") return await refreshServer(call, id);
  if (method === "POST" && action === "recommend") return await recommendTools(call, id);
  if (method === "PATCH") return await patchServer(call, id);
  if (method === "DELETE") {
    if (!(await call.manages())) return refused();
    await reg.removeMcpServer(id);
    return json({ ok: true });
  }
  return undefined;
}

async function listServers({ env, url, reg, manages }: McpCall): Promise<Response> {
  const servers = await reg.mcpServers();
  const reveal = await manages();
  const { mcp } = await reg.meta();
  const settings = await deploymentSettings(env);
  return json({
    servers: servers.map((row) => mcpView(row, reveal)),
    // Shown on the page: a provider may ask for it when registering by hand.
    redirect_uri: redirectUri(url.origin),
    // The admin settings the list has to draw, sent here because `/meta` is admin-only.
    // `templates` narrows the catalogue (empty is all); an agent's own catalogue
    // replaces the deployment's.
    templates: mcp.templates,
    catalog: mcp.catalog.length ? mcp.catalog : settings.mcp_catalog,
    user_servers: mcp.user_servers,
  });
}

async function addServer({ request, reg, manages }: McpCall): Promise<Response> {
  if (!(await manages())) return refused();
  const body = await readJson<Record<string, unknown>>(request);
  let patch: Partial<McpServerRow>;
  try {
    patch = validateMcpBody(body);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  if (!patch.name || !patch.url) return jsonError("name and url are required", 400);
  try {
    await assertNameFree(reg, patch.name);
  } catch (err) {
    return jsonError(errorMessage(err), 409);
  }
  const row: McpServerRow = {
    ...EMPTY_MCP_SERVER,
    id: crypto.randomUUID().slice(0, 8),
    created_at: Date.now(),
    name: patch.name,
    url: patch.url,
    auth: patch.auth ?? "none",
    headers: patch.headers ?? "",
    enabled: patch.enabled ?? 1,
  };
  await reg.addMcpServer(row);
  // OAuth has nothing to list until the user approves it.
  const synced = row.auth === "oauth" ? row : await syncMcpTools(reg, row);
  return json({ server: mcpView(synced, true) });
}

async function connectServer({ request, url, agentId, reg }: McpCall, id: string) {
  const row = await reg.mcpServer(id);
  if (!row) return noSuchServer();
  const { return_to } = await readJson<{ return_to?: string }>(request);
  try {
    const authorizeUrl = await startMcpOauth(reg, agentId, row, url.origin, return_to ?? "");
    return json({ authorize_url: authorizeUrl });
  } catch (err) {
    const message = errorMessage(err);
    await reg.updateMcpServer(id, { last_error: message });
    return jsonError(message, 502);
  }
}

/** Forget the tokens but keep the server, so reconnecting is one click. */
async function disconnectServer({ reg, manages }: McpCall, id: string): Promise<Response> {
  const row = await reg.updateMcpServer(id, {
    oauth_access_token: "",
    oauth_refresh_token: "",
    oauth_expires_at: 0,
    oauth_verifier: "",
    oauth_state: "",
    tools_json: "",
    last_error: "",
  });
  if (!row) return noSuchServer();
  return json({ server: mcpView(row, await manages()) });
}

async function refreshServer({ reg, manages }: McpCall, id: string): Promise<Response> {
  const row = await reg.mcpServer(id);
  if (!row) return noSuchServer();
  const synced = await syncMcpTools(reg, row);
  return json({ server: mcpView(synced, await manages()) });
}

/**
 * Let the agent's model choose which tools to keep on, and apply the choice. Not gated
 * on `manages()`: it only writes `disabled_tools`, the same write the tool chips do.
 */
async function recommendTools({ env, agentId, reg, manages }: McpCall, id: string) {
  const row = await reg.mcpServer(id);
  if (!row) return noSuchServer();
  const tools = parseTools(row.tools_json);
  if (tools.length === 0) {
    return jsonError("This server hasn't listed any tools yet. Refresh it first.", 409);
  }
  const config = await readConfig(env, reg);
  if (!config.openrouter_api_key) {
    return jsonError("OpenRouter API key is missing. Add it in Settings.", 400);
  }
  let keep: string[];
  try {
    keep = await recommendMcpTools(row, config, tools);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`mcp recommend failed for ${row.name} on agent ${agentId}: ${message}`);
    return jsonError(message, 502);
  }
  const kept = new Set(keep);
  const updated = await reg.updateMcpServer(id, {
    // Stored as exclusions, so a tool the provider adds later arrives switched on.
    disabled_tools: JSON.stringify(
      tools.filter((tool) => !kept.has(tool.name)).map((tool) => tool.name)
    ),
  });
  if (!updated) return noSuchServer();
  return json({ server: mcpView(updated, await manages()) });
}

async function patchServer({ request, reg, manages }: McpCall, id: string): Promise<Response> {
  const existing = await reg.mcpServer(id);
  if (!existing) return noSuchServer();
  const body = await readJson<Record<string, unknown>>(request);
  let patch: Partial<McpServerRow>;
  try {
    patch = validateMcpBody(body);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  if (LIST_FIELDS.some((key) => patch[key] !== undefined) && !(await manages())) {
    return refused();
  }
  if (patch.name && patch.name !== existing.name) {
    try {
      await assertNameFree(reg, patch.name, id);
    } catch (err) {
      return jsonError(errorMessage(err), 409);
    }
  }
  if (patch.headers !== undefined) patch.headers = mergeHeaders(existing.headers, patch.headers);
  // Tokens issued for the old URL are no good at the new one.
  if (patch.url && patch.url !== existing.url) {
    Object.assign(patch, {
      oauth_access_token: "",
      oauth_refresh_token: "",
      oauth_expires_at: 0,
      tools_json: "",
    });
  }
  const updated = await reg.updateMcpServer(id, patch);
  if (!updated) return noSuchServer();
  const changed = REREAD_FIELDS.some((key) => patch[key] !== undefined);
  return json({
    server: mcpView(changed ? await syncMcpTools(reg, updated) : updated, await manages()),
  });
}
