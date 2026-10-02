import type { Env } from "../env";
import { modelCatalog } from "../models";
import {
  type AgentRow,
  DEFAULT_META,
  type MetadataFilter,
  type MetaSettings,
  normalizeEmails,
  splitEmails,
} from "../registry";
import { deploymentSettings } from "../settings";
import { validateMeta, validateMetadata } from "../validation/meta";
import { callerEmail } from "../worker/auth";
import { capabilitiesFor, notedCapabilities } from "../worker/capability-views";
import { errorMessage, json, jsonError, listEntries, readJson } from "../worker/http";
import { checkOpenrouterKey } from "../worker/integrations";
import { agentFor, deleteAgent, provisionAgent } from "../worker/provisioning";
import { AGENT_ID, directory } from "../worker/stores";

/** A listing's metadata filter, from `?with=key:value` and `?without=key`. */
export function metadataFilter(url: URL): MetadataFilter | undefined {
  const withParam = url.searchParams.get("with") ?? "";
  const without = url.searchParams.get("without") ?? "";
  const cut = withParam.indexOf(":");
  const filter: MetadataFilter = {
    ...(cut > 0
      ? { with: [withParam.slice(0, cut), withParam.slice(cut + 1)] as [string, string] }
      : {}),
    ...(without ? { without } : {}),
  };
  return filter.with || filter.without ? filter : undefined;
}

/** The refusal for an account that would go over its agent ceiling. */
export function agentLimitError(limit: number): Response {
  return jsonError(
    `this account may administer at most ${limit} agent${limit === 1 ? "" : "s"}`,
    403
  );
}

/**
 * One address per entry, repeats kept: the same address twice in a fleet is two agents
 * for that person. Anything that is not an address drops out.
 */
export function fleetMembers(input: string | string[] | undefined): string[] {
  return listEntries(input)
    .map((entry) => normalizeEmails([entry], 1))
    .filter(Boolean);
}

/**
 * `/api/agents` itself and its catalogue. One agent's routes are the typed API's (`src/api`).
 * Undefined when the path is not one of these.
 */
export async function handleAgents(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const agentId = segments[2];

  if (!agentId) {
    if (request.method === "GET") return await listAgents(request, env, url);
    if (request.method === "DELETE") return await deleteFleetBatch(request, env, url);
    if (request.method === "POST") return await createAgents(request, env, url);
    return undefined;
  }

  // The create dialog's catalogues, before there is an agent to hang them off.
  if (agentId === "catalog" && request.method === "GET") {
    const settings = await deploymentSettings(env);
    return json({
      models: modelCatalog(settings),
      capabilities: notedCapabilities(capabilitiesFor(DEFAULT_META, settings), settings),
      mcp_catalog: settings.mcp_catalog,
    });
  }

  return undefined;
}

/**
 * The agents the caller may open. `?fleet=` pages through one fleet (its administrator
 * only); `?as=guest` lists the agents the caller may only message.
 */
async function listAgents(request: Request, env: Env, url: URL): Promise<Response> {
  const dir = directory(env);
  const email = await callerEmail(request, env);
  // 0 lets the directory apply the deployment's `agent_page`.
  const limit = Number(url.searchParams.get("limit")) || 0;
  const cursor = url.searchParams.get("cursor") ?? "";
  const fleetId = url.searchParams.get("fleet") ?? "";

  if (fleetId) {
    if (!email) return jsonError("not allowed", 403);
    const fleets = await dir.listFleets(email);
    if (!fleets.some((f) => f.fleet_id === fleetId)) return jsonError("not allowed", 403);
    const fleetPage = await dir.listFleetPage(fleetId, limit, cursor);
    return json({ ...fleetPage, agents: fleetPage.agents.map((row) => agentFor(row, email)) });
  }

  const filter = metadataFilter(url);
  if (url.searchParams.get("as") === "guest") {
    return json(await dir.listGuestPage(email, limit, cursor, filter));
  }

  const agentLimit = email ? await dir.getAgentLimit(email) : 0;
  const owned = email ? await dir.countByAdmin(email) : 0;
  // Fleets come whole (name and count); the page is everything outside them.
  const page = email
    ? await dir.listPage(email, limit, cursor, filter)
    : { agents: [], has_more: false, cursor: "" };
  return json({
    ...page,
    agents: page.agents.map((row) => agentFor(row, email)),
    fleets: email ? await dir.listFleets(email) : [],
    agent_limit: agentLimit,
    agents_owned: owned,
  });
}

