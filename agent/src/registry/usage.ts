import { readMeta } from "./agent-config";

/** Spend-row month as `YYYY-MM` in UTC, so the ceiling resets at one moment for everyone. */
export function thisMonth(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7);
}

export function addStorageBytes(storage: DurableObjectStorage, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  // The delta is bound twice, not read via `excluded` (which holds the zero-clamped
  // insert value), or deletes would never give bytes back.
  const bytes = Math.trunc(delta);
  storage.sql.exec(
    `INSERT INTO storage (id, bytes) VALUES (1, MAX(?, 0))
     ON CONFLICT(id) DO UPDATE SET bytes = MAX(bytes + ?, 0)`,
    bytes,
    bytes
  );
}

export function storageState(
  storage: DurableObjectStorage,
  limit: number
): { bytes: number; limit: number } {
  const row = storage.sql.exec(`SELECT bytes FROM storage WHERE id = 1 LIMIT 1`).toArray()[0] as
    { bytes: number } | undefined;
  return { bytes: Math.max(0, Number(row?.bytes ?? 0)), limit };
}

export function storageRoom(storage: DurableObjectStorage, limit: number): number {
  const { bytes } = storageState(storage, limit);
  return Math.max(0, limit - bytes);
}

export function addSpend(storage: DurableObjectStorage, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  storage.sql.exec(
    `INSERT INTO spend (month, usd) VALUES (?, ?)
     ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd`,
    thisMonth(),
    usd
  );
}

export function spendThisMonth(storage: DurableObjectStorage): number {
  const row = storage.sql
    .exec(`SELECT usd FROM spend WHERE month = ? LIMIT 1`, thisMonth())
    .toArray()[0] as { usd: number } | undefined;
  return row?.usd ?? 0;
}

export function spendState(storage: DurableObjectStorage): {
  usd: number;
  limit: number;
  month: string;
} {
  return {
    usd: spendThisMonth(storage),
    limit: readMeta(storage).monthly_spend_limit,
    month: thisMonth(),
  };
}
