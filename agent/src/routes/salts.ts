// salts-tools computers. A laptop running salts-tools pairs once (the signed-in user
// approves a code in the browser), then reports in every 30 seconds with its tunnel, its
// gateway token and which tools it can run. The Worker answers with the tools wanted, and
// keeps every linked agent's side in step: the SearXNG URL and token, and one MCP server
// per tool, authenticated with the gateway token. Switching a tool off, unlinking an agent
// or disconnecting the computer takes back what was put there.
//
// Machine routes (`/salts/…`) prove themselves with the pairing device code or the
// computer's credential. Browser routes (`/api/salts/…`) need a Clerk session.

import { CAPABILITIES } from "../capabilities";
import type { Env } from "../env";
import { type McpServerRow, parseHeaders } from "../mcp";
import { type ComputerLink, type ComputerRow, type Config, EMPTY_MCP_SERVER } from "../registry";
import { callerEmail, mayUseAgent } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { syncMcpTools } from "../worker/integrations";
import { directory, type Registry, readConfig, registry, writeConfig } from "../worker/stores";
import { HEADER_NAME, sameSecret, trustsToken, withEmpty } from "./searxng";

/** How long a pairing code waits for the user. */
export const PAIR_TTL = 10 * 60 * 1000;
/** Pairings waiting at once, across the deployment; past this, new ones are refused. */
const MAX_PENDING = 500;
/** Agents one approval may link. */
const MAX_LINKED = 50;
/** A computer counts as online this long after it last reported. */
export const ONLINE_WINDOW = 90 * 1000;
const MAX_TOOLS = 8;
const TOOL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATES = new Set(["ready", "starting", "missing", "failed", "off"]);
/** The capability switches a tool may say it needs. */
const FLAGS = new Map(CAPABILITIES.map((c) => [c.flag as string, c.label]));

/** One tool as the computer reports it. */
export type ReportedTool = {
  kind: "searxng" | "mcp";
  state: string;
  /** Why it is not ready: what to install, or the error. */
  detail: string;
  label: string;
  /** For an MCP tool: header names put on its server empty, for the user to fill in. */
  headers: string[];
  /** Capability flags the agent needs switched on to use it. */
  needs: string[];
};

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const random = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** The code the user types or follows: 8 letters and digits nobody misreads, as XXXX-XXXX. */
function userCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** A computer's credential: `salts_c_<computerId>_<secret>`. Only its hash is stored. */
const CREDENTIAL = /^salts_c_([a-f0-9]{12})_([a-f0-9]{64})$/;

const bearer = (request: Request) =>
  (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

/** The computer a request's credential belongs to, or undefined. */
async function computerCaller(request: Request, env: Env): Promise<ComputerRow | undefined> {
  const offered = bearer(request);
  const match = CREDENTIAL.exec(offered);
  if (!match) return undefined;
  const row = await directory(env).computer(match[1]);
  if (!row) return undefined;
  return (await sameSecret(await sha256(offered), row.cred_hash)) ? row : undefined;
}

const parseList = (raw: string): string[] => {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

export function reportedTools(raw: string): Record<string, ReportedTool> {
  try {
    const tools = JSON.parse(raw);
    return tools && typeof tools === "object" && !Array.isArray(tools) ? tools : {};
  } catch {
    return {};
  }
}

/** A computer's report of its tools, cleaned, or a reason it is refused. */
export function validateTools(raw: unknown): Record<string, ReportedTool> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "tools must be an object";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TOOLS) return `at most ${MAX_TOOLS} tools`;
  const out: Record<string, ReportedTool> = {};
  for (const [name, value] of entries) {
    if (!TOOL_NAME.test(name)) return `tool names are short lowercase slugs: ${name}`;
    const t = (value ?? {}) as Record<string, unknown>;
    if (t.kind !== "searxng" && t.kind !== "mcp") return `${name}: kind is searxng or mcp`;
    const state = String(t.state ?? "");
    if (!STATES.has(state)) return `${name}: unknown state ${state}`;
    const headers = Array.isArray(t.headers) ? t.headers.map(String) : [];
    if (
      headers.length > 8 ||
      headers.some((h) => !HEADER_NAME.test(h) || h.toLowerCase() === "authorization")
    ) {
      return `${name}: headers are up to 8 header names, not Authorization`;
    }
    const needs = Array.isArray(t.needs) ? t.needs.map(String) : [];
    if (needs.some((f) => !FLAGS.has(f))) return `${name}: needs names capability flags`;
    out[name] = {
      kind: t.kind,
      state,
      detail: String(t.detail ?? "").slice(0, 300),
      label: String(t.label ?? name).slice(0, 40),
      headers,
      needs,
    };
  }
  if (Object.values(out).filter((t) => t.kind === "searxng").length > 1)
    return "one searxng tool at most";
  return out;
}

