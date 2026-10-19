// The agents a paired computer serves, managed from the CLI with its credential:
// `/salts/computer/agents[/:agentId[/capability|/headers]]`. Only the agents registered
// on this computer are listed (an owner may have a fleet), with the tools on and what is
// left to do; registering one by id (POST), switching tools (PUT), unregistering (DELETE)
// one, switching on a capability a tool needs and filling in its header values happen
// here, so the browser is needed for pairing only.

import { CAPABILITIES } from "../capabilities";
import type { Env } from "../env";
import { parseHeaders } from "../mcp";
import { type ComputerRow, type Config, emailAllowed } from "../registry";
import { lockedColumns } from "../validation/meta";
import { agentAccess } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { directory, readConfig, registry, writeConfig } from "../worker/stores";
import {
  clearLink,
  FLAGS,
  MAX_LINKED,
  MAX_TOOLS,
  parseList,
  reportedTools,
  syncLink,
  TOOL_NAME,
  tokensOf,
  trustsAny,
} from "./salts";

/** `agentId` absent: the list. Undefined when not one of these routes. */
export async function handleComputerAgents(
  request: Request,
  env: Env,
  c: ComputerRow,
  agentSegment: string | undefined,
  action: string | undefined
): Promise<Response | undefined> {
  const method = request.method;
  if (!agentSegment)
    return method === "GET" ? json({ agents: await agentsView(env, c) }) : undefined;
  const agentId = decodeURIComponent(agentSegment);
  if (!(await isMember(env, c.owner_email, agentId))) return jsonError("agent not found", 404);
  if (!action) {
    if (method === "POST") return await register(env, c, agentId);
    if (method === "PUT") return await setTools(request, env, c, agentId);
    if (method === "DELETE") return await unlink(env, c, agentId);
    return undefined;
  }
  if (action === "capability" && method === "POST") return await turnOn(request, env, c, agentId);
  if (action === "headers" && method === "PUT") return await fillHeaders(request, env, c, agentId);
  return undefined;
}

/** Whether `email` is on the agent's access list: the agents a computer may serve. */
async function isMember(env: Env, email: string, agentId: string): Promise<boolean> {
  const access = await agentAccess(env, agentId);
  return !!access && emailAllowed(access.allowed_emails, email);
}

type Todo =
  | { kind: "capability"; tool: string; flag: string; label: string }
  | { kind: "brave"; tool: string }
  | { kind: "headers"; tool: string; headers: string[] }
  | { kind: "disabled"; tool: string }
  | { kind: "name_taken"; tool: string }
  | { kind: "managed"; tool: string };

/** What is still to do on one agent before each tool switched on there works. */
async function todosFor(env: Env, c: ComputerRow, agentId: string, on: string[]): Promise<Todo[]> {
  const tools = reportedTools(c.tools);
  const reg = registry(env, agentId);
  const config: Config = await readConfig(env, reg);
  const servers = await reg.mcpServers();
  const userServers = (await reg.meta()).mcp.user_servers;
  const todos: Todo[] = [];
  for (const name of on) {
    const tool = tools[name];
    if (!tool) continue;
    for (const flag of tool.needs) {
      if (!config[flag as keyof Config])
        todos.push({ kind: "capability", tool: name, flag, label: FLAGS.get(flag)! });
    }
    if (tool.kind === "searxng") {
      if (config.brave_api_key) todos.push({ kind: "brave", tool: name });
      continue;
    }
    const server = servers.find((s) => s.name.toLowerCase() === name);
    if (!server) {
      if (!userServers) todos.push({ kind: "managed", tool: name });
      continue;
    }
    if (!(await trustsAny(server, tokensOf(c)))) {
      todos.push({ kind: "name_taken", tool: name });
      continue;
    }
    const empty = Object.entries(parseHeaders(server.headers))
      .filter(([, v]) => !v.trim())
      .map(([k]) => k);
    if (empty.length) todos.push({ kind: "headers", tool: name, headers: empty });
    if (!server.enabled) todos.push({ kind: "disabled", tool: name });
  }
  return todos;
}

/**
 * The agents registered on this computer that the owner is still a member of, with the
 * tools on and what is left to do for each.
 */
async function agentsView(env: Env, c: ComputerRow) {
  const dir = directory(env);
  const links = new Map((await dir.computerLinks(c.id)).map((l) => [l.agent_id, l]));
  const rows = (await dir.list(c.owner_email)).filter(
    (a) => links.has(a.id) && emailAllowed(a.allowed_emails, c.owner_email)
  );
  return await Promise.all(
    rows.map(async (a) => {
      const on = parseList(links.get(a.id)!.tools);
      return { id: a.id, name: a.name, tools: on, todos: await todosFor(env, c, a.id, on) };
    })
  );
}

async function agentView(env: Env, c: ComputerRow, agentId: string) {
  return (await agentsView(env, c)).find((a) => a.id === agentId);
}

