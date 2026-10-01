import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import { McpCatalogEntrySchema, McpServerSchema, OkSchema, checkedByHandler } from "../api/schemas";
import type { Env } from "../env";
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
import { ApiError, errorMessage } from "../worker/http";
import { syncMcpTools } from "../worker/integrations";
import { readConfig } from "../worker/stores";
import { type AgentCall, AgentParams, agentRoute } from "./agent";
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
  env: Env;
  url: URL;
  agentId: string;
  reg: AgentCall["reg"];
  /**
   * Whether this call may change which servers exist: the `user_servers` meta setting,
   * or `?meta=1` from the admin dialog. Using existing servers is never refused.
   */
  manages: () => Promise<boolean>;
};

const refused = () => new ApiError(403, "This agent's MCP servers are managed for you.");
const noSuchServer = () => new ApiError(404, "no such server");

/** Members use the servers; the admin reaches them from the meta dialog, with `?meta=1`. */
const mayUseMcp = (call: AgentCall) =>
  call.isUser || (call.isAdmin && call.url.searchParams.get("meta") === "1");

function mcpCall({ env, url, agentId, reg }: AgentCall): McpCall {
  return {
    env,
    url,
    agentId,
    reg,
    manages: async () =>
      url.searchParams.get("meta") === "1" || (await reg.meta()).mcp.user_servers,
  };
}

const MetaQuery = z.object({
  meta: z.literal("1").optional().openapi({
    description: "From the admin's meta dialog: may manage servers, sees header values.",
  }),
});

const ServerParams = AgentParams.extend({
  serverId: z.string().openapi({ param: { name: "serverId", in: "path" }, example: "1a2b3c4d" }),
});

const McpBodyShape = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  auth: z.enum(["none", "headers", "oauth"]).optional(),
  headers: z
    .union([z.string(), z.record(z.string(), z.string())])
    .optional()
    .openapi({ description: "Header values sent to a `headers` server." }),
  enabled: z.union([z.number(), z.boolean()]).optional(),
  disabled_tools: z.array(z.string()).optional(),
});
const McpBodySchema = checkedByHandler(McpBodyShape, "McpServerBody");

const middleware = [agentRoute(mayUseMcp)];

const ServerAnswer = jsonOf(z.object({ server: McpServerSchema }).openapi("McpServerAnswer"));
const tag = ["MCP servers"];

/** Everything under `/api/agents/{agentId}/mcp`. Servers live in the agent's own registry. */
const listServersRoute = createRoute({
  method: "get",
  path: "/api/agents/{agentId}/mcp",
  tags: tag,
  summary: "List the agent's MCP servers and templates",
  middleware,
  request: { params: AgentParams, query: MetaQuery },
  responses: {
    200: jsonOf(
      z
        .object({
          servers: z.array(McpServerSchema),
          redirect_uri: z.string(),
          templates: z.array(z.string()),
          catalog: z.array(McpCatalogEntrySchema),
          user_servers: z.boolean(),
        })
        .openapi("McpServerList")
    ),
    ...refusals(404),
  },
});

const addServerRoute = createRoute({
  method: "post",
  path: "/api/agents/{agentId}/mcp",
  tags: tag,
  summary: "Add an MCP server",
  middleware,
  request: {
    params: AgentParams,
    query: MetaQuery,
    body: { content: { "application/json": { schema: McpBodySchema } } },
  },
  responses: { 200: ServerAnswer, ...refusals(400, 403, 404, 409) },
});

const patchServerRoute = createRoute({
  method: "patch",
  path: "/api/agents/{agentId}/mcp/{serverId}",
  tags: tag,
  summary: "Change an MCP server",
  middleware,
  request: {
    params: ServerParams,
    query: MetaQuery,
    body: { content: { "application/json": { schema: McpBodySchema } } },
  },
  responses: { 200: ServerAnswer, ...refusals(400, 403, 404, 409) },
});

const deleteServerRoute = createRoute({
  method: "delete",
  path: "/api/agents/{agentId}/mcp/{serverId}",
  tags: tag,
  summary: "Remove an MCP server",
  middleware,
  request: { params: ServerParams, query: MetaQuery },
  responses: { 200: jsonOf(OkSchema), ...refusals(403, 404) },
});

const connectServerRoute = createRoute({
  method: "post",
  path: "/api/agents/{agentId}/mcp/{serverId}/connect",
  tags: tag,
  summary: "Start OAuth for a server",
  description: "Open `authorize_url` in a browser; the provider sends it back here.",
  middleware,
  request: {
    params: ServerParams,
    query: MetaQuery,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            return_to: z.string().optional().openapi({ description: "Where to land after." }),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonOf(z.object({ authorize_url: z.string() })),
    ...refusals(404, 502),
  },
});

