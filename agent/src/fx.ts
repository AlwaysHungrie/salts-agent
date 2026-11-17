/**
 * Rupees per US dollar, read at runtime from Frankfurter (the European Central Bank's
 * daily reference rates; free, no key). A card purchase locks the rate in when its order
 * is made, so a later change never moves a paid order.
 */

const SOURCE = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR";
/** How long a rate is used before it is read again. ECB rates change once a working day. */
const FRESH_MS = 60 * 60 * 1000;
/** How long the last rate may stand in while the source is down: past a long weekend. */
const STALE_OK_MS = 3 * 24 * 60 * 60 * 1000;

let cached: { rate: number; at: number } | undefined;

export class FxError extends Error {}

/** Rupees per dollar now. Throws `FxError` when no recent rate can be had. */
export async function inrPerUsd(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.at < FRESH_MS) return cached.rate;
  try {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new FxError(`rate source answered ${res.status}`);
    const body = (await res.json()) as { rates?: { INR?: unknown } };
    const rate = Number(body.rates?.INR);
    // A sanity bound: a rate this far out is a broken answer, not the market.
    if (!(rate > 10 && rate < 1000)) throw new FxError("rate source gave no usable rate");
    cached = { rate, at: now };
    return rate;
  } catch {
    if (cached && now - cached.at < STALE_OK_MS) return cached.rate;
    throw new FxError("Couldn't read the rupee rate. Try again in a minute.");
  }
}
