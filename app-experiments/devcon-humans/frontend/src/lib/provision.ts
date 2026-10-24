import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import {
  addFleetAgent,
  addMcpServer,
  AgentError,
  findFleetAgent,
  issueAgentKey,
  mcpServers,
  setMcpHeaders,
} from "./agent";
import { users } from "./db";
import { Refusal } from "./http";

/** How long one user's agent may take to set up before another request may try again. */
const PROVISION_MS = 60 * 1000;

const SERVER = "find-humans";
const SECRET_HEADER = "X-Find-Humans-Secret";

/**
 * A find-humans secret for `id`: `fh1.<id>.<signature>`, signed with the key find-humans
 * checks (its SECRET_SIGNING_KEY). Only this app holds that key, so the one secret an
 * agent holds reaches its own user's profile and nothing else.
 */
export function mintSecret(id: string): string {
  const key = process.env.FIND_HUMANS_SIGNING_KEY;
  if (!key) throw new AgentError("FIND_HUMANS_SIGNING_KEY must be set.", 500);
  const signature = createHmac("sha256", key).update(`fh1:secret:${id}`).digest("base64url");
  return `fh1.${id}.${signature}`;
}

/**
 * The id behind a secret the agent already holds, so its profile carries over: the id of
 * a minted secret, or a plain secret from before signing, which find-humans keyed the
 * same way. Null when there is none to keep.
 */
function keptId(secret: string | undefined): string | null {
  if (!secret) return null;
  const [prefix, id, signature] = secret.split(".");
  if (prefix === "fh1" && id && signature) return id;
  return /^[A-Za-z0-9_-]{16,}$/.test(secret) ? secret : null;
}

/**
 * Give the agent find-humans with its user's own minted secret as the only header. Any
 * other header (a shared token or model key left from before) is dropped: a member can
 * read or redirect whatever the agent holds, so it must hold nothing beyond their own pass.
 */
export async function ensureFindHumans(adminKey: string): Promise<void> {
  const url = process.env.FIND_HUMANS_MCP_URL;
  if (!url) throw new AgentError("FIND_HUMANS_MCP_URL must be set.", 500);
  const server = (await mcpServers(adminKey)).find((s) => s.name.toLowerCase() === SERVER);
  const held = Object.entries(server?.headers ?? {}).find(([k]) => k.toLowerCase() === SECRET_HEADER.toLowerCase())?.[1];
  const headers = { [SECRET_HEADER]: mintSecret(keptId(held) ?? randomBytes(32).toString("base64url")) };
  if (!server) return addMcpServer(adminKey, { name: SERVER, url, headers });
  const kept = Object.keys(server.headers).length === 1 && held === headers[SECRET_HEADER];
  if (!kept) await setMcpHeaders(adminKey, server.id, headers);
}

/**
 * The user's agent key. The first time, their agent is found in the fleet by email, or
 * added to it, then given find-humans and a user key, which is kept. One set-up at a time
 * per user; a second request while one runs is refused rather than adding a second agent.
 */
export async function userKeyFor(userId: string, email: string): Promise<string> {
  const col = await users();
  const now = new Date();
  const claimed = await col.findOneAndUpdate(
    {
      userId,
      userKey: { $exists: false },
      $or: [{ provisioningUntil: { $exists: false } }, { provisioningUntil: { $lte: now } }],
    },
    { $set: { provisioningUntil: new Date(now.getTime() + PROVISION_MS) } },
  );
  if (!claimed) {
    const doc = await col.findOne({ userId });
    if (doc?.userKey) return doc.userKey;
    throw new Refusal("Your agent is still being set up. Try again in a minute.", 409);
  }
  try {
    const agentId = (await findFleetAgent(email)) ?? (await addFleetAgent(email));
    await ensureFindHumans(await issueAgentKey(agentId, "admin"));
    const userKey = await issueAgentKey(agentId, "user");
    await col.updateOne({ userId }, { $set: { agentId, userKey }, $unset: { provisioningUntil: "" } });
    return userKey;
  } catch (err) {
    await col.updateOne({ userId }, { $unset: { provisioningUntil: "" } }).catch(() => {});
    throw err;
  }
}
