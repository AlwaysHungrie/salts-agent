import type { Env } from "../env";
import { modelCatalog } from "../models";
import { type AgentRow, DEFAULT_META, type FleetRow, type MetaSettings } from "../registry";
import { deploymentSettings } from "../settings";
import { redactMeta, validateMeta } from "../validation/meta";
import { callerEmail } from "../worker/auth";
import { capabilitiesFor } from "../worker/capability-views";
import { errorMessage, json, jsonError, readJson } from "../worker/http";
import { syncWebhook } from "../worker/integrations";
import { applyMeta, provisionAgent } from "../worker/provisioning";
import { AGENT_ID, directory, registry } from "../worker/stores";
import { agentLimitError, fleetMembers } from "./agents";

/** A fleet as its administrator reaches it. */
type FleetCall = {
  request: Request;
  env: Env;
  url: URL;
  fleetId: string;
  fleet: FleetRow;
  email: string;
  dir: ReturnType<typeof directory>;
};

/** Everything under `/api/fleets/:id`, for the fleet's administrator only. */
export async function handleFleets(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const fleetId = segments[2];
  if (!fleetId) return undefined;
  const dir = directory(env);
  const email = await callerEmail(request, env);
  const fleet = email
    ? (await dir.listFleets(email)).find((f) => f.fleet_id === fleetId)
    : undefined;
  if (!fleet) return jsonError("not allowed", 403);
  const call: FleetCall = { request, env, url, fleetId, fleet, email, dir };

  if (!segments[3]) {
    if (request.method === "GET") return await getFleet(call);
    if (request.method === "PATCH") return await patchFleet(call);
    return undefined;
  }
  if (segments[3] === "agents" && request.method === "POST") return await addFleetAgents(call);
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
