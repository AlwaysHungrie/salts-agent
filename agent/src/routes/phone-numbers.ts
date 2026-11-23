import type { Env } from "../env";
import { FxError, inrPerUsd } from "../fx";
import { type CardCurrency, createOrder, RAZORPAY_NETWORK, RazorpayError } from "../razorpay";
import type { PhoneNumberRow, WalletPurchase } from "../registry";
import { normalizeNumber } from "../registry/phone-numbers";
import { deploymentSettings } from "../settings";
import { buyUsNumber, releaseNumber, TwilioError, twilioOpen } from "../twilio";
import { callerEmail } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { directory } from "../worker/stores";
import { cardConfirm, cardKeyId } from "./card";

/** How long a number order is kept open for; Razorpay's own orders don't expire. */
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;

const view = ({ id, number, kind, created_at, expires_at, agent_id }: PhoneNumberRow) => ({
  id,
  number,
  kind,
  created_at,
  expires_at,
  agent_id,
});

/** The caller's numbers, each with the name of the agent it answers for ("" for none). */
async function walletView(env: Env, email: string) {
  const dir = directory(env);
  return Promise.all(
    (await dir.phoneNumbers(email)).map(async (n) => ({
      ...view(n),
      agent_name: n.agent_id ? ((await dir.get(n.agent_id))?.name ?? "") : "",
    }))
  );
}

/** Everything under `/api/phone-numbers`: the signed-in caller's Business Phone Numbers. */
export async function handlePhoneNumbers(
  request: Request,
  env: Env,
  segments: string[]
): Promise<Response | undefined> {
  const email = await callerEmail(request, env);
  if (!email) return jsonError("unauthorized", 401);
  const dir = directory(env);
  const [, , id, action, extra] = segments;
  const method = request.method;

  if (!id) {
    if (method === "GET") {
      const settings = await deploymentSettings(env);
      const numbers = await walletView(env, email);
      // Buying is open once both Twilio (to buy from) and Razorpay (to be paid) are set.
      const open = twilioOpen(await dir.twilioKeys());
      const keyId = open ? await cardKeyId(env) : "";
      const rate = keyId ? await inrPerUsd().catch(() => 0) : 0;
      const inr = (usd: number) => (rate ? Math.ceil(usd * rate) : 0);
      return json({
        numbers,
        max: settings.max_phone_numbers,
        price_usd: settings.phone_number_price_usd,
        term_months: settings.phone_number_term_months,
        razorpay_key_id: rate ? keyId : "",
        price_inr: inr(settings.phone_number_price_usd),
        messages_remaining: await dir.messageBalance(email),
        message_packs: settings.message_packs.map((p) => ({ ...p, price_inr: inr(p.price_usd) })),
      });
    }
    if (method === "POST") return await addOwn(request, env, email);
    return undefined;
  }

  if (id === "orders" && method === "POST" && !extra) {
    if (!action) return await numberOrder(request, env, email);
    return undefined;
  }
  if (id === "orders" && method === "POST" && extra === "confirm" && !segments[5]) {
    return await cardConfirm(request, env, email, action);
  }

  if (!action && method === "DELETE") {
    const held = (await dir.phoneNumbers(email)).find((n) => n.id === id);
    if (!held) return jsonError("not found", 404);
    // A bought number goes back to Twilio first, so nothing is dropped that still bills.
    if (held.twilio_sid) {
      try {
        await releaseNumber(await dir.twilioKeys(), held.twilio_sid);
      } catch (err) {
        if (err instanceof TwilioError) return jsonError(err.message, 502);
        throw err;
      }
    }
    await dir.removePhoneNumber(email, id);
    return json({ removed: id });
  }
  return undefined;
}

/** Add a number the caller already owns. */
async function addOwn(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ number?: unknown }>(request);
  const number = typeof body?.number === "string" ? normalizeNumber(body.number) : undefined;
  if (!number) {
    return jsonError("Enter the full number with its country code, e.g. 14155550123.", 400);
  }
  const settings = await deploymentSettings(env);
  const added = await directory(env).addPhoneNumber(
    email,
    { number, kind: "own" },
    settings.max_phone_numbers
  );
  if ("error" in added) return jsonError(added.error, 400);
  return json(view(added), 201);
}

/**
 * A Razorpay order at the deployment's price for one term of a US number (a new number, or
 * `renew` more time on one the caller bought), or for the message pack of `messages`. In
 * US dollars, or in whole rupees at today's rate (rounded up) for buyers in India.
 */
