import type { Env } from "../env";
import { type AccessRow, type AgentRow, sessionName, splitEmails } from "../registry";
import { deploymentSettings } from "../settings";
import { ApiError, errorMessage } from "../worker/http";
import { readConfig, registry, sessionPageSize, syncSessionCount } from "../worker/stores";
import type { AgentCall } from "./agent";

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
 * A guest's own sessions, a page at a time. With starting one, this and the public view
 * are the whole of an agent a guest can reach.
 */
export async function guestSessions({ env, url, reg, email }: AgentCall) {
  const size = sessionPageSize(url, await deploymentSettings(env));
  return await reg.list(size, url.searchParams.get("cursor") ?? "", email);
}

/** Start a session owned by the guest. */
export async function startGuestSession(
  { env, agent, reg, email }: AgentCall,
  title: string | undefined
) {
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
    throw new ApiError(409, errorMessage(err));
  }
  await syncSessionCount(env, agent.id);
  return created;
}
