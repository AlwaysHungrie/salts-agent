import "server-only";
import { MongoServerError } from "mongodb";
import { createSession, deleteSession, transcript, type StoredMessage } from "./agent";
import { chats } from "./db";
import { MAX_MESSAGES } from "./rules";

export type ChatState = { sent: number; limit: number; messages: StoredMessage[] };

/** The user's chat as the page shows it: what was said and how many messages are left. */
export async function chatState(userId: string): Promise<ChatState> {
  const doc = await (await chats()).findOne({ userId });
  const messages = doc ? await transcript(doc.sessionId) : [];
  return { sent: doc?.sent ?? 0, limit: MAX_MESSAGES, messages };
}

/** The user's chat session, started on their first message. */
async function sessionFor(userId: string): Promise<string> {
  const col = await chats();
  const found = await col.findOne({ userId });
  if (found) return found.sessionId;
  const sessionId = await createSession(`Chat · ${userId}`);
  try {
    await col.insertOne({ userId, sessionId, sent: 0, createdAt: new Date() });
    return sessionId;
  } catch (err) {
    // Two first messages raced; keep the one that landed and drop ours.
    if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
    await deleteSession(sessionId).catch(() => {});
    const winner = await col.findOne({ userId });
    if (!winner) throw err;
    return winner.sessionId;
  }
}

/**
 * Count one message against the user's limit and return the session to send it to, or
 * null when the limit is reached. The check and the count are one update, so two tabs
 * cannot both send the 25th.
 */
export async function reserveMessage(userId: string): Promise<string | null> {
  const sessionId = await sessionFor(userId);
  const doc = await (await chats()).findOneAndUpdate(
    { userId, sessionId, sent: { $lt: MAX_MESSAGES } },
    { $inc: { sent: 1 } },
  );
  return doc ? sessionId : null;
}

/** Give a message back when it never reached the agent. */
export async function refundMessage(userId: string, sessionId: string): Promise<void> {
  await (await chats()).updateOne({ userId, sessionId, sent: { $gt: 0 } }, { $inc: { sent: -1 } });
}

/** Clear the chat: delete the agent session; the next message starts a new one. */
export async function clearChat(userId: string): Promise<void> {
  const doc = await (await chats()).findOneAndDelete({ userId });
  if (doc) await deleteSession(doc.sessionId).catch(() => {});
}
