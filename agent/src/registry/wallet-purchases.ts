import type { WalletKeyRow, WalletPurchase } from "./types";
import { CLOCK_SLACK_MS } from "../payments";
import { addWalletKey } from "./wallet";

const PURCHASE_ID = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * Record a quote. Refused as `{ error }` when an unpaid quote on the same network and asset
 * asks for exactly these units and could still claim a payment: one not yet expired, or
 * expired less than `CLOCK_SLACK_MS` ago. A payment counts for a quote made up to that
 * slack after it landed, so an amount stays reserved that long after its quote expires;
 * otherwise a stranger could quote right after the expiry, land the same amount, and
 * claim a payment its buyer had not confirmed yet. No two quotes that could claim the
 * same payment ever share an amount.
 */
export function createPurchase(
  storage: DurableObjectStorage,
  p: Omit<WalletPurchase, "id" | "status" | "tx" | "claimed_at">
): WalletPurchase | { error: string } {
  const clash = storage.sql
    .exec(
      `SELECT id FROM wallet_purchases
        WHERE status = 'pending' AND network = ? AND asset = ? AND units = ? AND expires_at >= ?
        LIMIT 1`,
      p.network,
      p.asset,
      p.units,
      p.created_at - CLOCK_SLACK_MS
    )
    .toArray();
  if (clash.length) return { error: "clash" };
  const row: WalletPurchase = { ...p, id: PURCHASE_ID(), status: "pending", tx: null, claimed_at: 0 };
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

/**
 * `email`'s purchases on `network` that `tx` could still pay for, newest first: its own
 * purchase if `tx` already counted for one, otherwise the unpaid ones made since `since`.
 */
export function recoverable(
  storage: DurableObjectStorage,
  email: string,
  network: string,
  tx: string,
  since: number
): WalletPurchase[] {
  const counted = storage.sql
    .exec(`SELECT * FROM wallet_purchases WHERE tx = ? AND email = ? LIMIT 1`, tx, email)
    .toArray();
  if (counted.length) return counted as unknown as WalletPurchase[];
  return storage.sql
    .exec(
      `SELECT * FROM wallet_purchases
        WHERE email = ? AND network = ? AND status = 'pending' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10`,
      email,
      network,
      since
    )
    .toArray() as unknown as WalletPurchase[];
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

/** How long one confirm holds a paid purchase while it delivers, before another may. */
const CLAIM_MS = 60_000;

/**
 * Take up a paid purchase for delivery. False while another confirm holds it, so a key is
 * made once however many confirms arrive together.
 */
export function claimPurchase(storage: DurableObjectStorage, id: string, now: number): boolean {
  const cursor = storage.sql.exec(
    `UPDATE wallet_purchases SET claimed_at = ? WHERE id = ? AND status = 'paid' AND claimed_at <= ?`,
    now,
    id,
    now - CLAIM_MS
  );
  return cursor.rowsWritten > 0;
}

/** Let go of a purchase whose delivery failed, so the next confirm tries again. */
export function releasePurchase(storage: DurableObjectStorage, id: string) {
  storage.sql.exec(`UPDATE wallet_purchases SET claimed_at = 0 WHERE id = ? AND status = 'paid'`, id);
}

/**
 * Deliver a paid purchase as a new key in the buyer's wallet. The wallet's ceiling is not
 * applied: the key is paid for (the quote refused a full wallet). Undefined when the
 * purchase is not paid and undelivered.
 */
export function fulfilNewKey(
  storage: DurableObjectStorage,
  id: string,
  key: { secret: string; openrouter_hash: string }
): WalletKeyRow | undefined {
  return storage.transactionSync(() => {
    const p = paidRow(storage, id);
    if (!p) return undefined;
    const row = addWalletKey(
      storage,
      p.email,
      { kind: "provisioned", ...key },
      Infinity
    ) as WalletKeyRow;
    storage.sql.exec(
      `UPDATE wallet_purchases SET status = 'fulfilled', key_id = ? WHERE id = ?`,
      row.id,
      id
    );
    return row;
  });
}

function paidRow(storage: DurableObjectStorage, id: string): WalletPurchase | undefined {
  return storage.sql
    .exec(`SELECT * FROM wallet_purchases WHERE id = ? AND status = 'paid' LIMIT 1`, id)
    .toArray()[0] as unknown as WalletPurchase | undefined;
}

/**
 * A value the owner set for the deployment from the admin CLI (the provisioning key, the
 * payment addresses), or "" when it is not set. Kept in `deployment_secrets`.
 */
export function deploymentValue(storage: DurableObjectStorage, name: string): string {
  const row = storage.sql
    .exec(`SELECT value FROM deployment_secrets WHERE name = ? LIMIT 1`, name)
    .toArray()[0] as { value: string } | undefined;
  return row?.value ?? "";
}

/** Set a deployment value; blank removes it. */
export function setDeploymentValue(storage: DurableObjectStorage, name: string, value: string) {
  if (!value) {
    storage.sql.exec(`DELETE FROM deployment_secrets WHERE name = ?`, name);
    return;
  }
  storage.sql.exec(
    `INSERT INTO deployment_secrets (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    name,
    value
  );
}