/** The gateway tokens servers made for this computer may carry: the current one, then the last. */
const tokensOf = (c: ComputerRow) => [c.gateway_token, c.old_gateway_token].filter(Boolean);

async function trustsAny(row: McpServerRow, tokens: string[]): Promise<boolean> {
  for (const token of tokens) if (await trustsToken(row, token)) return true;
  return false;
}

async function isAny(value: string, tokens: string[]): Promise<boolean> {
  for (const token of tokens) if (value && (await sameSecret(value, token))) return true;
  return false;
}

/**
 * Bring one linked agent's side in step with the computer: what is switched on there is
 * put in place (pointed at the tunnel, with the gateway token), what is not is taken out.
 * Only what carries this computer's token is ever changed or removed. Skipped when nothing
 * changed since the last time.
 */
export async function syncLink(env: Env, c: ComputerRow, link: ComputerLink, force = false) {
  if (!c.gateway_token) return;
  // With no tunnel yet, only taking things out can be done.
  const on = c.tunnel_url ? parseList(link.tools) : [];
  const tools = reportedTools(c.tools);
  const key = JSON.stringify([c.tunnel_url, c.gateway_token, on, tools]);
  if (!force && link.synced === key) return;

  const reg = registry(env, link.agent_id);
  const tokens = tokensOf(c);
  const tunnel = c.tunnel_url.replace(/\/+$/, "");

  // Web search: at most one SearXNG per agent, so the config fields are this computer's
  // only while they carry its token.
  const web = Object.entries(tools).find(([name, t]) => t.kind === "searxng" && on.includes(name));
  const config = await readConfig(env, reg);
  if (web) {
    const url = `${tunnel}/${web[0]}`;
    if (config.searxng_url !== url || config.searxng_token !== c.gateway_token) {
      await writeConfig(env, reg, { searxng_url: url, searxng_token: c.gateway_token });
    }
  } else if (await isAny(config.searxng_token, tokens)) {
    await writeConfig(env, reg, { searxng_url: "", searxng_token: "" });
  }

  await syncServers(reg, tools, on, tunnel, c.gateway_token, tokens);
  await directory(env).markComputerLinkSynced(c.id, link.agent_id, key);
}

