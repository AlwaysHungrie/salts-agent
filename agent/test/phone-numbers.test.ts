import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { signedIn } from "./clerk";
import { INR_PER_USD, PROVISIONING_KEY, RAZORPAY_SECRET, TWILIO_SECRET } from "./openrouter-mock";
import { SHIPPED } from "./shipped";

/**
 * Business Phone Numbers: each account's numbers for WhatsApp for Business. A number
 * the user already owns is added by typing it; WhatsApp registers a number once, so no
 * two accounts may hold the same one.
 */

const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

/** A number no other test uses, since numbers are unique across accounts. */
const freshNumber = () => `1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: { "content-type": "application/json", ...signedIn(email) },
  };
}

type NumberView = { id: string; number: string; kind: string; created_at: number; expires_at: number };

function add(email: string, number: string) {
  return SELF.fetch(
    `${BASE}/api/phone-numbers`,
    as(email, { method: "POST", body: JSON.stringify({ number }) })
  );
}

async function list(email: string) {
  const res = await SELF.fetch(`${BASE}/api/phone-numbers`, as(email));
  return (await res.json()) as { numbers: NumberView[]; max: number };
}

describe("business phone numbers", () => {
  it("refuses a caller who is not signed in", async () => {
    const res = await SELF.fetch(`${BASE}/api/phone-numbers`);
    expect(res.status).toBe(401);
  });

  it("adds a number, stored as digits only, and lists it", async () => {
    const owner = someone();
    const digits = freshNumber();
    const res = await add(owner, `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`);
    expect(res.status).toBe(201);
    const added = (await res.json()) as NumberView;
    expect(added).toMatchObject({ number: digits, kind: "own" });

    const wallet = await list(owner);
    expect(wallet.max).toBe(SHIPPED.max_phone_numbers);
    expect(wallet.numbers.map((n) => n.number)).toEqual([digits]);
  });

  it("refuses something that is not a full international number", async () => {
    const owner = someone();
    for (const bad of ["", "12345", "0044123456789", "+1 415 555 01a3", "1234567890123456"]) {
      const res = await add(owner, bad);
      expect(res.status, bad).toBe(400);
    }
    expect((await list(owner)).numbers).toEqual([]);
  });

  it("holds a number once, across every account", async () => {
    const owner = someone();
    const number = freshNumber();
    expect((await add(owner, number)).status).toBe(201);

    const again = await add(owner, number);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toMatch(/already in your wallet/);

    const other = await add(someone("other"), `+${number}`);
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toMatch(/already in use/);
  });

  it("stops at the deployment's limit", async () => {
    const owner = someone();
    for (let i = 0; i < SHIPPED.max_phone_numbers; i++) {
      expect((await add(owner, freshNumber())).status).toBe(201);
    }
    const res = await add(owner, freshNumber());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/at most/);
  });

  it("removes only the caller's own number", async () => {
    const owner = someone();
    const added = (await (await add(owner, freshNumber())).json()) as NumberView;

    const stranger = await SELF.fetch(
      `${BASE}/api/phone-numbers/${added.id}`,
      as(someone("stranger"), { method: "DELETE" })
    );
    expect(stranger.status).toBe(404);
    expect((await list(owner)).numbers).toHaveLength(1);

    const res = await SELF.fetch(`${BASE}/api/phone-numbers/${added.id}`, as(owner, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await list(owner)).numbers).toEqual([]);
  });

  it("frees a removed number for another account", async () => {
    const owner = someone();
    const number = freshNumber();
    const added = (await (await add(owner, number)).json()) as NumberView;
    await SELF.fetch(`${BASE}/api/phone-numbers/${added.id}`, as(owner, { method: "DELETE" }));
    expect((await add(someone("next"), number)).status).toBe(201);
  });
});

/* ------------------------------------------------------------ buying a number -- */

const KEY_ID = "rzp_test_SaltsNumbers1";
const WEBHOOK_SECRET = "whsec-salts-numbers";
const TWILIO = {
  account_sid: `AC${"a".repeat(32)}`,
  api_key_sid: `SK${"b".repeat(32)}`,
  api_key_secret: TWILIO_SECRET,
};

const directory = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));

async function openBuying() {
  const dir = directory();
  await dir.setProvisioningKey(PROVISIONING_KEY);
  await dir.setRazorpayKeys({ key_id: KEY_ID, key_secret: RAZORPAY_SECRET, webhook_secret: WEBHOOK_SECRET });
  await dir.setTwilioKeys(TWILIO);
}

type Order = { id: string; order_id: string; amount: number; currency: string; total: number; renew: boolean };

async function order(email: string, body: { currency?: string; renew?: string; messages?: number } = {}) {
  return SELF.fetch(`${BASE}/api/phone-numbers/orders`, as(email, { method: "POST", body: JSON.stringify(body) }));
}

async function pay(order_id: string) {
  const res = await fetch("https://api.razorpay.com/__pay", {
    method: "POST",
    body: JSON.stringify({ order_id }),
  });
  return ((await res.json()) as { id: string }).id;
}

function confirm(email: string, id: string, payment_id: string) {
  return SELF.fetch(
    `${BASE}/api/phone-numbers/orders/${id}/confirm`,
    as(email, { method: "POST", body: JSON.stringify({ payment_id }) })
  );
}

/** Order, pay and confirm a new number; the confirm's answer. */
async function buy(email: string, body: { currency?: string; renew?: string; messages?: number } = {}) {
  const made = (await (await order(email, body)).json()) as Order;
  return (await (await confirm(email, made.id, await pay(made.order_id))).json()) as {
    status: string;
    number_id: string;
  };
}

async function released() {
  return (await (await fetch("https://api.twilio.com/__released")).json()) as string[];
}

/** `ts` plus whole calendar months, in UTC, as the Worker counts a term. */
const monthsAfter = (ts: number, months: number) => {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
};

describe("buying a US number", () => {
  beforeEach(openBuying);

  it("offers the deployment's price and term, priced in rupees at today's rate too", async () => {
    const wallet = (await (await SELF.fetch(`${BASE}/api/phone-numbers`, as(someone()))).json()) as Record<
      string,
      unknown
    >;
    expect(wallet).toMatchObject({
      price_usd: SHIPPED.phone_number_price_usd,
      term_months: SHIPPED.phone_number_term_months,
      razorpay_key_id: KEY_ID,
      price_inr: Math.ceil(SHIPPED.phone_number_price_usd * INR_PER_USD),
    });
  });

  it("charges the price in dollars, or in whole rupees rounded up", async () => {
    const usd = (await (await order(someone())).json()) as Order;
    expect(usd).toMatchObject({ currency: "USD", amount: SHIPPED.phone_number_price_usd * 100 });
    const inr = (await (await order(someone(), { currency: "INR" })).json()) as Order;
    expect(inr).toMatchObject({
      currency: "INR",
      amount: Math.ceil(SHIPPED.phone_number_price_usd * INR_PER_USD) * 100,
    });
  });

  it("buys a US number once paid, kept for one term", async () => {
    const buyer = someone();
    const before = Date.now();
    const paid = await buy(buyer);
    expect(paid.status).toBe("paid");
    const [number] = (await list(buyer)).numbers;
    expect(number).toMatchObject({ id: paid.number_id, kind: "bought" });
    expect(number.number).toMatch(/^1\d{10}$/);
    expect(number.expires_at).toBeGreaterThanOrEqual(monthsAfter(before, SHIPPED.phone_number_term_months));
    expect(number.expires_at).toBeLessThanOrEqual(monthsAfter(Date.now(), SHIPPED.phone_number_term_months));
  });

  it("buys one number however many times the payment is confirmed", async () => {
    const buyer = someone();
    const made = (await (await order(buyer)).json()) as Order;
    const payment = await pay(made.order_id);
    const first = (await (await confirm(buyer, made.id, payment)).json()) as { number_id: string };
    const again = (await (await confirm(buyer, made.id, payment)).json()) as { number_id: string };
    expect(again.number_id).toBe(first.number_id);
    expect((await list(buyer)).numbers).toHaveLength(1);
  });

  it("renews a bought number by one more term from when it would have ended", async () => {
    const buyer = someone();
    const { number_id } = await buy(buyer);
    const ends = (await list(buyer)).numbers[0].expires_at;
    const renewed = await buy(buyer, { renew: number_id });
    expect(renewed).toMatchObject({ status: "paid", number_id });
    const [number] = (await list(buyer)).numbers;
    expect(number.expires_at).toBe(monthsAfter(ends, SHIPPED.phone_number_term_months));
  });

  it("delivers the number from Razorpay's webhook when the page was closed first", async () => {
    const buyer = someone();
    const made = (await (await order(buyer)).json()) as Order;
    const payment = await pay(made.order_id);
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: payment, order_id: made.order_id } } },
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const res = await SELF.fetch(`${BASE}/razorpay/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": [...sig].map((b) => b.toString(16).padStart(2, "0")).join(""),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect((await list(buyer)).numbers).toMatchObject([{ kind: "bought" }]);
  });

  it("won't renew a number the caller didn't buy", async () => {
    const own = (await (await add(someone(), freshNumber())).json()) as NumberView;
    expect((await order(someone("other"), { renew: own.id })).status).toBe(404);
  });

  it("refuses an order for a new number once the wallet is full", async () => {
    const buyer = someone();
    for (let i = 0; i < SHIPPED.max_phone_numbers; i++) await add(buyer, freshNumber());
    expect((await order(buyer)).status).toBe(400);
  });

  it("releases a bought number at Twilio when it is removed", async () => {
    const buyer = someone();
    const { number_id } = await buy(buyer);
    const count = (await released()).length;
    const res = await SELF.fetch(`${BASE}/api/phone-numbers/${number_id}`, as(buyer, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await released()).length).toBe(count + 1);
    expect((await list(buyer)).numbers).toEqual([]);
  });

  it("releases a number at Twilio once its term has run out", async () => {
    const buyer = someone();
    const { number_id } = await buy(buyer);
    const count = (await released()).length;
    await runInDurableObject(directory(), async (instance, ctx) => {
      ctx.storage.sql.exec(`UPDATE phone_numbers SET expires_at = 1 WHERE id = ?`, number_id);
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });
    expect((await released()).length).toBe(count + 1);
    expect((await list(buyer)).numbers).toEqual([]);
  });

  it("is closed while Twilio isn't set", async () => {
    await directory().setTwilioKeys({ api_key_secret: "" });
    try {
      const wallet = (await (await SELF.fetch(`${BASE}/api/phone-numbers`, as(someone()))).json()) as {
        razorpay_key_id: string;
      };
      expect(wallet.razorpay_key_id).toBe("");
      expect((await order(someone())).status).toBe(503);
    } finally {
      await openBuying();
    }
  });
});