async function numberOrder(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ currency?: string; renew?: string; messages?: number }>(request);
  const currency: CardCurrency = body?.currency === "INR" ? "INR" : "USD";
  const dir = directory(env);
  const settings = await deploymentSettings(env);

  const pack =
    body?.messages !== undefined
      ? settings.message_packs.find((p) => p.messages === body.messages)
      : undefined;
  if (body?.messages !== undefined && !pack) return jsonError("That pack isn't on sale.", 400);
  if (!twilioOpen(await dir.twilioKeys())) return jsonError("Buying numbers isn't open yet.", 503);
  const keys = await dir.razorpayKeys();
  if (!keys.key_id || !keys.key_secret || !(await cardKeyId(env))) {
    return jsonError("Card payments aren't open yet.", 503);
  }

  const held = await dir.phoneNumbers(email);
  let target = "";
  if (pack) {
    // Packs top up a balance: no ceiling, nothing at Twilio.
  } else if (body?.renew) {
    const number = held.find((n) => n.id === body.renew && n.kind === "bought");
    if (!number) return jsonError("That isn't a number you bought.", 404);
    target = number.id;
  } else if (held.length >= settings.max_phone_numbers) {
    return jsonError(`A wallet holds at most ${settings.max_phone_numbers} numbers.`, 400);
  }

  const priceUsd = pack ? pack.price_usd : settings.phone_number_price_usd;
  let totalMinor = priceUsd * 100;
  if (currency === "INR") {
    try {
      totalMinor = Math.ceil(priceUsd * (await inrPerUsd())) * 100;
    } catch (err) {
      if (err instanceof FxError) return jsonError(err.message, 503);
      throw err;
    }
  }
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
    key_id: target,
    amount_usd: priceUsd,
    network: RAZORPAY_NETWORK,
    asset: currency === "USD" ? "usd" : "inr",
    to_address: orderId,
    payer: "",
    units: String(totalMinor),
    created_at: now,
    expires_at: now + ORDER_TTL_MS,
    item: pack ? "messages" : target ? "renew" : "number",
    messages: pack?.messages ?? 0,
  });
  return json({
    id: made.id,
    key_id: keys.key_id,
    order_id: orderId,
    currency,
    amount: totalMinor,
    total: totalMinor / 100,
    term_months: settings.phone_number_term_months,
    renew: Boolean(target),
    messages: pack?.messages ?? 0,
    email,
  });
}

/** Deliver a paid message pack: its messages go on the buyer's balance, once. */
export async function deliverMessages(env: Env, p: WalletPurchase): Promise<Response> {
  const dir = directory(env);
  if (p.status !== "fulfilled" && (await dir.fulfilMessages(p.id)) === undefined) {
    return settingUp("Adding your messages.");
  }
  return json({ status: "paid", messages_remaining: await dir.messageBalance(p.email) });
}

const settingUp = (reason = "Setting up your number.") => json({ status: "pending", reason }, 202);

/**
 * Deliver a paid number purchase: buy a US number at Twilio, or add a term to the one a
 * renewal names (a new number, should that one have been released before the payment
 * landed). Held by the purchase's claim, so two confirms buy one number.
 */
export async function deliverNumber(env: Env, p: WalletPurchase): Promise<Response> {
  if (p.status === "fulfilled") return json({ status: "paid", number_id: p.key_id });
  const dir = directory(env);
  const keys = await dir.twilioKeys();
  if (!twilioOpen(keys) || !(await dir.claimPurchase(p.id))) return settingUp();
  const term = (await deploymentSettings(env)).phone_number_term_months;

  try {
    if (p.item === "renew") {
      const renewed = await dir.renewNumber(p.id, term);
      if (renewed === undefined) throw new TwilioError("Couldn't renew the number.");
      if (renewed !== "gone") return json({ status: "paid", number_id: renewed.id });
    }
    const bought = await buyUsNumber(keys);
    const row = await dir.fulfilNumber(p.id, bought, term).catch(() => undefined);
    if (!row) {
      // Recorded nowhere, so it must not go on billing at Twilio.
      await releaseNumber(keys, bought.sid).catch(() => undefined);
      throw new TwilioError("Couldn't record the number.");
    }
    return json({ status: "paid", number_id: row.id });
  } catch (err) {
    await dir.releasePurchase(p.id);
    if (err instanceof TwilioError) return settingUp(err.message);
    throw err;
  }
}
