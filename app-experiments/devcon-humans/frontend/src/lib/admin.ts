import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { users } from "./db";
import type { Session } from "./session";

/** Header the admin sign-in sends the key in (read from the browser's `HUMANS_ADMIN_KEY` local storage). */
export const ADMIN_HEADER = "x-humans-admin-key";

/** Shortest HUMANS_ADMIN_KEY accepted; a shorter one leaves admin mode off. */
const MIN_KEY_CHARS = 32;

/** Whether `sent` is the server's HUMANS_ADMIN_KEY. False when admin mode is off (key unset or too short). */
export function isAdminKey(sent: string | null): boolean {
  const key = process.env.HUMANS_ADMIN_KEY;
  if (!key || key.length < MIN_KEY_CHARS || !sent) return false;
  // Hashed first so the comparison takes the same time whatever the lengths.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(sent), digest(key));
}

/** Tickets whose holder is an admin: signing in with one turns admin mode on, no key needed. */
const ADMIN_EMAILS = new Set(["dhairyashah98@gmail.com"]);

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Whether a session is in admin mode: it says so, or (for one signed before the claim existed)
 * its user's email is an admin's.
 */
export async function isAdminSession(session: Session | null): Promise<boolean> {
  if (!session) return false;
  if (session.admin) return true;
  const doc = await (await users()).findOne({ userId: session.userId }, { projection: { email: 1 } });
  return !!doc && isAdminEmail(doc.email);
}

/** An email worth looking up: one `@`, something either side, no spaces. Lower-cased. */
export function adminEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/**
 * The user id for an email no badge has been picked up for yet. A later pickup with a real
 * ticket gets its own id, but finds the same fleet agent, since agents are found by email.
 */
export function emailUserId(email: string): string {
  return "dc-email-" + createHash("sha256").update(email).digest("hex").slice(0, 32);
}