/** Put the agent on this computer's list with no tools on; one already there is left as is. */
async function register(env: Env, c: ComputerRow, agentId: string): Promise<Response> {
  if (!(await linkOf(env, c, agentId))) {
    const dir = directory(env);
    if ((await dir.computerLinks(c.id)).length >= MAX_LINKED) {
      return jsonError(`one computer serves at most ${MAX_LINKED} agents`, 400);
    }
    await dir.setComputerLink(c.id, agentId, []);
  }
  return json(await agentView(env, c, agentId));
}

/**
 * Serve the agent (registering it when it is not yet) with exactly these tools on, and
 * sync it now. No tools registers it with everything off.
 */
async function setTools(
  request: Request,
  env: Env,
  c: ComputerRow,
  agentId: string
): Promise<Response> {
  const body = await readJson<{ tools?: unknown }>(request);
  if (!Array.isArray(body.tools)) return jsonError("tools must be a list of tool names", 400);
  const tools = [...new Set(body.tools.map(String))];
  if (tools.length > MAX_TOOLS || tools.some((t) => !TOOL_NAME.test(t))) {
    return jsonError("tools must be a list of tool names", 400);
  }
  const dir = directory(env);
  if ((await dir.computerLinks(c.id)).length >= MAX_LINKED && !(await linkOf(env, c, agentId))) {
    return jsonError(`one computer serves at most ${MAX_LINKED} agents`, 400);
  }
  await dir.setComputerLink(c.id, agentId, tools);
  const link = await linkOf(env, c, agentId);
  if (link) await syncLink(env, c, link);
  return json(await agentView(env, c, agentId));
}

const linkOf = async (env: Env, c: ComputerRow, agentId: string) =>
  (await directory(env).computerLinks(c.id)).find((l) => l.agent_id === agentId);

/** Unregister: every tool taken off the agent, and it leaves this computer's list. */
async function unlink(env: Env, c: ComputerRow, agentId: string): Promise<Response> {
  const link = await linkOf(env, c, agentId);
  if (!link) return jsonError("agent not served by this computer", 404);
  await clearLink(env, c, link);
  await directory(env).removeComputerLink(c.id, agentId);
  return json({ id: agentId });
}

/**
 * Switch on a capability a tool on this agent needs. Only those flags, and never one
 * the agent's admin locked.
 */
async function turnOn(
  request: Request,
  env: Env,
  c: ComputerRow,
  agentId: string
): Promise<Response> {
  const { flag } = await readJson<{ flag?: unknown }>(request);
  const link = await linkOf(env, c, agentId);
  const tools = reportedTools(c.tools);
  const needed = parseList(link?.tools ?? "[]").some((t) => tools[t]?.needs.includes(String(flag)));
  if (!needed) return jsonError("no tool on for this agent needs that", 400);
  const reg = registry(env, agentId);
  const capability = CAPABILITIES.find((cap) => cap.flag === flag)!;
  const locked = (await reg.meta()).locked;
  if (locked.includes(capability.id) || lockedColumns(locked).has(String(flag))) {
    return jsonError(`${capability.label} is set by this agent's admin`, 403);
  }
  await writeConfig(env, reg, { [String(flag)]: 1 } as Partial<Config>);
  return json(await agentView(env, c, agentId));
}

/**
 * Fill in header values on the MCP server a tool put on this agent: only the header
 * names the tool asks for, and only on a server carrying this computer's token. Values
 * are never sent back.
 */
async function fillHeaders(
  request: Request,
  env: Env,
  c: ComputerRow,
  agentId: string
): Promise<Response> {
  const body = await readJson<{ tool?: unknown; headers?: unknown }>(request);
  const name = String(body.tool ?? "");
  const tool = reportedTools(c.tools)[name];
  const link = await linkOf(env, c, agentId);
  if (!tool || tool.kind !== "mcp" || !parseList(link?.tools ?? "[]").includes(name)) {
    return jsonError("that tool is not on for this agent", 400);
  }
  const given = (body.headers ?? {}) as Record<string, unknown>;
  if (typeof given !== "object" || Array.isArray(given))
    return jsonError("headers must be an object", 400);
  const allowed = new Map(tool.headers.map((h) => [h.toLowerCase(), h]));
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    const header = allowed.get(key.toLowerCase());
    if (!header) return jsonError(`${name} does not take ${key}`, 400);
    const text = String(value ?? "").trim();
    if (text.length > 500 || /[\r\n]/.test(text))
      return jsonError(`${header} is not a header value`, 400);
    values[header] = text;
  }
  const reg = registry(env, agentId);
  const server = (await reg.mcpServers()).find((s) => s.name.toLowerCase() === name);
  if (!server || !(await trustsAny(server, tokensOf(c)))) {
    return jsonError(`${name} is not set up on this agent yet`, 409);
  }
  const current = parseHeaders(server.headers);
  const merged = { ...current };
  for (const [header, value] of Object.entries(values)) {
    const key =
      Object.keys(current).find((k) => k.toLowerCase() === header.toLowerCase()) ?? header;
    merged[key] = value;
  }
  await reg.updateMcpServer(server.id, { headers: JSON.stringify(merged) });
  return json(await agentView(env, c, agentId));
}
