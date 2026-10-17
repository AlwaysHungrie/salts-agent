import type { WalletPurchase } from "./types";

const PURCHASE_ID = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * Record a quote. Refused as `{ error }` when an open quote on the same network and asset
 * already asks for exactly these units, so every open amount is its own.
 */
export function createPurchase(
  storage: DurableObjectStorage,
  p: Omit<WalletPurchase, "id" | "status" | "tx">
): WalletPurchase | { error: string } {
  const clash = storage.sql
    .exec(
      `SELECT id FROM wallet_purchases
        WHERE status = 'pending' AND network = ? AND asset = ? AND units = ? AND expires_at > ?
        LIMIT 1`,
      p.network,
      p.asset,
      p.units,
      p.created_at
    )
    .toArray();
  if (clash.length) return { error: "clash" };
  const row: WalletPurchase = { ...p, id: PURCHASE_ID(), status: "pending", tx: null };
  storage.sql.exec(
    `INSERT INTO wallet_purchases
       (id, email, key_id, amount_usd, network, asset, to_address, payer, units, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.email,
    row.key_id,
    row.amount_usd,
    row.network,
    row.asset,
    row.to_address,
    row.payer,
    row.units,
    row.created_at,
    row.expires_at
  );
  return row;
}

/** One of `email`'s purchases, or undefined when it is someone else's. */
export function purchase(
  storage: DurableObjectStorage,
  email: string,
  id: string
): WalletPurchase | undefined {
  return storage.sql
    .exec(`SELECT * FROM wallet_purchases WHERE id = ? AND email = ? LIMIT 1`, id, email)
    .toArray()[0] as unknown as WalletPurchase | undefined;
}

/** Whether `tx` already paid for a purchase. */
export function txCounted(storage: DurableObjectStorage, tx: string): boolean {
  return storage.sql.exec(`SELECT id FROM wallet_purchases WHERE tx = ? LIMIT 1`, tx).toArray().length > 0;
}

/**
 * Mark a purchase paid by `tx`. False when the transaction already paid for another
 * purchase, or this one is no longer pending.
 */
export function markPurchasePaid(storage: DurableObjectStorage, id: string, tx: string): boolean {
  if (txCounted(storage, tx)) return false;
  const cursor = storage.sql.exec(
    `UPDATE wallet_purchases SET status = 'paid', tx = ? WHERE id = ? AND status = 'pending'`,
    tx,
    id
  );
  return cursor.rowsWritten > 0;
}