async function syncServers(
  reg: Registry,
  tools: Record<string, ReportedTool>,
  on: string[],
  tunnel: string,
  token: string,
  tokens: string[]
) {
  const servers = await reg.mcpServers();
  // Out: this computer's servers whose tool is no longer on here.
  for (const row of servers) {
    const name = row.name.toLowerCase();
    if (tools[name]?.kind === "mcp" && on.includes(name)) continue;
    if (await trustsAny(row, tokens)) await reg.removeMcpServer(row.id);
  }
  if (!(await reg.meta()).mcp.user_servers) return;
  // In: each MCP tool switched on, created or repointed.
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.kind !== "mcp" || !on.includes(name)) continue;
    const url = `${tunnel}/${name}/mcp`;
    const existing = servers.find((s) => s.name.toLowerCase() === name);
    if (!existing) {
      const row: McpServerRow = {
        ...EMPTY_MCP_SERVER,
        id: crypto.randomUUID().slice(0, 8),
        created_at: Date.now(),
        name,
        url,
        auth: "headers",
        headers: JSON.stringify(withEmpty({ Authorization: `Bearer ${token}` }, tool.headers)),
        enabled: 1,
      };
      await reg.addMcpServer(row);
      await syncMcpTools(reg, row);
      continue;
    }
    // A server of that name someone set up some other way is never touched.
    if (!(await trustsAny(existing, tokens))) continue;
    const current = parseHeaders(existing.headers);
    const auth =
      Object.keys(current).find((k) => k.toLowerCase() === "authorization") ?? "Authorization";
    const headers = withEmpty({ ...current, [auth]: `Bearer ${token}` }, tool.headers);
    const patch: Partial<McpServerRow> = {};
    if (JSON.stringify(headers) !== JSON.stringify(current))
      patch.headers = JSON.stringify(headers);
    if (existing.url !== url) Object.assign(patch, { url, tools_json: "" });
    if (!Object.keys(patch).length) continue;
    const updated = await reg.updateMcpServer(existing.id, patch);
    if (updated && patch.url) await syncMcpTools(reg, updated);
  }
}

/** Take a computer's tools out of one agent: the link with nothing on, synced. */
async function clearLink(env: Env, c: ComputerRow, link: ComputerLink) {
  await syncLink(env, c, { ...link, tools: "[]" }, true);
}

/** Sync every link of a computer; one agent failing does not hold up the others. */
async function syncAll(env: Env, c: ComputerRow, links: ComputerLink[]) {
  for (const link of links) {
    try {
      await syncLink(env, c, link);
    } catch (err) {
      console.error(`salts: syncing ${c.id} to ${link.agent_id} failed`, err);
    }
  }
}

/**
 * Called as the user removes an MCP server: one a linked computer put there (it carries
 * that computer's gateway token) has its tool switched off for this agent, so it stays gone.
 */
export async function forgetRemovedTool(env: Env, agentId: string, row: McpServerRow) {
  const dir = directory(env);
  for (const link of await dir.agentComputerLinks(agentId)) {
    const c = await dir.computer(link.computer_id);
    if (!c || !(await trustsAny(row, tokensOf(c)))) continue;
    const on = parseList(link.tools).filter((t) => t !== row.name.toLowerCase());
    await dir.setComputerLink(link.computer_id, agentId, on);
  }
}

// ─── machine routes ─────────────────────────────────────────────────────────────

/** `/salts/…`: pairing, and the computer's own report. Undefined when not one of these. */
export async function handleSaltsMachine(
  request: Request,
  env: Env,
  segments: string[]
): Promise<Response | undefined> {
  const [, second, third] = segments;
  const method = request.method;
  if (method === "POST" && second === "pair" && !third) return await startPairing(request, env);
  if (method === "POST" && second === "pair" && third === "poll" && !segments[3]) {
    return await pollPairing(request, env);
  }
  if (second === "computer" && !third) {
    if (method === "PUT") return await report(request, env);
    if (method === "DELETE") return await unpairSelf(request, env);
  }
  return undefined;
}

async function startPairing(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ name?: unknown }>(request);
  const name =
    String(body.name ?? "")
      .trim()
      .slice(0, 60) || "A computer";
  const deviceCode = random(32);
  const code = userCode();
  const opened = await directory(env).startPairing({
    userCode: code,
    deviceHash: await sha256(deviceCode),
    name,
    now: Date.now(),
    ttl: PAIR_TTL,
    maxPending: MAX_PENDING,
  });
  if (!opened)
    return jsonError("too many computers are pairing right now; try again in a few minutes", 429);
  return json({
    user_code: code,
    device_code: deviceCode,
    expires_in: PAIR_TTL / 1000,
    interval: 3,
  });
}

async function pollPairing(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ device_code?: unknown }>(request);
  const deviceCode = String(body.device_code ?? "");
  if (!/^[a-f0-9]{64}$/.test(deviceCode)) return jsonError("device_code is required", 400);
  return json(await directory(env).pollPairing(await sha256(deviceCode), Date.now()));
}

