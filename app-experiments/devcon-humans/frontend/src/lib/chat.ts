import "server-only";
import { AgentError, createSession, deleteSession, stream } from "./agent";
import { users } from "./db";
import { Refusal } from "./http";
import { userKeyFor } from "./provision";

/**
 * A new session on the user's agent. A kept key the Worker no longer accepts (the agent was
 * deleted, or its key replaced) is dropped and the user's agent is found or added in the
 * fleet again.
 */
async function openSession(userId: string, title: string): Promise<{ key: string; sessionId: string }> {
  const col = await users();
  const doc = await col.findOne({ userId });
  if (!doc?.email) throw new Refusal("Pick up your badge again.", 401);
  let key = doc.userKey ?? (await userKeyFor(userId, doc.email));
  try {
    return { key, sessionId: await createSession(key, title) };
  } catch (err) {
    if (!(doc.userKey && err instanceof AgentError && (err.status === 401 || err.status === 404))) throw err;
    await col.updateOne({ userId }, { $unset: { agentId: "", userKey: "", sessionId: "", findHumansId: "" } });
    key = await userKeyFor(userId, doc.email);
    return { key, sessionId: await createSession(key, title) };
  }
}

/**
 * Start the search over: a new session on the user's agent replaces the one they had, which
 * is deleted. Called each time the page opens, so nothing is carried between visits.
 */
export async function newChat(userId: string): Promise<void> {
  const { key, sessionId } = await openSession(userId, "Humans search");
  const before = await (await users()).findOneAndUpdate({ userId }, { $set: { sessionId } });
  if (before?.sessionId && before.sessionId !== sessionId) await deleteSession(key, before.sessionId).catch(() => {});
}

/**
 * One message with no conversation around it: a session of its own, deleted once the reply
 * has streamed (or failed), so every message starts fresh.
 */
export async function oneShot(userId: string, message: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const { key, sessionId } = await openSession(userId, "Humans profile");
  const done = () => void deleteSession(key, sessionId).catch(() => {});
  let reply: ReadableStream<Uint8Array>;
  try {
    reply = await stream(key, sessionId, message, signal);
  } catch (err) {
    done();
    throw err;
  }
  return reply.pipeThrough(new TransformStream({ flush: done, cancel: done } as Transformer<Uint8Array, Uint8Array>));
}

/** The user's agent key and current session, or a refusal when the chat has not started. */
export async function currentChat(userId: string): Promise<{ key: string; sessionId: string }> {
  const doc = await (await users()).findOne({ userId });
  if (!doc?.userKey || !doc.sessionId) throw new Refusal("Your chat isn’t ready. Refresh the page.", 409);
  return { key: doc.userKey, sessionId: doc.sessionId };
}

/** Make sure the user has an agent: found or added in the fleet the first time, its key kept. */
export async function ensureAgent(userId: string): Promise<void> {
  const doc = await (await users()).findOne({ userId });
  if (!doc?.email) throw new Refusal("Pick up your badge again.", 401);
  if (!doc.userKey) await userKeyFor(userId, doc.email);
}
