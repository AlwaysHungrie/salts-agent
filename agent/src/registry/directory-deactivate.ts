/**
 * Deactivating an account: the user deletes their own Salts account. Allowed only once
 * nothing they hold still costs or carries value — no agents they administer (so no Google
 * Calendar or other per-agent credentials are left), no keys in the Tokens Wallet, and no
 * business phone numbers. What remains is cleared here.
 *
 * Kept on purpose: payment records (tax and accounting), the starter-key grant (so a new
 * sign-up with the same address is not given it twice), and memberships and guest places
 * on other people's agents — those lists belong to their owners, and signing up again
 * with the same address restores that access.
 */

const norm = (email: string) => email.trim().toLowerCase();

const count = (storage: DurableObjectStorage, sql: string, email: string): number =>
  (storage.sql.exec(sql, email).toArray()[0] as { n: number } | undefined)?.n ?? 0;

/** What stands in the way of deactivating, in words the page shows. Empty when nothing. */
export function deactivationBlockers(storage: DurableObjectStorage, email: string): string[] {
  const who = norm(email);
  const blockers: string[] = [];
  const agents = count(storage, `SELECT COUNT(*) AS n FROM agents WHERE admin_email = ?`, who);
  if (agents) blockers.push(`Delete your ${agents === 1 ? "agent" : `${agents} agents`} first.`);
  const keys = count(storage, `SELECT COUNT(*) AS n FROM wallet_keys WHERE email = ?`, who);
  if (keys) {
    blockers.push(
      `Remove the ${keys === 1 ? "key" : `${keys} keys`} in your Tokens Wallet first.`
    );
  }
  const numbers = count(storage, `SELECT COUNT(*) AS n FROM phone_numbers WHERE email = ?`, who);
  if (numbers) {
    blockers.push(
      `Release your ${numbers === 1 ? "business phone number" : `${numbers} business phone numbers`} first.`
    );
  }
  return blockers;
}

/**
 * Clear the account's own rows, or return what blocks it. One transaction, so an agent
 * created between the check and the delete cannot slip through half-cleared.
 */
export function deactivateAccount(
  storage: DurableObjectStorage,
  email: string
): { blockers: string[] } {
  const who = norm(email);
  return storage.transactionSync(() => {
    const blockers = deactivationBlockers(storage, who);
    if (blockers.length) return { blockers };
    const computers = storage.sql
      .exec(`SELECT id FROM salts_computers WHERE owner_email = ?`, who)
      .toArray()
      .map((r) => String(r.id));
    for (const id of computers) {
      storage.sql.exec(`DELETE FROM salts_links WHERE computer_id = ?`, id);
      storage.sql.exec(`DELETE FROM salts_pairings WHERE computer_id = ?`, id);
    }
    storage.sql.exec(`DELETE FROM salts_computers WHERE owner_email = ?`, who);
    storage.sql.exec(`DELETE FROM account_limits WHERE email = ?`, who);
    storage.sql.exec(`DELETE FROM business_requests WHERE email = ?`, who);
    storage.sql.exec(`DELETE FROM message_balances WHERE email = ?`, who);
    return { blockers: [] };
  });
}