describe("the owner's Twilio settings", () => {
  const admin = (body?: unknown) =>
    SELF.fetch(`${BASE}/api/admin/twilio`, {
      method: body ? "PATCH" : "GET",
      headers: { "content-type": "application/json", "x-api-secret": "test-secret" },
      body: body ? JSON.stringify(body) : undefined,
    });

  beforeEach(openBuying);

  it("shows the SIDs and only the last four characters of the secret", async () => {
    const view = (await (await admin()).json()) as Record<string, unknown>;
    expect(view).toEqual({
      account_sid: TWILIO.account_sid,
      api_key_sid: TWILIO.api_key_sid,
      api_key_secret: { set: true, hint: TWILIO_SECRET.slice(-4) },
    });
  });

  it("refuses a malformed SID, and a secret Twilio doesn't accept", async () => {
    expect((await admin({ account_sid: "AC123" })).status).toBe(400);
    expect((await admin({ api_key_sid: "not-a-key" })).status).toBe(400);
    expect((await admin({ api_key_secret: "wrong" })).status).toBe(400);
  });

  it("takes the account SID in place of an API key, with the auth token as its secret", async () => {
    const res = await admin({ api_key_sid: TWILIO.account_sid });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { api_key_sid: string }).api_key_sid).toBe(TWILIO.account_sid);
  });

  it("is shut to anyone without the API secret", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/twilio`)).status).toBe(401);
  });
});

/* ---------------------------------------------------- a number for an agent -- */

type WalletNumber = NumberView & { agent_id: string; agent_name: string };
type BusinessNumber = { id: string; number: string } | null;

async function newAgent(owner: string, name = "Shop") {
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(owner, { method: "POST", body: JSON.stringify({ name, allowed_emails: owner }) })
  );
  expect(res.ok).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

function assign(email: string, agentId: string, numberId: string) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}/business-number`,
    as(email, { method: "PUT", body: JSON.stringify({ number_id: numberId }) })
  );
}

