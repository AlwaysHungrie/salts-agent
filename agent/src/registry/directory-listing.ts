import { directorySettings } from "./directory-settings";
import type { AgentPage, AgentRow, FleetRow, MetadataFilter } from "./types";

/**
 * Where a page stopped: the sort key of its last row, `<created_at>:<id>`.
 *
 * A keyset rather than an offset. The lists this pages are appended to while they
 * are being read — an offset would skip or repeat a row every time an agent is
 * created mid-scroll, and a fleet of thousands is read over minutes, not seconds.
 */
export function encodeCursor(row: AgentRow): string {
  return `${row.created_at}:${row.id}`;
}

export function decodeCursor(cursor: string): { created_at: number; id: string } | null {
  const cut = cursor.indexOf(":");
  if (cut === -1) return null;
  const created = Number(cursor.slice(0, cut));
  const id = cursor.slice(cut + 1);
  if (!Number.isFinite(created) || !id) return null;
  return { created_at: created, id };
}

/** The row as `AgentRow` has always looked: the metadata column is for filtering. */
export function withoutMetadata(row: AgentRow & { metadata?: string }): AgentRow {
  const { metadata: _metadata, ...rest } = row;
  return rest;
}

/** Metadata keys are plain identifiers: they end up inside a JSON path. */
export const METADATA_KEY = /^[a-z0-9_-]{1,40}$/;

