import { countByAdmin, getAgentLimit, setAgentLimit } from "./directory-accounts";
import type { BusinessRequest, BusinessRequestPage } from "./types";

export function fileBusinessRequest(
  storage: DurableObjectStorage,
  email: string,
  increase: number
): BusinessRequest {
  const row: BusinessRequest = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    email: email.trim().toLowerCase(),
    requested_increase: increase,
    created_at: Date.now(),
  };
  storage.sql.exec(
    `INSERT INTO business_requests (id, email, requested_increase, created_at) VALUES (?, ?, ?, ?)`,
    row.id,
    row.email,
    row.requested_increase,
    row.created_at
  );
  return row;
}

export function listBusinessRequests(
  storage: DurableObjectStorage,
  limit = 20,
  cursor = ""
): BusinessRequestPage {
  const size = Math.max(1, Math.min(limit, 100));
  const [afterTime, afterId] = cursor.split(":");
  const after =
    cursor && Number.isFinite(Number(afterTime))
      ? { created_at: Number(afterTime), id: afterId ?? "" }
      : undefined;
  // One row past the page: its existence is all `has_more` needs.
  const rows = (after
    ? storage.sql.exec(
        `SELECT id, email, requested_increase, created_at FROM business_requests
           WHERE created_at > ? OR (created_at = ? AND id > ?)
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        after.created_at,
        after.created_at,
        after.id,
        size + 1
      )
    : storage.sql.exec(
        `SELECT id, email, requested_increase, created_at FROM business_requests
           ORDER BY created_at ASC, id ASC LIMIT ?`,
        size + 1
      )
  ).toArray() as unknown as BusinessRequest[];
  const page = rows.slice(0, size).map((r) => ({
    ...r,
    current_limit: getAgentLimit(storage, r.email),
    current_agents: countByAdmin(storage, r.email),
  }));
  const last = page[page.length - 1];
  return {
    requests: page,
    has_more: rows.length > size,
    cursor: rows.length > size && last ? `${last.created_at}:${last.id}` : "",
  };
}

export function deleteBusinessRequest(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`DELETE FROM business_requests WHERE id = ?`, id);
}

export function approveBusinessRequest(
  storage: DurableObjectStorage,
  id: string
): { email: string; agent_limit: number } | undefined {
  const row = storage.sql
    .exec(`SELECT email, requested_increase FROM business_requests WHERE id = ? LIMIT 1`, id)
    .toArray()[0] as { email: string; requested_increase: number } | undefined;
  if (!row) return undefined;
  const agent_limit = getAgentLimit(storage, row.email) + row.requested_increase;
  storage.transactionSync(() => {
    setAgentLimit(storage, row.email, agent_limit);
    storage.sql.exec(`DELETE FROM business_requests WHERE id = ?`, id);
  });
  return { email: row.email, agent_limit };
}