async function agentNumber(email: string, agentId: string) {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/config`, as(email));
  return ((await res.json()) as { business_number: BusinessNumber }).business_number;
}

async function walletNumbers(email: string) {
  return (await list(email)).numbers as WalletNumber[];
}

describe("a business number for an agent", () => {
  it("gives an agent a number from the caller's wallet, shown on both sides", async () => {
    const owner = someone("owner");
    const agent = await newAgent(owner, "Bakery");
    const n = (await (await add(owner, freshNumber())).json()) as NumberView;

    const res = await assign(owner, agent, n.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { business_number: BusinessNumber }).business_number).toEqual({
      id: n.id,
      number: n.number,
    });
    expect(await agentNumber(owner, agent)).toEqual({ id: n.id, number: n.number });
    expect(await walletNumbers(owner)).toMatchObject([
      { id: n.id, agent_id: agent, agent_name: "Bakery" },
    ]);
  });

  it("lets a number answer for one agent only", async () => {
    const owner = someone("owner");
    const first = await newAgent(owner);
    const second = await newAgent(owner);
    const n = (await (await add(owner, freshNumber())).json()) as NumberView;
    expect((await assign(owner, first, n.id)).status).toBe(200);

    const res = await assign(owner, second, n.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/another agent/);
    expect(await agentNumber(owner, second)).toBeNull();
    expect(await agentNumber(owner, first)).toMatchObject({ id: n.id });

    // Picking the same number again for its own agent is fine.
    expect((await assign(owner, first, n.id)).status).toBe(200);
  });

  it("swaps an agent's number, freeing the old one, and blank takes it off", async () => {
    const owner = someone("owner");
    const agent = await newAgent(owner);
    const a = (await (await add(owner, freshNumber())).json()) as NumberView;
    const b = (await (await add(owner, freshNumber())).json()) as NumberView;
    await assign(owner, agent, a.id);
    expect((await assign(owner, agent, b.id)).status).toBe(200);

    const held = await walletNumbers(owner);
    expect(held.find((n) => n.id === a.id)?.agent_id).toBe("");
    expect(held.find((n) => n.id === b.id)?.agent_id).toBe(agent);

    expect((await assign(owner, agent, "")).status).toBe(200);
    expect(await agentNumber(owner, agent)).toBeNull();
    expect((await walletNumbers(owner)).every((n) => n.agent_id === "")).toBe(true);
  });

  it("refuses a number from someone else's wallet, and a stranger's agent", async () => {
    const owner = someone("owner");
    const other = someone("other");
    const agent = await newAgent(owner);
    const theirs = (await (await add(other, freshNumber())).json()) as NumberView;
    const res = await assign(owner, agent, theirs.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not in your/);

    const otherAgent = await newAgent(other);
    expect((await assign(owner, otherAgent, "")).status).toBe(404);
  });

  it("frees the agent when its number is removed, and the number when the agent is", async () => {
    const owner = someone("owner");
    const agent = await newAgent(owner);
    const n = (await (await add(owner, freshNumber())).json()) as NumberView;
    await assign(owner, agent, n.id);
    await SELF.fetch(`${BASE}/api/phone-numbers/${n.id}`, as(owner, { method: "DELETE" }));
    expect(await agentNumber(owner, agent)).toBeNull();

    const m = (await (await add(owner, freshNumber())).json()) as NumberView;
    await assign(owner, agent, m.id);
    const gone = await SELF.fetch(`${BASE}/api/agents/${agent}`, as(owner, { method: "DELETE" }));
    expect(gone.status).toBe(200);
    expect((await walletNumbers(owner))[0]).toMatchObject({ id: m.id, agent_id: "" });
  });
});

/* ------------------------------------------------------------- message packs -- */

describe("WhatsApp for Business message packs", () => {
  beforeEach(openBuying);

  const balance = async (email: string) =>
    ((await (await SELF.fetch(`${BASE}/api/phone-numbers`, as(email))).json()) as { messages_remaining: number })
      .messages_remaining;

  it("offers the deployment's packs, in rupees at today's rate too, and starts at zero", async () => {
    const buyer = someone();
    const wallet = (await (await SELF.fetch(`${BASE}/api/phone-numbers`, as(buyer))).json()) as Record<
      string,
      unknown
    >;
    expect(wallet.messages_remaining).toBe(0);
    expect(wallet.message_packs).toEqual(
      SHIPPED.message_packs.map((p) => ({ ...p, price_inr: Math.ceil(p.price_usd * INR_PER_USD) }))
    );
  });

  it("charges a pack's price and adds its messages once paid, however often confirmed", async () => {
    const buyer = someone();
    const [pack] = SHIPPED.message_packs;
    const made = (await (await order(buyer, { messages: pack.messages })).json()) as Order;
    expect(made).toMatchObject({ currency: "USD", amount: pack.price_usd * 100 });
    const payment = await pay(made.order_id);
    const first = await confirm(buyer, made.id, payment);
    expect(await first.json()).toEqual({ status: "paid", messages_remaining: pack.messages });
    await confirm(buyer, made.id, payment);
    expect(await balance(buyer)).toBe(pack.messages);
  });

  it("adds a second pack on top of what is left, in rupees too", async () => {
    const buyer = someone();
    const [small, big] = SHIPPED.message_packs;
    await buy(buyer, { messages: small.messages });
    const made = (await (await order(buyer, { messages: big.messages, currency: "INR" })).json()) as Order;
    expect(made.amount).toBe(Math.ceil(big.price_usd * INR_PER_USD) * 100);
    await confirm(buyer, made.id, await pay(made.order_id));
    expect(await balance(buyer)).toBe(small.messages + big.messages);
  });

  it("refuses a pack that isn't on sale", async () => {
    expect((await order(someone(), { messages: 7 })).status).toBe(400);
  });

  it("takes one message per reply and refuses once none are left", async () => {
    const buyer = someone();
    const dir = directory();
    expect(await dir.spendMessage(buyer)).toBe(false);
    await runInDurableObject(dir, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO message_balances (email, messages) VALUES (?, 2)`, buyer);
    });
    expect(await dir.spendMessage(buyer)).toBe(true);
    expect(await dir.spendMessage(buyer)).toBe(true);
    expect(await dir.spendMessage(buyer)).toBe(false);
    expect(await balance(buyer)).toBe(0);
  });
});

