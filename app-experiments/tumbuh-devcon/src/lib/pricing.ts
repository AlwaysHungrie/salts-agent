/** Std Mumbai retail price of 1 L of packaged mineral water (Bisleri, Mar 2026 hike), in INR. */
export const INR_PER_LITRE = 20;
/** Fixed conversion rate, INR per USD. */
export const USD_INR = 95;

/** USDC base units (6 decimals) owed for `ml` of water; at least 1 for any positive amount. */
export function usdcUnits(ml: number): bigint {
  if (!(ml > 0)) return 0n;
  const usd = ((ml / 1000) * INR_PER_LITRE) / USD_INR;
  const units = BigInt(Math.round(usd * 1e6));
  return units > 0n ? units : 1n;
}
