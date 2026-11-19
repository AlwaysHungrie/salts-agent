import type { Env } from "../env";
import type { WalletPurchase } from "../registry";
import {
  capturePayment,
  type CardCurrency,
  createOrder,
  fetchPayment,
  paymentId,
  RAZORPAY_NETWORK,
  RazorpayError,
  type RazorpayKeys,
  signatureValid,
} from "../razorpay";
import { deploymentSettings } from "../settings";
import { FxError, inrPerUsd } from "../fx";
import { json, jsonError, readJson } from "../worker/http";
import { directory } from "../worker/stores";
import { deliver } from "./wallet";

/** How long a card order is kept open for; Razorpay's own orders don't expire. */
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;

/** The Razorpay keys, when card payments are open: key id, secret and a provisioning key. */
async function openKeys(env: Env): Promise<RazorpayKeys | undefined> {
  const dir = directory(env);
  const keys = await dir.razorpayKeys();
  if (!keys.key_id || !keys.key_secret || !(await dir.provisioningKey())) return undefined;
  return keys;
}

/**
 * The Razorpay key id the browser opens checkout with; "" while card payments are closed.
 * Public: Razorpay's checkout is opened with it in the page.
 */
export async function cardKeyId(env: Env): Promise<string> {
  return (await openKeys(env))?.key_id ?? "";
}

/** Whole units of credit to buy (rupees or dollars), from `min` to `max`. */
function wholeOf(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Make a Razorpay order for a new key, in rupees (`amount_inr`) or US dollars
 * (`amount_usd`, which PayPal pays for buyers outside India). The credit is chosen in
 * whole units; the fee is added in paise or cents, rounded up. A dollar key gets its
 * credit as chosen; a rupee key gets the credit's dollar worth at today's rate
 * (`inrPerUsd`), rounded down to the cent so the deployment is never short.
 */
export async function cardOrder(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ amount_inr?: number; amount_usd?: number }>(request);
  const settings = await deploymentSettings(env);
  const currency: CardCurrency = body.amount_usd !== undefined ? "USD" : "INR";
  const [min, max] =
    currency === "USD" ? [settings.card_min_usd, settings.card_max_usd] : [settings.card_min_inr, settings.card_max_inr];
  const credit = wholeOf(currency === "USD" ? body.amount_usd : body.amount_inr, min, max);
  if (!credit) {
    const sign = currency === "USD" ? "$" : "₹";
    return jsonError(`Choose a whole amount from ${sign}${min} to ${sign}${max}.`, 400);
  }
  const keys = await openKeys(env);
  if (!keys) return jsonError("Card payments aren't open yet.", 503);
  // Today's rate, locked into a rupee order: the key's dollar credit is fixed by it.
  let rate = 1;
  if (currency === "INR") {
    try {
      rate = await inrPerUsd();
    } catch (err) {
      if (err instanceof FxError) return jsonError(err.message, 503);
      throw err;
    }
  }
  const dir = directory(env);
  if ((await dir.walletKeys(email)).length >= settings.max_wallet_keys) {
    return jsonError(`A wallet holds at most ${settings.max_wallet_keys} keys.`, 400);
  }

  // Paise or cents.
  const creditMinor = credit * 100;
  const feeMinor = Math.ceil((creditMinor * settings.wallet_fee_bps) / 10_000);
  const totalMinor = creditMinor + feeMinor;
  const usd = currency === "USD" ? credit : Math.floor(creditMinor / rate) / 100;
  let orderId: string;
  try {
    orderId = await createOrder(keys, totalMinor, currency);
  } catch (err) {
    if (err instanceof RazorpayError) return jsonError(err.message, 502);
    throw err;
  }
  const now = Date.now();
  const made = await dir.createCardPurchase({
    email,
    key_id: "",
    amount_usd: usd,
    network: RAZORPAY_NETWORK,
    asset: currency === "USD" ? "usd" : "inr",
    to_address: orderId,
    payer: "",
    units: String(totalMinor),
    created_at: now,
    expires_at: now + ORDER_TTL_MS,
  });
  const common = {
    id: made.id,
    key_id: keys.key_id,
    order_id: orderId,
    currency,
    amount: totalMinor,
    amount_usd: usd,
    // The buyer's Salts email, filled into Razorpay's checkout: their receipt goes there,
    // and the dashboard shows who paid.
    email,
  };
  if (currency === "USD") {
    return json({ ...common, credit_usd: credit, fee_usd: feeMinor / 100, total_usd: totalMinor / 100 });
  }
  return json({
    ...common,
    credit_inr: credit,
    fee_inr: feeMinor / 100,
    total_inr: totalMinor / 100,
    total_usd: Math.round(totalMinor / rate) / 100,
  });
}

