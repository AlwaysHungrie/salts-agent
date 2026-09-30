/** The addresses in a stored access list: lowercased, trimmed, blanks dropped. */
export function splitEmails(stored: string): string[] {
  return stored
    .split("\n")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The stored access list: lowercased, de-duplicated, one per line. Throws above the
 * deployment's `max_members`.
 */
export function normalizeEmails(input: string | string[], maxMembers: number): string {
  const raw = Array.isArray(input) ? input : input.split(/[\n,;]/);
  const seen = new Set<string>();
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    // Enough of a shape check to keep typos and pasted prose out of the list.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) seen.add(email);
  }
  if (seen.size > maxMembers) {
    throw new Error(`an agent may have at most ${maxMembers} addresses on its access list`);
  }
  return [...seen].join("\n");
}

/** The first address on a stored access list, or "" when it is empty. */
export function firstEmail(allowed: string): string {
  return splitEmails(allowed)[0] ?? "";
}

/** Whether `email` is on a stored access list (an exact match on the row in hand). */
export function emailAllowed(allowed: string, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  return splitEmails(allowed).includes(wanted);
}
