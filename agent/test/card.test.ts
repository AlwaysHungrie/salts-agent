import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { signedIn } from "./clerk";
import { INR_PER_USD, PROVISIONING_KEY, RAZORPAY_SECRET } from "./openrouter-mock";
import { SHIPPED } from "./shipped";

/**
 * Buying a key by card or UPI through Razorpay. The Worker makes the order, the browser
 * pays it, and the payment counts only once Razorpay itself says it paid that order in
 * full; a signed webhook delivers the key when the page was closed first.
 */

const BASE = "https://worker.test";
const KEY_ID = "rzp_test_SaltsCards01";
const WEBHOOK_SECRET = "whsec-salts-test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;
const directory = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));

function as(email: string, init: RequestInit = {}) {
  return { ...init, headers: { "content-type": "application/json", ...signedIn(email) } };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

type OrderView = {
  id: string;
  key_id: string;
  order_id: string;
  amount: number;
  currency: string;
  credit_inr: number;
  fee_inr: number;
  total_inr: number;
  amount_usd: number;
  total_usd: number;
};

async function openCards() {
  const dir = directory();
  await dir.setProvisioningKey(PROVISIONING_KEY);
  await dir.setRazorpayKeys({ key_id: KEY_ID, key_secret: RAZORPAY_SECRET, webhook_secret: WEBHOOK_SECRET });
}

function order(email: string, amount_inr: number) {
  return SELF.fetch(
    `${BASE}/api/wallet/card-orders`,
    as(email, { method: "POST", body: JSON.stringify({ amount_inr }) })
  );
}

function confirm(email: string, id: string, payment_id: string) {
  return SELF.fetch(
    `${BASE}/api/wallet/card-orders/${id}/confirm`,
    as(email, { method: "POST", body: JSON.stringify({ payment_id }) })
  );
}

/** Pay an order in the stand-in checkout; the payment's id, as the checkout hands it back. */
async function pay(order_id: string, extra: { status?: string; amount?: number } = {}) {
  return (await json<{ id: string }>(
    fetch("https://api.razorpay.com/__pay", { method: "POST", body: JSON.stringify({ order_id, ...extra }) })
  )).id;
}

async function wallet(email: string) {
  return await json<{
    keys: { id: string; kind: string }[];
    razorpay_key_id: string;
    inr_per_usd: number;
    card_min_inr: number;
    card_max_inr: number;
    card_presets_inr: number[];
    card_default_inr: number;
  }>(
    SELF.fetch(`${BASE}/api/wallet`, as(email))
  );
}

async function madeKeys() {
  return await json<Record<string, { name: string; limit: number }>>(fetch("https://openrouter.ai/__keys"));
}

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function webhook(payload: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return SELF.fetch(`${BASE}/razorpay/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": await hmac(secret, body) },
    body,
  });
}

const captured = (id: string, order_id: string) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id, order_id } } },
});

function admin(init: RequestInit = {}) {
  return SELF.fetch(`${BASE}/api/admin/razorpay`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-secret": "test-secret" },
  });
}

const RATE = INR_PER_USD;

describe("buying a key by card", () => {
  beforeEach(openCards);

  it("hands the browser Razorpay's key id, today's rupee rate and the Indian range", async () => {
    const w = await wallet(someone());
    expect(w.razorpay_key_id).toBe(KEY_ID);
    expect(w).toMatchObject({
      inr_per_usd: RATE,
      card_min_inr: SHIPPED.card_min_inr,
      card_max_inr: SHIPPED.card_max_inr,
      card_presets_inr: SHIPPED.card_presets_inr,
      card_default_inr: SHIPPED.card_default_inr,
    });
  });

  it("orders rupees of credit plus the service fee, the key getting the credit's dollar worth", async () => {
    const o = await json<OrderView>(order(someone(), 500));
    const fee = Math.ceil((50_000 * SHIPPED.wallet_fee_bps) / 10_000);
    expect(o).toMatchObject({ key_id: KEY_ID, currency: "INR", credit_inr: 500, fee_inr: fee / 100 });
    expect(o.amount).toBe(50_000 + fee);
    expect(o.total_inr).toBe((50_000 + fee) / 100);
    // Rounded down to the cent: the deployment is never short.
    expect(o.amount_usd).toBe(Math.floor(50_000 / RATE) / 100);
    expect(o.order_id).toMatch(/^order_/);
  });

  it("keeps to the Indian range, in whole rupees", async () => {
    const { card_min_inr: min, card_max_inr: max } = SHIPPED;
    expect((await order(someone(), min - 1)).status).toBe(400);
    expect((await order(someone(), max + 1)).status).toBe(400);
    expect((await order(someone(), 500.5)).status).toBe(400);
    expect((await order(someone(), min)).status).toBe(200);
    expect((await order(someone(), max)).status).toBe(200);
  });

  it("makes a key held to the credit once Razorpay says the order is paid", async () => {
    const owner = someone("owner");
    const o = await json<OrderView>(order(owner, 500));
    const paid = await json<{ status: string; key_id: string }>(confirm(owner, o.id, await pay(o.order_id)));
    expect(paid.status).toBe("paid");
    const [key] = (await wallet(owner)).keys;
    expect(key).toMatchObject({ id: paid.key_id, kind: "provisioned" });
    const made = Object.values(await madeKeys()).find((k) => k.name.includes(o.id));
    expect(made?.limit).toBe(o.amount_usd);
  });

  it("captures a payment that was only authorized", async () => {
    const owner = someone("owner");
    const o = await json<OrderView>(order(owner, 450));
    const res = await confirm(owner, o.id, await pay(o.order_id, { status: "authorized" }));
    expect(await json(res)).toMatchObject({ status: "paid" });
  });

  it("refuses a payment for another order, a short one, and a failed one", async () => {
    const owner = someone("owner");
    const o = await json<OrderView>(order(owner, 500));
    const other = await json<OrderView>(order(owner, 500));
    expect((await confirm(owner, o.id, await pay(other.order_id))).status).toBe(400);
    expect((await confirm(owner, o.id, await pay(o.order_id, { amount: 100 }))).status).toBe(400);
    expect((await confirm(owner, o.id, await pay(o.order_id, { status: "failed" }))).status).toBe(400);
    expect((await wallet(owner)).keys).toHaveLength(0);
  });

  it("keeps each buyer's orders to themselves", async () => {
    const o = await json<OrderView>(order(someone("owner"), 500));
    expect((await confirm(someone("stranger"), o.id, await pay(o.order_id))).status).toBe(404);
  });

  it("makes one key however many confirms arrive at once", async () => {
    const owner = someone("owner");
    const o = await json<OrderView>(order(owner, 500));
    const payment = await pay(o.order_id);
    await Promise.all([confirm(owner, o.id, payment), confirm(owner, o.id, payment), confirm(owner, o.id, payment)]);
    await confirm(owner, o.id, payment);
    expect((await wallet(owner)).keys).toHaveLength(1);
  });

  it("closes while Razorpay's keys or the provisioning key are missing", async () => {
    await directory().setRazorpayKeys({ key_secret: "" });
    expect((await wallet(someone())).razorpay_key_id).toBe("");
    expect((await order(someone(), 500)).status).toBe(503);
    await openCards();
    await directory().setProvisioningKey("");
    expect((await order(someone(), 500)).status).toBe(503);
  });
});

describe("Razorpay's webhook", () => {
  beforeEach(openCards);

  it("delivers the key for a page that closed before it could confirm, once", async () => {
    const owner = someone("owner");
    const o = await json<OrderView>(order(owner, 500));
    const payment = await pay(o.order_id);
    expect(await json(webhook(captured(payment, o.order_id)))).toEqual({ delivered: true });
    expect(await json(webhook(captured(payment, o.order_id)))).toEqual({ delivered: true });
    expect((await wallet(owner)).keys).toHaveLength(1);
    // The page coming back later finds it already delivered.
    expect(await json(confirm(owner, o.id, payment))).toMatchObject({ status: "paid" });
    expect((await wallet(owner)).keys).toHaveLength(1);
  });

  it("refuses a body not signed with the webhook secret", async () => {
    const o = await json<OrderView>(order(someone(), 500));
    const res = await webhook(captured(await pay(o.order_id), o.order_id), "not-the-secret");
    expect(res.status).toBe(400);
  });

  it("ignores orders that aren't a key purchase", async () => {
    const payment = "pay_NotOursAtAll01";
    expect(await json(webhook(captured(payment, "order_SomeoneElse01")))).toEqual({ ignored: true });
  });
});

describe("Razorpay's keys", () => {
  it("are the owner's to set, checked with Razorpay, the secrets never read back", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/razorpay`)).status).toBe(401);
    const bad = await admin({ method: "PATCH", body: JSON.stringify({ key_id: KEY_ID, key_secret: "wrong" }) });
    expect(bad.status).toBe(400);
    expect((await admin({ method: "PATCH", body: JSON.stringify({ key_id: "nope" }) })).status).toBe(400);

    const set = await admin({
      method: "PATCH",
      body: JSON.stringify({ key_id: KEY_ID, key_secret: RAZORPAY_SECRET, webhook_secret: WEBHOOK_SECRET }),
    });
    const shown = await json<Record<string, unknown>>(set);
    expect(shown).toEqual({
      key_id: KEY_ID,
      key_secret: { set: true, hint: RAZORPAY_SECRET.slice(-4) },
      webhook_secret: { set: true, hint: WEBHOOK_SECRET.slice(-4) },
    });
    expect(JSON.stringify(await json(admin()))).not.toContain(RAZORPAY_SECRET);

    await admin({ method: "PATCH", body: JSON.stringify({ key_secret: "" }) });
    expect(await json(admin())).toMatchObject({ key_secret: { set: false, hint: "" } });
  });
});
