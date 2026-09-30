/**
 * Session ids carry the agent that owns them, as `<agentId>~<local>`.
 *
 * `SessionAgent` is one Durable Object namespace for the whole Worker, so a session
 * id has to be unique across every agent — and the ids that are not random are the
 * ones that would collide: two agents in the same Telegram chat both want `tg-123`,
 * which would be the same object. The prefix is also how a session finds its agent:
 * a `SessionAgent` knows nothing but its own name, and reads the owner back out of it.
 */
export const AGENT_SEPARATOR = "~";

/** The full session id for a session local to `agentId`. */
export function sessionName(agentId: string, local: string): string {
  return `${agentId}${AGENT_SEPARATOR}${local}`;
}

/** The agent a session id belongs to. Empty when the id is not one of ours. */
export function agentIdOf(sessionId: string): string {
  const cut = sessionId.indexOf(AGENT_SEPARATOR);
  return cut === -1 ? "" : sessionId.slice(0, cut);
}

/**
 * The session a chat conversation maps to. A DM is one chat, a group is another, and
 * a forum topic is its own conversation inside a group — so this is what gives each
 * of them its own session, and keeps giving it the same one. Two agents are two
 * different bots, so the same chat under each of them is two separate sessions.
 *
 * `channel` prefixes the id so a WhatsApp number and a Telegram chat that happen to
 * be the same digits cannot land on the same Durable Object. It defaults to `tg`
 * because every session created before WhatsApp existed is named that way, and those
 * ids are stored: changing the default would orphan every live chat.
 */
export function sessionIdForChat(
  agentId: string,
  chatId: string,
  threadId = "",
  channel: "tg" | "wa" = "tg"
): string {
  const base = `${channel}-${safeChatId(chatId)}`;
  return sessionName(agentId, threadId ? `${base}-t${threadId}` : base);
}

/**
 * A chat id reduced to characters a session id may hold.
 *
 * A session id is addressed as a URL path segment — `/agents/session-agent/<id>` —
 * and the Durable Object is named by that segment as it arrives. Anything
 * `encodeURIComponent` rewrites therefore reaches the object in its encoded form,
 * while the registry still holds the raw one, and every lookup the object makes about
 * itself quietly misses. A WhatsApp chat id is `wa:<number>`, and that colon is
 * exactly such a character: it cost a day of silent scheduled messages.
 *
 * Telegram ids are digits and a leading `-`, which keeps its own spelling as `n` so
 * the ids already stored stay the ids this returns.
 */
export function safeChatId(chatId: string): string {
  return chatId.replace("-", "n").replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * How many sessions the delete walk reads per page. Internal batching, not a page
 * any caller is served — those are `session_page` / `max_session_page`.
 */
export const MAX_PAGE = 200;

/**
 * What a refused upload says, wherever it was refused.
 *
 * The ceiling is passed in rather than read from a constant, because the sentence
 * quotes it: a message naming 50 MB on a deployment that has raised the limit to 500
 * is worse than no message, since the reader has no way to know which number is real.
 */
export function storageFullMessage(used: number, size: number, limit: number): string {
  const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
  return (
    `This agent is using ${mb(used)} of its ${mb(limit)} file storage, ` +
    `and this file is ${mb(size)}. Delete some files or a session to make room.`
  );
}

/** What every refusal says, so the wording does not drift between four callers. */
export function sessionLimitMessage(maxSessions: number): string {
  return (
    `This agent has reached its limit of ${maxSessions} sessions. ` + `Delete one to start another.`
  );
}
