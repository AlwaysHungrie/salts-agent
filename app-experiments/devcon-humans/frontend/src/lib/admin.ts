import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

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