/* ------------------------------------------- connecting WhatsApp for Business -- */

type WaView = {
  number: { id: string; number: string; kind: string } | null;
  stage: string;
  status: string;
  code: string;
  owner: boolean;
  signup: { app_id: string; config_id: string; solution_id: string };
};

const SIGNUP = { app_id: "1234567890", config_id: "2345678901", solution_id: "3456789012" };

function wa(email: string, agentId: string, step = "", body?: unknown) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}/whatsapp-business${step ? `/${step}` : ""}`,
    as(email, step ? { method: "POST", body: JSON.stringify(body ?? {}) } : {})
  );
}

async function twilioState<T>(kind: "numbers" | "senders", sid: string, status?: string) {
  const res = await fetch(`https://api.twilio.com/__${kind}/${sid}`, {
    method: status ? "POST" : "GET",
    body: status ? JSON.stringify({ status }) : undefined,
  });
  return (await res.json()) as T;
}

async function numberRow(id: string) {
  return (await directory().phoneNumber(id))!;
}

/** Twilio's X-Twilio-Signature for a form post of `params` to `url`. */
async function twilioSign(token: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

function text(numberId: string, params: Record<string, string>, signature: string) {
  return SELF.fetch(`${BASE}/twilio/sms/${numberId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params).toString(),
  });
}

/** An agent with a freshly bought number on it. */
async function agentWithBoughtNumber(owner: string, allowed = owner) {
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(owner, { method: "POST", body: JSON.stringify({ name: "Bakery", allowed_emails: allowed }) })
  );
  const agent = ((await res.json()) as { id: string }).id;
  const { number_id } = await buy(owner);
  expect((await assign(owner, agent, number_id)).status).toBe(200);
  return { agent, numberId: number_id };
}

describe("connecting an agent's number to WhatsApp for Business", () => {
  beforeEach(async () => {
    await openBuying();
    await directory().setWhatsappSignup(SIGNUP);
  });

  it("shows no number until one is chosen, with the deployment's signup ids", async () => {
    const owner = someone();
    const agent = await newAgent(owner);
    const view = (await (await wa(owner, agent)).json()) as WaView;
    expect(view).toEqual({ number: null, stage: "", status: "", code: "", owner: false, signup: SIGNUP });
    expect((await wa(owner, agent, "prepare")).status).toBe(400);
  });

  it("moves a bought number into its business's own Twilio account, once", async () => {
    const owner = someone();
    const { agent, numberId } = await agentWithBoughtNumber(owner);
    const res = await wa(owner, agent, "prepare");
    expect(res.status).toBe(200);
    expect(((await res.json()) as WaView).stage).toBe("ready");

    const row = await numberRow(numberId);
    expect(row.wa_account_sid).toMatch(/^AC/);
    expect(await twilioState("numbers", row.twilio_sid)).toMatchObject({
      account: row.wa_account_sid,
      sms_url: `${BASE}/twilio/sms/${numberId}`,
    });

    // Again: nothing new is opened.
    expect((await wa(owner, agent, "prepare")).status).toBe(200);
    expect((await numberRow(numberId)).wa_account_sid).toBe(row.wa_account_sid);
  });

  it("opens an account for the user's own number, without moving anything", async () => {
    const owner = someone();
    const agent = await newAgent(owner);
    const n = (await (await add(owner, freshNumber())).json()) as NumberView;
    await assign(owner, agent, n.id);
    const view = (await (await wa(owner, agent, "prepare")).json()) as WaView;
    expect(view).toMatchObject({ stage: "account", owner: true, number: { id: n.id, kind: "own" } });
  });

  it("shows the code Meta texts a bought number, only when Twilio signed the text", async () => {
    const owner = someone();
    const { agent, numberId } = await agentWithBoughtNumber(owner);
    await wa(owner, agent, "prepare");
    const { wa_account_token } = await numberRow(numberId);
    const url = `${BASE}/twilio/sms/${numberId}`;
    const params = { From: "+15550001111", Body: "<#> 482-913 is your WhatsApp Business code" };

    expect((await text(numberId, params, await twilioSign("wrong", url, params))).status).toBe(403);
    expect(((await (await wa(owner, agent)).json()) as WaView).code).toBe("");

    expect((await text(numberId, params, await twilioSign(wa_account_token, url, params))).status).toBe(200);
    expect(((await (await wa(owner, agent)).json()) as WaView).code).toBe("482913");
  });

  it("registers the number as a sender in the business's WABA, and follows its status", async () => {
    const owner = someone();
    const { agent, numberId } = await agentWithBoughtNumber(owner);
    const body = { waba_id: "998877665544", display_name: "Bakery on Main" };
    expect((await wa(owner, agent, "connect", body)).status).toBe(400);

    await wa(owner, agent, "prepare");
    expect((await wa(owner, agent, "connect", { ...body, waba_id: "abc" })).status).toBe(400);
    const res = await wa(owner, agent, "connect", body);
    expect(res.status).toBe(200);
    expect((await res.json()) as WaView).toMatchObject({ stage: "sender", status: "CREATING" });

    const row = await numberRow(numberId);
    expect(row.waba_id).toBe(body.waba_id);
    expect(await twilioState("senders", row.wa_sender_sid)).toMatchObject({
      account: row.wa_account_sid,
      body: {
        sender_id: `whatsapp:+${row.number}`,
        configuration: { waba_id: body.waba_id },
        profile: { name: body.display_name },
      },
    });

    await twilioState("senders", row.wa_sender_sid, "ONLINE");
    expect(((await (await wa(owner, agent)).json()) as WaView).status).toBe("ONLINE");
    expect((await wa(owner, agent, "connect", body)).status).toBe(409);
  });

  it("lets only the number's owner connect it", async () => {
    const owner = someone("owner");
    const member = someone("member");
    const { agent } = await agentWithBoughtNumber(owner, `${owner}\n${member}`);
    expect(((await (await wa(member, agent)).json()) as WaView).owner).toBe(false);
    expect((await wa(member, agent, "prepare")).status).toBe(403);
  });

  it("releases a moved number from its business's account", async () => {
    const owner = someone();
    const { agent, numberId } = await agentWithBoughtNumber(owner);
    await wa(owner, agent, "prepare");
    const { twilio_sid } = await numberRow(numberId);
    const res = await SELF.fetch(`${BASE}/api/phone-numbers/${numberId}`, as(owner, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await released()).toContain(twilio_sid);
  });
});

describe("the owner's Embedded Signup settings", () => {
  const admin = (body?: unknown, secret = "test-secret") =>
    SELF.fetch(`${BASE}/api/admin/whatsapp-signup`, {
      method: body ? "PATCH" : "GET",
      headers: { "content-type": "application/json", "x-api-secret": secret },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("sets and shows the three ids, digits only, blank removing one", async () => {
    expect((await admin(SIGNUP)).status).toBe(200);
    expect(await (await admin()).json()).toEqual(SIGNUP);
    expect((await admin({ config_id: "abc" })).status).toBe(400);
    expect(await (await admin({ solution_id: "" })).json()).toEqual({ ...SIGNUP, solution_id: "" });
    expect((await admin(undefined, "wrong")).status).toBe(401);
  });
});