type Settled = { status: "paid" } | { status: "pending" | "failed"; reason: string };

/**
 * Read `paymentId` back from Razorpay and count it for `p` when it pays exactly this
 * order, capturing it first if the account doesn't capture on its own.
 */
async function settle(env: Env, keys: RazorpayKeys, p: WalletPurchase, id: string): Promise<Settled> {
  let payment = await fetchPayment(keys, id);
  const currency = p.asset === "usd" ? "USD" : "INR";
  if (payment.order_id !== p.to_address || payment.currency !== currency || payment.amount !== Number(p.units)) {
    return { status: "failed", reason: "That payment isn't for this purchase." };
  }
  if (payment.status === "authorized") payment = await capturePayment(keys, payment);
  if (payment.status === "created") return { status: "pending", reason: "Waiting for the payment to go through." };
  if (payment.status !== "captured") return { status: "failed", reason: "The payment didn't go through." };
  const dir = directory(env);
  if (!(await dir.markPurchasePaid(p.id, id))) {
    // Another confirm, or the webhook, may have counted it a moment ago.
    const now = await dir.purchase(p.email, p.id);
    if (now?.tx !== id) return { status: "failed", reason: "That payment has already been counted." };
  }
  return { status: "paid" };
}

/**
 * Count a card payment the browser says it made, then deliver the key. The browser only
 * names the payment: what counts is what Razorpay says about it.
 */
export async function cardConfirm(request: Request, env: Env, email: string, id: string): Promise<Response> {
  const dir = directory(env);
  const found = await dir.purchase(email, id);
  if (!found || found.network !== RAZORPAY_NETWORK) return jsonError("not found", 404);
  const body = await readJson<{ payment_id?: string }>(request);
  const payment = paymentId(body.payment_id);
  if (!payment) return jsonError("That isn't a Razorpay payment id.", 400);
  if (found.status !== "pending") {
    return found.tx === payment ? await deliver(env, found) : jsonError("This purchase is already paid.", 409);
  }
  const keys = await openKeys(env);
  if (!keys) return jsonError("Card payments aren't open yet.", 503);

  let settled: Settled;
  try {
    settled = await settle(env, keys, found, payment);
  } catch (err) {
    if (err instanceof RazorpayError) return jsonError(err.message, 502);
    throw err;
  }
  if (settled.status === "pending") return json(settled, 202);
  if (settled.status === "failed") return jsonError(settled.reason, 400);
  const paid = await dir.purchase(email, id);
  return paid ? await deliver(env, paid) : jsonError("not found", 404);
}

/**
 * Razorpay's webhook (`payment.captured`, `order.paid`): counts a payment whose page was
 * closed before it could confirm, and delivers its key. Signed with the webhook secret.
 * Answers 503 while the key can't be delivered yet, so Razorpay sends it again.
 */
export async function handleRazorpayWebhook(request: Request, env: Env): Promise<Response> {
  const keys = await directory(env).razorpayKeys();
  if (!keys.webhook_secret) return jsonError("not found", 404);
  const body = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!(await signatureValid(keys.webhook_secret, body, signature))) return jsonError("bad signature", 400);

  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
  try {
    event = JSON.parse(body);
  } catch {
    return jsonError("bad body", 400);
  }
  if (event.event !== "payment.captured" && event.event !== "order.paid") return json({ ignored: true });
  const entity = event.payload?.payment?.entity;
  const payment = paymentId(entity?.id);
  const found = entity?.order_id ? await directory(env).purchaseByOrder(entity.order_id) : undefined;
  // Not one of ours (another app on the same account): nothing to do.
  if (!payment || !found) return json({ ignored: true });

  const open = await openKeys(env);
  if (!open) return jsonError("Card payments aren't open.", 503);
  if (found.status === "pending") {
    const settled = await settle(env, open, found, payment).catch((err) => {
      if (err instanceof RazorpayError) return { status: "pending" as const, reason: err.message };
      throw err;
    });
    if (settled.status === "pending") return jsonError(settled.reason, 503);
    if (settled.status === "failed") return json({ ignored: true, reason: settled.reason });
  } else if (found.tx !== payment) {
    return json({ ignored: true });
  }
  const now = await directory(env).purchase(found.email, found.id);
  if (!now) return json({ ignored: true });
  const res = await deliver(env, now);
  return res.status === 200 ? json({ delivered: true }) : jsonError("Setting up the key.", 503);
}
