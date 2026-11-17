/**
 * Card and UPI payments for wallet keys, through Razorpay. The Worker makes an order for
 * the purchase's rupee total; the browser pays it in Razorpay's checkout; the Worker then
 * reads the payment back from Razorpay with its own key before counting it, so nothing the
 * browser says is taken on trust. A signed webhook counts payments whose page was closed.
 */

const API = "https://api.razorpay.com/v1";

/** The deployment's Razorpay credentials, set from the admin CLI; "" where not set. */
export type RazorpayKeys = { key_id: string; key_secret: string; webhook_secret: string };

/** A purchase paid through Razorpay sits under this network id, priced in rupees. */
export const RAZORPAY_NETWORK = "razorpay";

export class RazorpayError extends Error {}

/** A Razorpay payment, as far as counting it goes. Amounts are in paise. */
export type RazorpayPayment = {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
};

async function call<T>(keys: RazorpayKeys, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Basic ${btoa(`${keys.key_id}:${keys.key_secret}`)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    throw new RazorpayError(err.error?.description ?? `Razorpay didn't answer (${res.status}). Try again.`);
  }
  return (await res.json()) as T;
}

/** Whether Razorpay accepts this key id and secret. */
export async function razorpayKeysWork(keys: RazorpayKeys): Promise<boolean> {
  const res = await fetch(`${API}/orders?count=1`, {
    headers: { authorization: `Basic ${btoa(`${keys.key_id}:${keys.key_secret}`)}` },
  });
  return res.ok;
}

/** An order for `paise` rupee paise, which Razorpay's checkout is opened on. */
export async function createOrder(keys: RazorpayKeys, paise: number): Promise<string> {
  const order = await call<{ id: string }>(keys, "POST", "/orders", { amount: paise, currency: "INR" });
  return order.id;
}

export async function fetchPayment(keys: RazorpayKeys, id: string): Promise<RazorpayPayment> {
  return await call<RazorpayPayment>(keys, "GET", `/payments/${encodeURIComponent(id)}`);
}

/** Capture an authorized payment, for accounts that don't capture automatically. */
export async function capturePayment(keys: RazorpayKeys, p: RazorpayPayment): Promise<RazorpayPayment> {
  return await call<RazorpayPayment>(keys, "POST", `/payments/${encodeURIComponent(p.id)}/capture`, {
    amount: p.amount,
    currency: p.currency,
  });
}

/** A Razorpay payment id as it writes one, or undefined. */
export function paymentId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return /^pay_[A-Za-z0-9]{6,40}$/.test(id) ? id : undefined;
}

/** Whether `signature` is Razorpay's HMAC-SHA256 of `body` under `secret`, in hex. */
export async function signatureValid(secret: string, body: string, signature: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const bytes = signature.match(/^[0-9a-f]{64}$/i)?.[0].match(/../g)?.map((h) => parseInt(h, 16));
  if (!bytes) return false;
  // `verify` compares in constant time.
  return await crypto.subtle.verify("HMAC", key, new Uint8Array(bytes), enc.encode(body));
}
