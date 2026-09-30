import type { Memory } from "./types";

export function remember(storage: DurableObjectStorage, text: string, sessionId: string): Memory {
  const row = { text, session_id: sessionId, created_at: Date.now() };
  const id = storage.sql
    .exec(
      `INSERT INTO memories (text, session_id, created_at) VALUES (?, ?, ?) RETURNING id`,
      row.text,
      row.session_id,
      row.created_at
    )
    .toArray()[0] as { id: number };
  return { id: id.id, ...row };
}

export function recall(storage: DurableObjectStorage, query: string, limit = 20): Memory[] {
  const sql = query
    ? `SELECT id, text, session_id, created_at FROM memories
       WHERE text LIKE ? COLLATE NOCASE ORDER BY id DESC LIMIT ?`
    : `SELECT id, text, session_id, created_at FROM memories ORDER BY id DESC LIMIT ?`;
  const args = query ? [`%${query}%`, limit] : [limit];
  return storage.sql.exec(sql, ...args).toArray() as unknown as Memory[];
}

export function forget(storage: DurableObjectStorage, id: number) {
  storage.sql.exec(`DELETE FROM memories WHERE id = ?`, id);
}
