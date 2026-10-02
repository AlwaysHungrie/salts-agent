import { API_KEY_ROLES, type ApiKeyRole } from "../registry";
import { newApiKey } from "../worker/auth";
import { json, notFound } from "../worker/http";
import type { AgentCall } from "./agent";

/** Whether the caller manages this role's key: the admin's is theirs, the user key everyone's. */
function manages(call: AgentCall, role: ApiKeyRole): boolean {
  return role === "admin" ? call.isAdmin : call.isUser || call.isAdmin;
}

/**
 * `/api/agents/:agentId/api-keys[/:role]`. GET lists the keys the caller manages (never
 * the keys themselves); POST generates the role's key, replacing any it had, and returns
 * it this once; DELETE revokes it.
 */
export async function handleApiKeys(
  call: AgentCall,
  roleSegment: string | undefined
): Promise<Response | undefined> {
  const { request, agentId, reg } = call;
  if (!roleSegment) {
    if (request.method !== "GET") return undefined;
    const keys = (await reg.apiKeys()).filter((k) => manages(call, k.role));
    return json({ keys });
  }

  const role = API_KEY_ROLES.find((r) => r === roleSegment);
  if (!role || !manages(call, role)) return notFound();

  if (request.method === "POST") {
    const { key, hash, hint } = await newApiKey(agentId, role);
    const saved = await reg.setApiKey(role, hash, hint);
    return json({ ...saved, key });
  }
  if (request.method === "DELETE") {
    await reg.removeApiKey(role);
    return json({ ok: true });
  }
  return undefined;
}