export function mcpRoutes(app: ApiApp) {
  app.openapi(listServersRoute, async (c) => c.json(await listServers(mcpCall(c.var.call)), 200));

  app.openapi(addServerRoute, async (c) =>
    c.json(await addServer(mcpCall(c.var.call), c.req.valid("json")), 200)
  );

  app.openapi(patchServerRoute, async (c) =>
    c.json(
      await patchServer(mcpCall(c.var.call), c.req.valid("param").serverId, c.req.valid("json")),
      200
    )
  );

  app.openapi(deleteServerRoute, async (c) => {
    const call = mcpCall(c.var.call);
    if (!(await call.manages())) throw refused();
    await call.reg.removeMcpServer(c.req.valid("param").serverId);
    return c.json({ ok: true }, 200);
  });

  app.openapi(connectServerRoute, async (c) =>
    c.json(
      await connectServer(
        mcpCall(c.var.call),
        c.req.valid("param").serverId,
        c.req.valid("json").return_to ?? ""
      ),
      200
    )
  );

  const action = (
    name: string,
    summary: string,
    run: (call: McpCall, id: string) => Promise<{ server: McpServerView }>
  ) => ({ name, summary, run }) as const;
  for (const { name, summary, run } of [
    action("disconnect", "Forget a server's OAuth tokens", disconnectServer),
    action("refresh", "Re-read a server's tools", refreshServer),
    action("recommend", "Let the agent's model choose which tools to keep on", recommendTools),
  ]) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/api/agents/{agentId}/mcp/{serverId}/${name}`,
        tags: tag,
        summary,
        middleware,
        request: { params: ServerParams, query: MetaQuery },
        responses: { 200: ServerAnswer, ...refusals(400, 404, 409, 502) },
      }),
      async (c) => c.json(await run(mcpCall(c.var.call), c.req.valid("param").serverId), 200)
    );
  }
}

async function listServers({ env, url, reg, manages }: McpCall) {
  const servers = await reg.mcpServers();
  const reveal = await manages();
  const { mcp } = await reg.meta();
  const settings = await deploymentSettings(env);
  return {
    servers: servers.map((row) => mcpView(row, reveal)),
    // Shown on the page: a provider may ask for it when registering by hand.
    redirect_uri: redirectUri(url.origin),
    // Sent here because `/meta` is admin-only. Empty `templates` offers all; the agent's
    // own catalogue replaces the deployment's.
    templates: mcp.templates,
    catalog: mcp.catalog.length ? mcp.catalog : settings.mcp_catalog,
    user_servers: mcp.user_servers,
  };
}

async function addServer({ reg, manages }: McpCall, body: Record<string, unknown>) {
  if (!(await manages())) throw refused();
  let patch: Partial<McpServerRow>;
  try {
    patch = validateMcpBody(body);
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  if (!patch.name || !patch.url) throw new ApiError(400, "name and url are required");
  try {
    await assertNameFree(reg, patch.name);
  } catch (err) {
    throw new ApiError(409, errorMessage(err));
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
  return { server: mcpView(synced, true) };
}

async function connectServer({ url, agentId, reg }: McpCall, id: string, returnTo: string) {
  const row = await reg.mcpServer(id);
  if (!row) throw noSuchServer();
  try {
    const authorizeUrl = await startMcpOauth(reg, agentId, row, url.origin, returnTo);
    return { authorize_url: authorizeUrl };
  } catch (err) {
    const message = errorMessage(err);
    await reg.updateMcpServer(id, { last_error: message });
    throw new ApiError(502, message);
  }
}

/** Forget the tokens but keep the server, so reconnecting is one click. */
async function disconnectServer({ reg, manages }: McpCall, id: string) {
  const row = await reg.updateMcpServer(id, {
    oauth_access_token: "",
    oauth_refresh_token: "",
    oauth_expires_at: 0,
    oauth_verifier: "",
    oauth_state: "",
    tools_json: "",
    last_error: "",
  });
  if (!row) throw noSuchServer();
  return { server: mcpView(row, await manages()) };
}

async function refreshServer({ reg, manages }: McpCall, id: string) {
  const row = await reg.mcpServer(id);
  if (!row) throw noSuchServer();
  const synced = await syncMcpTools(reg, row);
  return { server: mcpView(synced, await manages()) };
}

/**
 * Let the agent's model choose which tools to keep on, and apply the choice. Not gated
 * on `manages()`: it only writes `disabled_tools`, the same write the tool chips do.
 */
async function recommendTools({ env, agentId, reg, manages }: McpCall, id: string) {
  const row = await reg.mcpServer(id);
  if (!row) throw noSuchServer();
  const tools = parseTools(row.tools_json);
  if (tools.length === 0) {
    throw new ApiError(409, "This server hasn't listed any tools yet. Refresh it first.");
  }
  const config = await readConfig(env, reg);
  if (!config.openrouter_api_key) {
    throw new ApiError(400, "OpenRouter API key is missing. Add it in Settings.");
  }
  let keep: string[];
  try {
    keep = await recommendMcpTools(row, config, tools);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`mcp recommend failed for ${row.name} on agent ${agentId}: ${message}`);
    throw new ApiError(502, message);
  }
  const kept = new Set(keep);
  const updated = await reg.updateMcpServer(id, {
    // Stored as exclusions, so a tool the provider adds later arrives switched on.
    disabled_tools: JSON.stringify(
      tools.filter((tool) => !kept.has(tool.name)).map((tool) => tool.name)
    ),
  });
  if (!updated) throw noSuchServer();
  return { server: mcpView(updated, await manages()) };
}

async function patchServer({ reg, manages }: McpCall, id: string, body: Record<string, unknown>) {
  const existing = await reg.mcpServer(id);
  if (!existing) throw noSuchServer();
  let patch: Partial<McpServerRow>;
  try {
    patch = validateMcpBody(body);
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  if (LIST_FIELDS.some((key) => patch[key] !== undefined) && !(await manages())) {
    throw refused();
  }
  if (patch.name && patch.name !== existing.name) {
    try {
      await assertNameFree(reg, patch.name, id);
    } catch (err) {
      throw new ApiError(409, errorMessage(err));
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
  if (!updated) throw noSuchServer();
  const changed = REREAD_FIELDS.some((key) => patch[key] !== undefined);
  return {
    server: mcpView(changed ? await syncMcpTools(reg, updated) : updated, await manages()),
  };
}
