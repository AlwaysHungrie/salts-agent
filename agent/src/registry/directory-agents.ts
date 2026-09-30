import { firstEmail, splitEmails } from "./emails";
import type { AgentRow } from "./types";

/** How stale an agent's "last used" date may get before `touch` writes again. */
export const TOUCH_INTERVAL = 5 * 60 * 1000;

export function writeMembers(storage: DurableObjectStorage, id: string, allowedEmails: string) {
  const emails = splitEmails(allowedEmails);
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM agent_members WHERE agent_id = ?`, id);
    for (const email of emails) {
      storage.sql.exec(
        `INSERT OR IGNORE INTO agent_members (agent_id, email) VALUES (?, ?)`,
        id,
        email
      );
    }
    storage.sql.exec(
      `UPDATE agents SET allowed_emails = ?, updated_at = ? WHERE id = ?`,
      emails.join("\n"),
      Date.now(),
      id
    );
  });
}

export function getAgent(storage: DurableObjectStorage, id: string): AgentRow | undefined {
  return storage.sql
    .exec(
      `SELECT id, name, created_at, updated_at, allowed_emails, admin_email,
              fleet_id, fleet_name FROM agents
       WHERE id = ? LIMIT 1`,
      id
    )
    .toArray()[0] as unknown as AgentRow | undefined;
}

export function createAgent(
  storage: DurableObjectStorage,
  id: string,
  name: string,
  allowedEmails: string,
  adminEmail: string,
  fleet?: { id: string; name: string },
  metadata: Record<string, string> = {}
): AgentRow {
  const now = Date.now();
  const admin = adminEmail.trim().toLowerCase() || firstEmail(allowedEmails);
  const fleetId = fleet?.id ?? "";
  const fleetName = fleet?.name ?? "";
  storage.sql.exec(
    `INSERT INTO agents (id, name, created_at, updated_at, allowed_emails, admin_email,
                         fleet_id, fleet_name, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    now,
    now,
    allowedEmails,
    admin,
    fleetId,
    fleetName,
    JSON.stringify(metadata)
  );
  // The row is in; this puts the same addresses in `agent_members` beside it.
  writeMembers(storage, id, allowedEmails);
  return {
    id,
    name,
    created_at: now,
    updated_at: now,
    allowed_emails: allowedEmails,
    admin_email: admin,
    fleet_id: fleetId,
    fleet_name: fleetName,
  };
}

export function setAllowedEmails(storage: DurableObjectStorage, id: string, allowedEmails: string) {
  writeMembers(storage, id, allowedEmails);
}

export function renameAgent(storage: DurableObjectStorage, id: string, name: string) {
  storage.sql.exec(`UPDATE agents SET name = ?, updated_at = ? WHERE id = ?`, name, Date.now(), id);
}

export function touchAgent(storage: DurableObjectStorage, id: string) {
  const now = Date.now();
  const row = storage.sql
    .exec(`SELECT updated_at FROM agents WHERE id = ? LIMIT 1`, id)
    .toArray()[0] as { updated_at: number } | undefined;
  if (!row) return;
  if (now - row.updated_at < TOUCH_INTERVAL) return;
  storage.sql.exec(`UPDATE agents SET updated_at = ? WHERE id = ?`, now, id);
}

export function removeAgent(storage: DurableObjectStorage, id: string) {
  // The member rows go too. Nothing else points at them, so one left behind would
  // be invisible for good — and would put the agent back on somebody's list if its
  // id were ever reused.
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM agent_members WHERE agent_id = ?`, id);
    storage.sql.exec(`DELETE FROM agent_guests WHERE agent_id = ?`, id);
    storage.sql.exec(`DELETE FROM agents WHERE id = ?`, id);
  });
}

export function setAgentGuests(
  storage: DurableObjectStorage,
  id: string,
  guests: number,
  guestEmails: string
) {
  const emails = splitEmails(guestEmails);
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM agent_guests WHERE agent_id = ?`, id);
    for (const email of emails) {
      storage.sql.exec(
        `INSERT OR IGNORE INTO agent_guests (agent_id, email) VALUES (?, ?)`,
        id,
        email
      );
    }
    storage.sql.exec(`UPDATE agents SET guests = ? WHERE id = ?`, guests ? 1 : 0, id);
  });
}