/** Delete one batch of a fleet's agents; the caller repeats until `done`. */
async function deleteFleetBatch(request: Request, env: Env, url: URL): Promise<Response> {
  const dir = directory(env);
  const email = await callerEmail(request, env);
  const fleetId = url.searchParams.get("fleet") ?? "";
  if (!email || !fleetId) return jsonError("fleet is required", 400);
  const fleets = await dir.listFleets(email);
  if (!fleets.some((f) => f.fleet_id === fleetId)) return jsonError("not allowed", 403);

  const batch = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 25);
  const page = await dir.listFleetPage(fleetId, batch, "");
  for (const row of page.agents) await deleteAgent(env, url.origin, row.id);

  const left = await dir.listFleets(email);
  const remaining = left.find((f) => f.fleet_id === fleetId)?.agents ?? 0;
  if (remaining === 0) await dir.removeFleetMeta(fleetId);
  return json({ deleted: page.agents.length, remaining, done: remaining === 0 });
}

type CreateBody = {
  name?: string;
  openrouter_api_key?: string;
  allowed_emails?: string | string[];
  /** Non-empty makes a fleet: one agent per address, each holding only that address. */
  fleet_name?: string;
  /** The defaults chosen in the create dialog's second step. */
  meta?: Partial<MetaSettings>;
  /** Tags the creating app attaches, to find its own agents again. */
  metadata?: unknown;
};

/** Create one agent or a fleet. Everything is validated before anything is written. */
async function createAgents(request: Request, env: Env, url: URL): Promise<Response> {
  const dir = directory(env);
  const body = await readJson<CreateBody>(request);
  const settings = await deploymentSettings(env);

  let metadata: Record<string, string>;
  let meta: MetaSettings | undefined;
  let allowed: string;
  try {
    metadata = validateMetadata(body.metadata);
    if (body.meta) meta = validateMeta(body.meta, DEFAULT_META, { creation: true, settings });
    // Exactly what was asked for: the creator is not added. Too many is refused, not trimmed.
    allowed = normalizeEmails(listEntries(body.allowed_emails), settings.max_members);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  if (!allowed) return jsonError("at least one email is required", 400);

  // The top-level key is the older shape of this call; the dialog sends it in `meta`.
  const key = (body.openrouter_api_key ?? meta?.defaults.openrouter_api_key ?? "")
    .trim()
    .slice(0, 1000);
  const openrouter = key ? await checkOpenrouterKey(key) : undefined;
  if (openrouter && !openrouter.ok) return jsonError(openrouter.error, 400);

  // The creator administers the agent; with no caller, the first listed address does.
  const newId = AGENT_ID();
  const admin = (await callerEmail(request, env)) || (splitEmails(allowed)[0] ?? "");

  // A whole fleet is charged against the ceiling at once.
  const fleetName = (body.fleet_name ?? "").trim().slice(0, 60);
  const members = fleetName ? fleetMembers(body.allowed_emails) : [allowed];
  const limit = await dir.getAgentLimit(admin);
  if ((await dir.countByAdmin(admin)) + members.length > limit) return agentLimitError(limit);

  const name = (body.name ?? "").trim().slice(0, 60) || "New agent";
  const fleet = fleetName ? { id: AGENT_ID(), name: fleetName } : undefined;
  // Agents added to the fleet later are created from these settings.
  if (fleet) await dir.setFleetMeta(fleet.id, JSON.stringify(meta ?? DEFAULT_META));
  const created: AgentRow[] = [];
  for (const member of members) {
    const id = created.length === 0 ? newId : AGENT_ID();
    created.push(
      await provisionAgent(env, url.origin, dir, {
        id,
        name,
        allowed: member,
        admin,
        fleet,
        meta,
        key,
        metadata,
      })
    );
  }

  const checked = openrouter ? { openrouter } : {};
  return json(
    fleet ? { agents: created, fleet_id: fleet.id, ...checked } : { ...created[0], ...checked }
  );
}