/** What a computer is told: who it is, its agents with their tools, and every tool wanted. */
async function computerView(env: Env, c: ComputerRow, links: ComputerLink[]) {
  const agents = links.map((l) => ({
    id: l.agent_id,
    name: l.agent_name,
    tools: parseList(l.tools),
  }));
  return {
    computer: { id: c.id, name: c.name },
    agents,
    wanted: [...new Set(agents.flatMap((a) => a.tools))].sort(),
  };
}

async function report(request: Request, env: Env): Promise<Response> {
  const c = await computerCaller(request, env);
  if (!c) return jsonError("unauthorized", 401);
  const body = await readJson<{
    tunnel_url?: unknown;
    gateway_token?: unknown;
    tools?: unknown;
    version?: unknown;
  }>(request);
  const tools = validateTools(body.tools ?? {});
  if (typeof tools === "string") return jsonError(tools, 400);
  const gateway = String(body.gateway_token ?? "");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(gateway))
    return jsonError("gateway_token must be 32-128 URL-safe characters", 400);
  let tunnel = "";
  if (body.tunnel_url) {
    try {
      const parsed = new URL(String(body.tunnel_url));
      // Every call carries the gateway token, so the transport has to be encrypted.
      if (parsed.protocol !== "https:") throw new Error();
      tunnel = parsed.toString().replace(/\/+$/, "");
    } catch {
      return jsonError("tunnel_url must be an absolute https URL", 400);
    }
  }

  const dir = directory(env);
  await dir.reportComputer(c.id, {
    tunnel_url: tunnel,
    gateway_token: gateway,
    tools: JSON.stringify(tools),
    version: String(body.version ?? "").slice(0, 40),
    now: Date.now(),
  });
  const updated = (await dir.computer(c.id))!;
  const links = await dir.computerLinks(c.id);
  await syncAll(env, updated, links);
  return json(await computerView(env, updated, links));
}

/** The computer forgetting itself (`salts-tools reset`): everything it put anywhere goes. */
async function unpairSelf(request: Request, env: Env): Promise<Response> {
  const c = await computerCaller(request, env);
  if (!c) return jsonError("unauthorized", 401);
  await disconnect(env, c);
  return json({ ok: true });
}

async function disconnect(env: Env, c: ComputerRow) {
  const dir = directory(env);
  for (const link of await dir.computerLinks(c.id)) {
    try {
      await clearLink(env, c, link);
    } catch (err) {
      console.error(`salts: clearing ${c.id} from ${link.agent_id} failed`, err);
    }
  }
  await dir.removeComputer(c.id);
}

// ─── browser routes ─────────────────────────────────────────────────────────────

type Todo =
  | { kind: "capability"; tool: string; flag: string; label: string }
  | { kind: "brave"; tool: string }
  | { kind: "headers"; tool: string; server_id: string; headers: string[] }
  | { kind: "disabled"; tool: string; server_id: string }
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
    if (empty.length)
      todos.push({ kind: "headers", tool: name, server_id: server.id, headers: empty });
    if (!server.enabled) todos.push({ kind: "disabled", tool: name, server_id: server.id });
  }
  return todos;
}

async function computerPage(env: Env, c: ComputerRow) {
  const links = await directory(env).computerLinks(c.id);
  return {
    id: c.id,
    name: c.name,
    version: c.version,
    online: !!c.last_seen && Date.now() - c.last_seen < ONLINE_WINDOW,
    last_seen: c.last_seen,
    created_at: c.created_at,
    tools: reportedTools(c.tools),
    agents: await Promise.all(
      links.map(async (l) => {
        const on = parseList(l.tools);
        return {
          id: l.agent_id,
          name: l.agent_name,
          tools: on,
          todos: await todosFor(env, c, l.agent_id, on),
        };
      })
    ),
  };
}

/** The caller's own computer, or undefined (someone else's is as good as missing). */
async function ownComputer(env: Env, email: string, id: string) {
  const c = await directory(env).computer(id);
  return c && email && c.owner_email === email ? c : undefined;
}

const computerNotFound = () => jsonError("computer not found", 404);

