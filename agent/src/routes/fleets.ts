import type { Env } from "../env";
import { modelCatalog } from "../models";
import { type AgentRow, DEFAULT_META, type FleetRow, type MetaSettings } from "../registry";
import { deploymentSettings } from "../settings";
import { redactMeta, validateMeta } from "../validation/meta";
import { callerEmail, fleetKeyCaller, newApiKey, newFleetKey } from "../worker/auth";
import { capabilitiesFor } from "../worker/capability-views";
import { errorMessage, json, jsonError, readJson } from "../worker/http";
import { syncWebhook } from "../worker/integrations";
import { applyMeta, provisionAgent } from "../worker/provisioning";
import { AGENT_ID, directory, registry } from "../worker/stores";
import { agentLimitError, fleetMembers } from "./agents";

/** A fleet as its administrator reaches it, signed in or through the fleet's API key. */
type FleetCall = {
  request: Request;
  env: Env;
  url: URL;
  fleetId: string;
  fleet: FleetRow;
  email: string;
  /** Through the fleet key rather than a signed-in session. */
  viaKey: boolean;
  dir: ReturnType<typeof directory>;
};

/**
 * Everything under `/api/fleets/:id`, for the fleet's administrator. The fleet's API key
 * acts for them on its agents (finding and adding them by address, issuing their keys),
 * never on the fleet's settings or its own key.
 */
export async function handleFleets(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const fleetId = segments[2];
  if (!fleetId) return undefined;
  const dir = directory(env);
  const signedIn = await callerEmail(request, env);
  const viaKey = !signedIn && (await fleetKeyCaller(request, env)) === fleetId;
  const email = signedIn || (viaKey ? await dir.fleetAdmin(fleetId) : "");
  const fleet = email
    ? (await dir.listFleets(email)).find((f) => f.fleet_id === fleetId)
    : undefined;
  if (!fleet) return jsonError("not allowed", 403);
  const call: FleetCall = { request, env, url, fleetId, fleet, email, viaKey, dir };

  if (segments[3] === "agents") {
    if (!segments[4]) {
      if (request.method === "GET") return await findFleetAgents(call);
      if (request.method === "POST") return await addFleetAgents(call);
      return undefined;
    }
    if (segments[5] === "api-keys" && segments[6] && !segments[7] && request.method === "POST") {
      return await issueAgentKey(call, decodeURIComponent(segments[4]), segments[6]);
    }
    return undefined;
  }
  if (viaKey) return jsonError("not allowed", 403);
  if (!segments[3]) {
    if (request.method === "GET") return await getFleet(call);
    if (request.method === "PATCH") return await patchFleet(call);
    return undefined;
  }
  if (segments[3] === "api-keys") {
    if (!segments[4] && request.method === "GET") return await listFleetKeys(call);
    if (segments[4] === "fleet" && !segments[5]) return await handleFleetKey(call);
  }
  return undefined;
}

/** The fleet's stored settings, or the factory document when it has none. */
async function storedMeta({ dir, fleetId }: FleetCall): Promise<MetaSettings> {
  const stored = await dir.fleetMeta(fleetId);
  if (!stored) return DEFAULT_META;
  try {
    return { ...DEFAULT_META, ...(JSON.parse(stored) as Partial<MetaSettings>) };
  } catch {
    return DEFAULT_META;
  }
}

async function getFleet(call: FleetCall): Promise<Response> {
  const settings = await deploymentSettings(call.env);
  return json({
    fleet: call.fleet,
    meta: redactMeta(await storedMeta(call)),
    models: modelCatalog(settings),
    capabilities: capabilitiesFor(DEFAULT_META, settings),
    mcp_catalog: settings.mcp_catalog,
  });
}

/**
 * Save the fleet's settings and apply them to its agents, a batch per call. Stored on the
 * first call only, so a resumed run uses the same document.
 */
