import { routeAgentRequest } from "agents";
import type { Env } from "../env";
import type { SessionRegistry } from "../registry";
import { deploymentSettings, type DeploymentSettings } from "../settings";

/** One agent's own store. Agents share nothing: separate objects, credentials and queues. */
export function registry(env: Env, agentId: string) {
  return env.SessionRegistry.get(env.SessionRegistry.idFromName(agentId));
}

/** The index of which agents exist. A DO namespace cannot be enumerated. */
export function directory(env: Env) {
  return env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));
}

/**
 * An agent's config, seeded from the deployment's defaults on first read. Always go
 * through here so a new agent is never seeded with nothing.
 */
export async function readConfig(env: Env, reg: ReturnType<typeof registry>) {
  const settings = await deploymentSettings(env);
  return await reg.config(settings.default_model, settings.config_defaults);
}

/** As `readConfig`, writing a patch over it. */
export async function writeConfig(
  env: Env,
  reg: ReturnType<typeof registry>,
  patch: Parameters<ReturnType<typeof registry>["setConfig"]>[0]
) {
  const settings = await deploymentSettings(env);
  return await reg.setConfig(patch, settings.default_model, settings.config_defaults);
}

/** Copy an agent's session count into the directory for admin stats. Off the hot path. */
export async function syncSessionCount(env: Env, agentId: string) {
  const count = await registry(env, agentId).sessionCount();
  await directory(env).setSessionCount(agentId, count);
}

export type Registry = DurableObjectStub<SessionRegistry>;

/** Agent ids appear in session names, so they may not contain the separator. */
export const AGENT_ID = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

/** A page size from `?limit=`, within the deployment's session page bounds. */
export function sessionPageSize(url: URL, settings: DeploymentSettings): number {
  const asked = Number(url.searchParams.get("limit") ?? settings.session_page);
  return Math.min(
    Math.max(1, Number.isFinite(asked) ? asked : settings.session_page),
    settings.max_session_page
  );
}

/** Call one of a session object's own routes, e.g. `export`, `import`, `telegram`. */
export function callSession(
  env: Env,
  origin: string,
  sessionId: string,
  path: string,
  init?: RequestInit
) {
  return routeAgentRequest(
    new Request(`${origin}/agents/session-agent/${encodeURIComponent(sessionId)}/${path}`, init),
    env
  );
}

/** Destroy a session object, not just its rows: a Durable Object is billed for what it stores. */
export async function destroySession(env: Env, origin: string, sessionId: string) {
  await callSession(env, origin, sessionId, "destroy", { method: "POST" }).catch(() => {
    // `destroy()` aborts the isolate, which can surface as a broken response.
  });
}