/** `/api/salts/…`. Undefined when the path is not one of these. */
export async function handleSaltsBrowser(
  request: Request,
  env: Env,
  segments: string[]
): Promise<Response | undefined> {
  const [, , third, fourth, fifth, sixth] = segments;
  const method = request.method;
  const email = await callerEmail(request, env);
  if (!email) return jsonError("unauthorized", 401);

  if (third === "pair" && fourth && !fifth) {
    const code = decodeURIComponent(fourth).toUpperCase();
    if (method === "GET") {
      const live = await directory(env).pairing(code, Date.now());
      return live
        ? json(live)
        : jsonError("This code has expired. Run salts-tools again for a new one.", 404);
    }
    if (method === "POST") return await approve(request, env, email, code);
  }

  if (third !== "computers") return undefined;
  if (!fourth) return method === "GET" ? await listComputers(env, email) : undefined;

  const c = await ownComputer(env, email, decodeURIComponent(fourth));
  if (!c) return computerNotFound();
  if (!fifth) {
    if (method === "GET") return json(await computerPage(env, c));
    if (method === "DELETE") {
      await disconnect(env, c);
      return json({ ok: true });
    }
    return undefined;
  }
  if (fifth !== "agents" || !sixth || segments[6]) return undefined;
  const agentId = decodeURIComponent(sixth);
  if (method === "PUT") return await setTools(request, env, c, agentId);
  if (method === "DELETE") return await unlink(env, c, agentId);
  return undefined;
}

async function approve(request: Request, env: Env, email: string, code: string): Promise<Response> {
  const body = await readJson<{ agent_ids?: unknown }>(request);
  const ids = Array.isArray(body.agent_ids) ? [...new Set(body.agent_ids.map(String))] : [];
  if (!ids.length) return jsonError("choose at least one agent", 400);
  if (ids.length > MAX_LINKED) return jsonError(`at most ${MAX_LINKED} agents at once`, 400);
  for (const id of ids) {
    if (!(await mayUseAgent(request, env, id))) return jsonError(`agent ${id} not found`, 404);
  }
  const computerId = random(6);
  const credential = `salts_c_${computerId}_${random(32)}`;
  const approved = await directory(env).approvePairing(code, Date.now(), {
    computerId,
    email,
    credHash: await sha256(credential),
    credential,
    agentIds: ids,
  });
  if (!approved)
    return jsonError("This code has expired or was already used. Run salts-tools again.", 404);
  return json({ computer_id: computerId });
}

async function listComputers(env: Env, email: string): Promise<Response> {
  const rows = await directory(env).computersOf(email);
  return json({ computers: await Promise.all(rows.map((c) => computerPage(env, c))) });
}

/** Link the agent (when it is not yet) with exactly these tools on, and sync it now. */
async function setTools(
  request: Request,
  env: Env,
  c: ComputerRow,
  agentId: string
): Promise<Response> {
  if (!(await mayUseAgent(request, env, agentId))) return jsonError("agent not found", 404);
  const body = await readJson<{ tools?: unknown }>(request);
  if (!Array.isArray(body.tools)) return jsonError("tools must be a list of tool names", 400);
  const tools = [...new Set(body.tools.map(String))];
  if (tools.length > MAX_TOOLS || tools.some((t) => !TOOL_NAME.test(t))) {
    return jsonError("tools must be a list of tool names", 400);
  }
  const dir = directory(env);
  await dir.setComputerLink(c.id, agentId, tools);
  const link = (await dir.computerLinks(c.id)).find((l) => l.agent_id === agentId);
  if (link) await syncLink(env, c, link);
  return json(await computerPage(env, c));
}

async function unlink(env: Env, c: ComputerRow, agentId: string): Promise<Response> {
  const dir = directory(env);
  const link = (await dir.computerLinks(c.id)).find((l) => l.agent_id === agentId);
  if (!link) return jsonError("agent not linked", 404);
  await clearLink(env, c, link);
  await dir.removeComputerLink(c.id, agentId);
  return json(await computerPage(env, c));
}
