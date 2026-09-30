import type { AccessRow } from "./types";

export function readAccess(storage: DurableObjectStorage): AccessRow {
  const row = storage.sql
    .exec(
      `SELECT allowed_emails, admin_email, seeded, guests, guest_emails FROM access WHERE id = 1`
    )
    .toArray()[0] as AccessRow | undefined;
  return row ?? { allowed_emails: "", admin_email: "", seeded: 0, guests: 0, guest_emails: "" };
}

export function setAccess(
  storage: DurableObjectStorage,
  patch: { allowed_emails?: string; admin_email?: string }
): AccessRow {
  const current = readAccess(storage);
  const allowed = patch.allowed_emails ?? current.allowed_emails;
  const admin = current.admin_email || (patch.admin_email ?? "").trim().toLowerCase();
  storage.sql.exec(
    `INSERT INTO access (id, allowed_emails, admin_email, seeded) VALUES (1, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       allowed_emails = excluded.allowed_emails,
       admin_email = excluded.admin_email,
       seeded = 1`,
    allowed,
    admin
  );
  return { ...current, allowed_emails: allowed, admin_email: admin, seeded: 1 };
}

export function setGuestAccess(
  storage: DurableObjectStorage,
  patch: { guests?: number; guest_emails?: string }
): AccessRow {
  const current = readAccess(storage);
  const guests = patch.guests === undefined ? current.guests : patch.guests ? 1 : 0;
  const emails = patch.guest_emails ?? current.guest_emails;
  storage.sql.exec(
    `INSERT INTO access (id, allowed_emails, admin_email, seeded, guests, guest_emails)
     VALUES (1, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET guests = excluded.guests, guest_emails = excluded.guest_emails`,
    current.allowed_emails,
    current.admin_email,
    guests,
    emails
  );
  return { ...current, guests, guest_emails: emails };
}

export function seedAccess(
  storage: DurableObjectStorage,
  allowedEmails: string,
  adminEmail: string
): AccessRow {
  const current = readAccess(storage);
  if (current.seeded) return current;
  const admin = adminEmail.trim().toLowerCase();
  storage.sql.exec(
    `INSERT INTO access (id, allowed_emails, admin_email, seeded) VALUES (1, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       allowed_emails = excluded.allowed_emails,
       admin_email = excluded.admin_email,
       seeded = 1`,
    allowedEmails,
    admin
  );
  return { ...current, allowed_emails: allowedEmails, admin_email: admin, seeded: 1 };
}