async function patchFleet(call: FleetCall): Promise<Response> {
  const { request, env, url, fleetId, dir } = call;
  const body = await readJson<Partial<MetaSettings> & { cursor?: string; limit?: number }>(request);
  const first = !body.cursor;
  let meta: MetaSettings;
  try {
    meta = first
      ? validateMeta(body, await storedMeta(call), {
          creation: true,
          settings: await deploymentSettings(env),
        })
      : await storedMeta(call);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  // A default may only name a key from the fleet admin's own wallet.
  const walletKeyId = meta.defaults.openrouter_key_id ?? "";
  if (first && walletKeyId && !(await dir.walletKey(call.email, walletKeyId))) {
    return jsonError("That key is not in your OpenRouter wallet.", 400);
  }
  if (first) await dir.setFleetMeta(fleetId, JSON.stringify(meta));

  const size = Math.min(Math.max(1, Number(body.limit) || 10), 25);
  const page = await dir.listFleetPage(fleetId, size, body.cursor ?? "");
  for (const row of page.agents) {
    const reg = registry(env, row.id);
    await reg.setMeta(meta);
    const applied = await applyMeta(reg, meta, env, url.origin, row.id);
    // A token the fleet was just given needs its webhook pointed here.
    await syncWebhook(applied.config, url.origin, row.id, env.TELEGRAM_API_BASE);
  }

  return json({
    meta: redactMeta(meta),
    applied: page.agents.length,
    cursor: page.has_more ? page.cursor : "",
    done: !page.has_more,
  });
}

/**
 * Add agents to the fleet, one per address, created from the fleet's settings and
 * named like its other agents unless the call says otherwise.
 */
async function addFleetAgents(call: FleetCall): Promise<Response> {
  const { request, env, url, fleetId, fleet, email, dir } = call;
  const body = await readJson<{ allowed_emails?: string | string[]; name?: string }>(request);
  const members = fleetMembers(body.allowed_emails);
  if (!members.length) return jsonError("at least one email is required", 400);

  const limit = await dir.getAgentLimit(email);
  if ((await dir.countByAdmin(email)) + members.length > limit) return agentLimitError(limit);

  const first = await dir.listFleetPage(fleetId, 1, "");
  const name =
    (body.name ?? "").trim().slice(0, 60) ||
    first.agents[0]?.name ||
    fleet.fleet_name ||
    "New agent";
  const meta = await storedMeta(call);
  const created: AgentRow[] = [];
  for (const member of members) {
    created.push(
      await provisionAgent(env, url.origin, dir, {
        id: AGENT_ID(),
        name,
        allowed: member,
        admin: email,
        fleet: { id: fleetId, name: fleet.fleet_name },
        meta,
      })
    );
  }
  return json({ agents: created, fleet_id: fleetId });
}

/** The fleet's agents that `?email=` is on, oldest first; none is an empty list. */
async function findFleetAgents({ url, fleetId, dir }: FleetCall): Promise<Response> {
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return jsonError("email is required", 400);
  return json({ agents: await dir.fleetAgentsFor(fleetId, email), fleet_id: fleetId });
}

/**
 * Issue one of a fleet agent's own keys (`admin` or `user`), replacing the one it had.
 * The answer carries the key, shown this once.
 */
async function issueAgentKey(
  { env, fleetId, dir }: FleetCall,
  agentId: string,
  role: string
): Promise<Response> {
  if (role !== "admin" && role !== "user") return jsonError("role must be admin or user", 400);
  const row = await dir.get(agentId);
  if (!row || row.fleet_id !== fleetId) return jsonError("no such agent in this fleet", 404);
  const { key, hash, hint } = await newApiKey(agentId, role);
  const saved = await registry(env, agentId).setApiKey(role, hash, hint);
  return json({ ...saved, key });
}

/** The fleet's key, shaped like an agent's key list: never the key, only its hint. */
async function listFleetKeys({ fleetId, dir }: FleetCall): Promise<Response> {
  const stored = await dir.fleetKey(fleetId);
  return json({ keys: stored ? [{ role: "fleet", hint: stored.hint, created_at: stored.created_at }] : [] });
}

/**
 * The fleet's API key. POST replaces it and answers the new key this once; DELETE
 * revokes it. Signed in only.
 */
async function handleFleetKey({ request, fleetId, dir }: FleetCall): Promise<Response> {
  if (request.method === "POST") {
    const { key, hash, hint } = await newFleetKey(fleetId);
    const saved = await dir.setFleetKey(fleetId, hash, hint);
    return json({ role: "fleet", ...saved, key });
  }
  if (request.method === "DELETE") {
    await dir.removeFleetKey(fleetId);
    return json({ ok: true });
  }
  return jsonError("method not allowed", 405);
}
