import type { Env } from "../agent";
import { type AccessRow, type AgentRow, sessionName, splitEmails } from "../registry";
import { deploymentSettings } from "../settings";
import { errorMessage, json, jsonError, notFound, readJson } from "../worker/http";
import { readConfig, registry, sessionPageSize, syncSessionCount } from "../worker/stores";

/** The guest switch and list, as the settings page edits them. */
export function guestsView(access: AccessRow) {
  return { enabled: access.guests === 1, emails: splitEmails(access.guest_emails) };
}

/** What a guest may know about an agent: its name and its public notes. */
export async function publicView(env: Env, agent: AgentRow) {
  const config = await readConfig(env, registry(env, agent.id));
  return { id: agent.id, name: agent.name, public_notes: config.public_notes };
}

/**
 * The whole of an agent a guest can reach: its public view, and their own sessions —
 * listing them and starting one. Everything else is the same 404 a stranger gets.
 */
export async function handleGuest(
  request: Request,
  env: Env,
  url: URL,
  agent: AgentRow,
  section: string | undefined,
  email: string
): Promise<Response> {
  const reg = registry(env, agent.id);
  if (section === "public" && request.method === "GET") {
    return json(await publicView(env, agent));
  }
  if (section === "sessions" && request.method === "GET") {
    const size = sessionPageSize(url, await deploymentSettings(env));
    return json(await reg.list(size, url.searchParams.get("cursor") ?? "", email));
  }
  if (section === "sessions" && request.method === "POST") {
    const { title } = await readJson<{ title?: string }>(request);
    const sessionId = sessionName(agent.id, crypto.randomUUID().slice(0, 8));
    const objectId = env.SessionAgent.idFromName(sessionId).toString();
    let created;
    try {
      created = await reg.create(
        sessionId,
        (title ?? "").trim().slice(0, 60) || "New session",
        objectId,
        undefined,
        (await deploymentSettings(env)).max_sessions,
        email
      );
    } catch (err) {
      return jsonError(errorMessage(err), 409);
    }
    await syncSessionCount(env, agent.id);
    return json(created);
  }
  return notFound();
}
