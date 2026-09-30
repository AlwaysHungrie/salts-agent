import { sessionIdForChat, sessionLimitMessage } from "./naming";
import type { SessionPage, SessionRow } from "./types";

/** A `<updated_at>:<id>` cursor, or undefined when there is none to resume from. */
export function parseCursor(cursor: string): { updated_at: number; id: string } | undefined {
  if (!cursor) return undefined;
  const cut = cursor.indexOf(":");
  if (cut === -1) return undefined;
  const updated_at = Number(cursor.slice(0, cut));
  const id = cursor.slice(cut + 1);
  if (!Number.isFinite(updated_at) || !id) return undefined;
  return { updated_at, id };
}

/**
 * How many delivered message ids to remember. Retries arrive within minutes, so this
 * only has to outlast a burst — it is a dedupe window, not a history.
 */
export const WHATSAPP_EVENTS_KEPT = 500;

export function sessionCount(storage: DurableObjectStorage): number {
  const row = storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions`).toArray()[0] as
    { n: number } | undefined;
  return row?.n ?? 0;
}

export function listSessions(
  storage: DurableObjectStorage,
  limit: number,
  cursor = "",
  owner = ""
): SessionPage {
  const size = Math.max(1, Math.trunc(limit));
  const after = parseCursor(cursor);
  // One row past the page: its existence is the only thing `has_more` needs, and
  // it is cheaper than a second COUNT over the table.
  const rows = storage.sql
    .exec(
      `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
              chat_type, chat_username, chat_thread_id
       FROM sessions
       WHERE (?1 = '' OR owner_email = ?1)
         AND (?2 = 0 OR updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
       ORDER BY updated_at DESC, id ASC LIMIT ?4`,
      owner,
      after?.updated_at ?? 0,
      after?.id ?? "",
      size + 1
    )
    .toArray() as unknown as SessionRow[];

  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    sessions: page,
    has_more: rows.length > size,
    cursor: rows.length > size && last ? `${last.updated_at}:${last.id}` : "",
  };
}

export function countSessions(storage: DurableObjectStorage): number {
  const row = storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions`).toArray()[0] as
    { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function createSession(
  storage: DurableObjectStorage,
  id: string,
  title: string,
  objectId: string,
  origin: Pick<
    SessionRow,
    "source" | "chat_id" | "chat_type" | "chat_username" | "chat_thread_id"
  > = {
    source: "web",
    chat_id: "",
    chat_type: "",
    chat_username: "",
    chat_thread_id: "",
  },
  /** The deployment's `max_sessions`, passed in by the caller. See `storageState`. */
  maxSessions: number,
  /** Who started it on the web. Written once; an update keeps the first owner. */
  owner = ""
): SessionRow {
  // The ceiling, enforced here because here is where every path meets: the web
  // button, a fork, `!new`, and the first message from a Telegram chat nobody has
  // spoken to before. A caller that checked first and then created would still be
  // racing the other three.
  //
  // A row that already exists is an update, not a new session, so it is let
  // through whatever the count is — otherwise renaming the oldest session would
  // start failing the moment the agent filled up.
  if (countSessions(storage) >= maxSessions && !getSession(storage, id)) {
    throw new Error(sessionLimitMessage(maxSessions));
  }
  const now = Date.now();
  storage.sql.exec(
    `INSERT INTO sessions (id, title, owner_email, created_at, updated_at, object_id, source,
                           chat_id, chat_type, chat_username, chat_thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
                                   object_id = excluded.object_id`,
    id,
    title,
    owner.trim().toLowerCase(),
    now,
    now,
    objectId,
    origin.source,
    origin.chat_id,
    origin.chat_type,
    origin.chat_username,
    origin.chat_thread_id
  );
  return getSession(storage, id)!;
}

export function forChat(
  storage: DurableObjectStorage,
  chatId: string,
  threadId = ""
): SessionRow | undefined {
  return storage.sql
    .exec(
      `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
              chat_type, chat_username, chat_thread_id
       FROM sessions WHERE chat_id = ? AND chat_thread_id = ? LIMIT 1`,
      chatId,
      threadId
    )
    .toArray()[0] as unknown as SessionRow | undefined;
}

export function freeChatSessionId(
  storage: DurableObjectStorage,
  agentId: string,
  chatId: string,
  threadId = "",
  channel: "tg" | "wa" = "tg"
): string {
  const base = sessionIdForChat(agentId, chatId, threadId, channel);
  if (!getSession(storage, base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-g${n}`;
    if (!getSession(storage, candidate)) return candidate;
  }
  // A thousand fresh starts in one chat is not a thing; fall back to a unique name.
  return `${base}-g${crypto.randomUUID().slice(0, 8)}`;
}

export function claimWhatsappEvent(storage: DurableObjectStorage, id: string): boolean {
  if (!id) return false;
  const seen = storage.sql
    .exec(`SELECT id FROM whatsapp_events WHERE id = ? LIMIT 1`, id)
    .toArray();
  if (seen.length > 0) return false;
  storage.sql.exec(`INSERT INTO whatsapp_events (id, seen_at) VALUES (?, ?)`, id, Date.now());
  storage.sql.exec(
    `DELETE FROM whatsapp_events WHERE id NOT IN (
       SELECT id FROM whatsapp_events ORDER BY seen_at DESC LIMIT ?
     )`,
    WHATSAPP_EVENTS_KEPT
  );
  return true;
}

export function getSession(storage: DurableObjectStorage, id: string): SessionRow | undefined {
  return storage.sql
    .exec(
      `SELECT id, title, owner_email, created_at, updated_at, object_id, source, chat_id,
              chat_type, chat_username, chat_thread_id
       FROM sessions WHERE id = ? LIMIT 1`,
      id
    )
    .toArray()[0] as unknown as SessionRow | undefined;
}

export function detachChat(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`UPDATE sessions SET chat_id = '', chat_thread_id = '' WHERE id = ?`, id);
}

export function touchSession(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`UPDATE sessions SET updated_at = ? WHERE id = ?`, Date.now(), id);
}

export function renameSession(storage: DurableObjectStorage, id: string, title: string) {
  storage.sql.exec(`UPDATE sessions SET title = ? WHERE id = ?`, title, id);
}

export function removeSession(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
}
