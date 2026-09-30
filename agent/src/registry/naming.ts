/**
 * Session ids are `<agentId>~<local>`: unique across agents in the one `SessionAgent`
 * namespace (two agents in one Telegram chat), and how a session finds its agent.
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
 * The session a chat (DM, group or forum topic) maps to, per agent. `channel` keeps a
 * WhatsApp number and a Telegram id apart; it defaults to `tg`, which existing ids use.
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
 * A chat id reduced to URL-safe characters: anything `encodeURIComponent` rewrites would
 * reach the object encoded and miss its own registry row. `-` stays `n` for stored ids.
 */
export function safeChatId(chatId: string): string {
  return chatId.replace("-", "n").replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * How many sessions the delete walk reads per page. Internal batching, not a page
 * any caller is served — those are `session_page` / `max_session_page`.
 */
export const MAX_PAGE = 200;

/** The storage-full message. The ceiling is passed in because the sentence quotes it. */
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
