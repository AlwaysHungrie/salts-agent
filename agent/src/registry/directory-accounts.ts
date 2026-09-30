import { directorySettings } from "./directory-settings";
import type { UserDetail, UserPage } from "./types";

export function getAgentLimit(storage: DurableObjectStorage, email: string): number {
  const wanted = email.trim().toLowerCase();
  const row = storage.sql
    .exec(`SELECT agent_limit FROM account_limits WHERE email = ? LIMIT 1`, wanted)
    .toArray()[0] as { agent_limit: number } | undefined;
  return row?.agent_limit ?? directorySettings(storage).default_agent_limit;
}

export function setAgentLimit(storage: DurableObjectStorage, email: string, limit: number) {
  const wanted = email.trim().toLowerCase();
  storage.sql.exec(
    `INSERT INTO account_limits (email, agent_limit) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET agent_limit = excluded.agent_limit`,
    wanted,
    limit
  );
}

export function countByAdmin(storage: DurableObjectStorage, email: string): number {
  const wanted = email.trim().toLowerCase();
  const row = storage.sql
    .exec(`SELECT COUNT(*) AS n FROM agents WHERE admin_email = ?`, wanted)
    .toArray()[0] as { n: number } | undefined;
  return row?.n ?? 0;
}

export function counts(storage: DurableObjectStorage): {
  users: number;
  agents: number;
  sessions: number;
  business_accounts: number;
  open_requests: number;
} {
  const row = storage.sql
    .exec(
      `SELECT
         (SELECT COUNT(*) FROM agents) AS agents,
         (SELECT COUNT(*) FROM account_limits) AS business_accounts,
         (SELECT COUNT(*) FROM business_requests) AS open_requests,
         (SELECT COALESCE(SUM(MAX(session_count, 0)), 0) FROM agents) AS sessions,
         (SELECT COUNT(*) FROM (
            SELECT admin_email AS email FROM agents WHERE admin_email != ''
            UNION
            SELECT email FROM agent_members
          )) AS users`
    )
    .toArray()[0] as
    | {
        users: number;
        agents: number;
        sessions: number;
        business_accounts: number;
        open_requests: number;
      }
    | undefined;
  return {
    users: row?.users ?? 0,
    agents: row?.agents ?? 0,
    sessions: row?.sessions ?? 0,
    business_accounts: row?.business_accounts ?? 0,
    open_requests: row?.open_requests ?? 0,
  };
}

export function listUsers(
  storage: DurableObjectStorage,
  limit = 20,
  cursor = "",
  query = ""
): UserPage {
  const size = Math.max(1, Math.min(limit, 100));
  const rows = storage.sql
    .exec(
      `SELECT u.email AS email,
              (SELECT COUNT(*) FROM agents a WHERE a.admin_email = u.email) AS agents
         FROM (SELECT admin_email AS email FROM agents WHERE admin_email != ''
               UNION
               SELECT email FROM agent_members) u
        WHERE u.email > ? AND instr(u.email, ?) > 0
        ORDER BY u.email ASC LIMIT ?`,
      cursor,
      query.trim().toLowerCase(),
      size + 1
    )
    .toArray() as unknown as { email: string; agents: number }[];
  const page = rows.slice(0, size);
  return {
    users: page,
    has_more: rows.length > size,
    cursor: rows.length > size ? page[page.length - 1].email : "",
  };
}

export function userDetail(storage: DurableObjectStorage, email: string): UserDetail {
  const wanted = email.trim().toLowerCase();
  const rows = storage.sql
    .exec(
      `SELECT id, name, admin_email, MAX(session_count, 0) AS sessions FROM agents
        WHERE admin_email = ?
           OR id IN (SELECT agent_id FROM agent_members WHERE email = ?)
        ORDER BY created_at ASC, id ASC`,
      wanted,
      wanted
    )
    .toArray() as unknown as {
    id: string;
    name: string;
    admin_email: string;
    sessions: number;
  }[];
  return {
    email: wanted,
    agent_limit: getAgentLimit(storage, wanted),
    agents: rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.admin_email === wanted ? "admin" : "member",
      sessions: r.sessions,
    })),
  };
}

export function unmeasuredAgents(storage: DurableObjectStorage): string[] {
  const rows = storage.sql
    .exec(`SELECT id FROM agents WHERE session_count < 0`)
    .toArray() as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export function setSessionCount(storage: DurableObjectStorage, id: string, count: number) {
  storage.sql.exec(`UPDATE agents SET session_count = ? WHERE id = ?`, Math.max(0, count), id);
}

export function distinctUsers(storage: DurableObjectStorage): number {
  const row = storage.sql
    .exec(
      `SELECT COUNT(*) AS n FROM (
         SELECT admin_email AS email FROM agents WHERE admin_email != ''
         UNION
         SELECT email FROM agent_members
       )`
    )
    .toArray()[0] as { n: number } | undefined;
  return row?.n ?? 0;
}

export function businessAccounts(storage: DurableObjectStorage): number {
  const row = storage.sql.exec(`SELECT COUNT(*) AS n FROM account_limits`).toArray()[0] as
    { n: number } | undefined;
  return row?.n ?? 0;
}

export function agentLimits(storage: DurableObjectStorage): Record<string, number> {
  const rows = storage.sql
    .exec(`SELECT email, agent_limit FROM account_limits`)
    .toArray() as unknown as { email: string; agent_limit: number }[];
  return Object.fromEntries(rows.map((r) => [r.email, r.agent_limit]));
}
