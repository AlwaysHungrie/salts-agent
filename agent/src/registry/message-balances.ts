import { paidRow } from "./wallet-purchases";

/**
 * Each account's WhatsApp for Business message balance: replies its agents may still send,
 * bought in packs. One balance per account, shared by all its agents.
 */

const owner = (email: string) => email.trim().toLowerCase();

/** How many messages `email` has left; 0 before their first pack. */
export function messageBalance(storage: DurableObjectStorage, email: string): number {
  const row = storage.sql
    .exec(`SELECT messages FROM message_balances WHERE email = ?`, owner(email))
    .toArray()[0] as { messages: number } | undefined;
  return row?.messages ?? 0;
}

/**
 * Take one message from `email`'s balance for an agent's reply. False when none are left:
 * the agent does not reply.
 */
export function spendMessage(storage: DurableObjectStorage, email: string): boolean {
  const cursor = storage.sql.exec(
    `UPDATE message_balances SET messages = messages - 1 WHERE email = ? AND messages > 0`,
    owner(email)
  );
  return cursor.rowsWritten > 0;
}

/**
 * Deliver a paid message pack: its messages go on the buyer's balance. The new balance,
 * or undefined when the purchase is not paid and undelivered.
 */
export function fulfilMessages(storage: DurableObjectStorage, purchaseId: string): number | undefined {
  return storage.transactionSync(() => {
    const p = paidRow(storage, purchaseId);
    if (!p || p.item !== "messages") return undefined;
    storage.sql.exec(
      `INSERT INTO message_balances (email, messages) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET messages = messages + excluded.messages`,
      owner(p.email),
      p.messages ?? 0
    );
    storage.sql.exec(`UPDATE wallet_purchases SET status = 'fulfilled' WHERE id = ?`, purchaseId);
    return messageBalance(storage, p.email);
  });
}