/** The SQL condition for `filter` on table alias `a`, and its bound values. */
export function metadataClause(filter: MetadataFilter | undefined): {
  sql: string;
  args: string[];
} {
  const parts: string[] = [];
  const args: string[] = [];
  if (filter?.with && METADATA_KEY.test(filter.with[0])) {
    parts.push(`json_extract(a.metadata, '$."' || ? || '"') = ?`);
    args.push(filter.with[0], filter.with[1]);
  }
  if (filter?.without && METADATA_KEY.test(filter.without)) {
    parts.push(`json_extract(a.metadata, '$."' || ? || '"') IS NULL`);
    args.push(filter.without);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", args };
}

export function listAgents(storage: DurableObjectStorage, email?: string): AgentRow[] {
  if (email === undefined) {
    return storage.sql
      .exec(
        `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
                fleet_id, fleet_name FROM agents
         ORDER BY created_at`
      )
      .toArray() as unknown as AgentRow[];
  }
  const wanted = email.trim().toLowerCase();
  if (!wanted) return [];
  // A `UNION` of the two ways on, rather than one `WHERE x OR EXISTS (…)`.
  //
  // They return the same rows, but SQLite cannot use an index for an `OR` across
  // two tables — it falls back to scanning every agent and running the subquery per
  // row, which is the walk this table exists to remove. Split in two, each half is
  // an index lookup: `idx_agents_admin_email` for the left, `idx_agent_members_email`
  // for the right. `UNION` is the deduplicating one, which is what keeps an admin
  // who is also on the access list from appearing twice.
  return storage.sql
    .exec(
      `SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails, a.admin_email,
              a.fleet_id, a.fleet_name
         FROM agents a
        WHERE a.admin_email = ?1
        UNION
       SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails, a.admin_email,
              a.fleet_id, a.fleet_name
         FROM agents a
         JOIN agent_members m ON m.agent_id = a.id
        WHERE m.email = ?1
        ORDER BY created_at`,
      wanted
    )
    .toArray() as unknown as AgentRow[];
}

export function listPage(
  storage: DurableObjectStorage,
  email: string,
  limit = 0,
  cursor = "",
  filter?: MetadataFilter
): AgentPage {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return { agents: [], has_more: false, cursor: "" };
  const size = agentPageSize(storage, limit);
  const after = decodeCursor(cursor);
  const meta = metadataClause(filter);
  // One row more than asked for: whether there is another page is then a fact
  // about this query rather than a second count over the whole list.
  const rows = storage.sql
    .exec(
      `SELECT * FROM (
         SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails,
                a.admin_email, a.fleet_id, a.fleet_name, a.metadata
           FROM agents a
          WHERE a.admin_email = ? AND a.fleet_id = ''
          UNION
         SELECT a.id, a.name, a.created_at, a.updated_at, a.allowed_emails,
                a.admin_email, a.fleet_id, a.fleet_name, a.metadata
           FROM agents a
           JOIN agent_members m ON m.agent_id = a.id
          WHERE m.email = ?
       ) a
       WHERE ${meta.sql}
         AND ((? = 0 AND ? = '') OR a.created_at > ? OR (a.created_at = ? AND a.id > ?))
       ORDER BY a.created_at, a.id
       LIMIT ?`,
      wanted,
      wanted,
      ...meta.args,
      after?.created_at ?? 0,
      after?.id ?? "",
      after?.created_at ?? 0,
      after?.created_at ?? 0,
      after?.id ?? "",
      size + 1
    )
    .toArray() as unknown as (AgentRow & { metadata: string })[];
  return pageOf(storage, rows.map(withoutMetadata), size);
}

export function listGuestPage(
  storage: DurableObjectStorage,
  email: string,
  limit = 0,
  cursor = "",
  filter?: MetadataFilter
): AgentPage {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return { agents: [], has_more: false, cursor: "" };
  const size = agentPageSize(storage, limit);
  const after = decodeCursor(cursor);
  const meta = metadataClause(filter);
  const rows = storage.sql
    .exec(
      `SELECT a.id, a.name, a.created_at, a.updated_at, a.admin_email
         FROM agents a
        WHERE a.guests = 1
          AND (NOT EXISTS (SELECT 1 FROM agent_guests g WHERE g.agent_id = a.id)
               OR EXISTS (SELECT 1 FROM agent_guests g WHERE g.agent_id = a.id AND g.email = ?))
          AND ${meta.sql}
          AND ((? = 0 AND ? = '') OR a.created_at > ? OR (a.created_at = ? AND a.id > ?))
        ORDER BY a.created_at, a.id
        LIMIT ?`,
      wanted,
      ...meta.args,
      after?.created_at ?? 0,
      after?.id ?? "",
      after?.created_at ?? 0,
      after?.created_at ?? 0,
      after?.id ?? "",
      size + 1
    )
    .toArray() as unknown as {
    id: string;
    name: string;
    created_at: number;
    updated_at: number;
    admin_email: string;
  }[];
  // A guest learns the agent's name and nothing about who else is on it.
  return pageOf(
    storage,
    rows.map((r) => ({
      ...r,
      allowed_emails: "",
      admin_email: "",
      fleet_id: "",
      fleet_name: "",
    })),
    size
  );
}

export function listFleets(storage: DurableObjectStorage, email: string): FleetRow[] {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return [];
  return storage.sql
    .exec(
      `SELECT fleet_id, MIN(fleet_name) AS fleet_name, COUNT(*) AS agents,
              MIN(created_at) AS created_at
         FROM agents
        WHERE admin_email = ? AND fleet_id <> ''
        GROUP BY fleet_id
        ORDER BY created_at`,
      wanted
    )
    .toArray() as unknown as FleetRow[];
}

export function listFleetPage(
  storage: DurableObjectStorage,
  fleetId: string,
  limit = 0,
  cursor = ""
): AgentPage {
  if (!fleetId) return { agents: [], has_more: false, cursor: "" };
  const size = agentPageSize(storage, limit);
  const after = decodeCursor(cursor);
  const rows = storage.sql
    .exec(
      `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
              fleet_id, fleet_name
         FROM agents
        WHERE fleet_id = ?1
          AND ((?2 = 0 AND ?3 = '')
               OR created_at > ?2
               OR (created_at = ?2 AND id > ?3))
        ORDER BY created_at, id
        LIMIT ?4`,
      fleetId,
      after?.created_at ?? 0,
      after?.id ?? "",
      size + 1
    )
    .toArray() as unknown as AgentRow[];
  return pageOf(storage, rows, size);
}

export function pageOf(storage: DurableObjectStorage, rows: AgentRow[], size: number): AgentPage {
  const has_more = rows.length > size;
  const agents = has_more ? rows.slice(0, size) : rows;
  return {
    agents,
    has_more,
    cursor: has_more && agents.length ? encodeCursor(agents[agents.length - 1]) : "",
  };
}

export function agentPageSize(storage: DurableObjectStorage, limit: number): number {
  const settings = directorySettings(storage);
  const asked = Number.isFinite(limit) && limit > 0 ? limit : settings.agent_page;
  return Math.min(Math.max(1, Math.trunc(asked)), settings.max_agent_page);
}

export function fleetMeta(storage: DurableObjectStorage, fleetId: string): string {
  const row = storage.sql
    .exec(`SELECT json FROM fleet_meta WHERE fleet_id = ? LIMIT 1`, fleetId)
    .toArray()[0] as { json: string } | undefined;
  return row?.json ?? "";
}

export function setFleetMeta(storage: DurableObjectStorage, fleetId: string, json: string): void {
  if (!fleetId) return;
  storage.sql.exec(
    `INSERT INTO fleet_meta (fleet_id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(fleet_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    fleetId,
    json,
    Date.now()
  );
}

export function removeFleetMeta(storage: DurableObjectStorage, fleetId: string): void {
  storage.sql.exec(`DELETE FROM fleet_meta WHERE fleet_id = ?`, fleetId);
}
