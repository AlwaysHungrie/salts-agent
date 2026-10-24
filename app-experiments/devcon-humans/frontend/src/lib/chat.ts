import "server-only";
import { AgentError, createSession, deleteSession } from "./agent";
import { users } from "./db";
import { Refusal } from "./http";
import { userKeyFor } from "./provision";

/**
 * Start the chat over: a new session on the user's agent replaces the one they had, which
 * is deleted. Called each time the page opens, so nothing is carried between visits. A
 * kept key the Worker no longer accepts (the agent was deleted, or its key replaced) is
 * dropped and the user's agent is found or added in the fleet again.
 */
export async function newChat(userId: string): Promise<void> {
  const col = await users();
  const doc = await col.findOne({ userId });
  if (!doc?.email) throw new Refusal("Pick up your badge again.", 401);
  let key = doc.userKey ?? (await userKeyFor(userId, doc.email));
  let sessionId: string;
  try {
    sessionId = await createSession(key, "Devcon Humans");
  } catch (err) {
    if (!(doc.userKey && err instanceof AgentError && (err.status === 401 || err.status === 404))) throw err;
    await col.updateOne({ userId }, { $unset: { agentId: "", userKey: "", sessionId: "" } });
    key = await userKeyFor(userId, doc.email);
    sessionId = await createSession(key, "Devcon Humans");
  }
  const before = await col.findOneAndUpdate({ userId }, { $set: { sessionId } });
  if (before?.sessionId && before.sessionId !== sessionId) await deleteSession(key, before.sessionId).catch(() => {});
}

/** The user's agent key and current session, or a refusal when the chat has not started. */
export async function currentChat(userId: string): Promise<{ key: string; sessionId: string }> {
  const doc = await (await users()).findOne({ userId });
  if (!doc?.userKey || !doc.sessionId) throw new Refusal("Your chat isn’t ready. Refresh the page.", 409);
  return { key: doc.userKey, sessionId: doc.sessionId };
}
