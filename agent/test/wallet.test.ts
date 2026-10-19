import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SECRET_MASK } from "../src/capabilities";
import { signedIn } from "./clerk";
import { PROVISIONING_KEY } from "./openrouter-mock";
import { SHIPPED } from "./shipped";

/**
 * The OpenRouter wallet: each account's keys, picked by nickname wherever a key is asked
 * for. A pasted key is its owner's to see; a provisioned one is only ever spent through
 * an agent. An agent holds a copy of the key it was given, so removing a key from the
 * wallet has to reach every agent that holds it.
 */

const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedIn(email),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

type KeyView = {
  id: string;
  nickname: string;
  kind: string;
  key: string | null;
  agents: number;
  valid: boolean;
};

type ConfigView = { config: { openrouter_api_key: string; openrouter_key_id: string } };

/** The directory the routes use, for what no route may do: provision a key. */
const directory = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));

function addKey(email: string, key = "sk-or-wallet", connected?: boolean) {
  return SELF.fetch(
    `${BASE}/api/wallet`,
    as(email, { method: "POST", body: JSON.stringify({ key, connected }) })
  );
}

async function wallet(email: string) {
  return (await json<{ keys: KeyView[] }>(SELF.fetch(`${BASE}/api/wallet`, as(email)))).keys;
}

async function createAgent(owner: string, meta?: unknown) {
  return SELF.fetch(
    `${BASE}/api/agents`,
    as(owner, {
      method: "POST",
      body: JSON.stringify({ name: "Wallet", allowed_emails: owner, ...(meta ? { meta } : {}) }),
    })
  );
}

async function config(email: string, agentId: string) {
  return (await json<ConfigView>(SELF.fetch(`${BASE}/api/agents/${agentId}/config`, as(email))))
    .config;
}

function pick(email: string, agentId: string, keyId: string) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}/config`,
    as(email, { method: "PATCH", body: JSON.stringify({ openrouter_key_id: keyId }) })
  );
}

describe("OpenRouter wallet", () => {
  it("adds a pasted key and shows it to its owner only", async () => {
    const owner = someone("owner");
    const added = await json<KeyView>(addKey(owner));
    expect(added).toMatchObject({ kind: "own", key: "sk-or-wallet" });
    expect(added.nickname).toMatch(/^\w+ \w+/);

    expect(await wallet(owner)).toHaveLength(1);
    expect(await wallet(someone("other"))).toHaveLength(0);
  });

  it("refuses a key OpenRouter rejects, or none at all", async () => {
    const owner = someone("owner");
    expect((await addKey(owner, "sk-invalid")).status).toBe(400);
    expect((await addKey(owner, "  ")).status).toBe(400);
  });

  it("refuses the same key twice in one wallet", async () => {
    const owner = someone("owner");
    expect((await addKey(owner)).status).toBe(200);
    const again = await addKey(owner);
    expect(again.status).toBe(400);
    expect(await json(again)).toMatchObject({ error: "Key already imported" });
    expect(await wallet(owner)).toHaveLength(1);
    // Another wallet may still hold it.
    expect((await addKey(someone("other"))).status).toBe(200);
  });

  it("refuses a key from OpenRouter with no credit limit, but not a pasted one", async () => {
    const owner = someone("owner");
    expect((await addKey(owner, "sk-or-unlimited-1", true)).status).toBe(400);
    expect((await addKey(owner, "sk-or-limited", true)).status).toBe(200);
    expect((await addKey(owner, "sk-or-unlimited-2")).status).toBe(200);
    expect(await wallet(owner)).toHaveLength(2);
  });

  it("names every key itself, never twice in one wallet", async () => {
    const owner = someone("owner");
    for (let i = 0; i < 6; i++) {
      await directory().addWalletKey(owner, { kind: "own", secret: `sk-or-${i}` }, 20);
    }
    const names = (await wallet(owner)).map((k) => k.nickname.toLowerCase());
    expect(new Set(names).size).toBe(6);
  });

  it("never shows a provisioned key, even to its owner", async () => {
    const owner = someone("owner");
    await directory().addWalletKey(
      owner,
      { kind: "provisioned", secret: "sk-or-provisioned" },
      20
    );
    const [key] = await wallet(owner);
    expect(key).toMatchObject({ kind: "provisioned", key: null });
    expect(JSON.stringify(await wallet(owner))).not.toContain("sk-or-provisioned");
  });

  it("gives an agent a key picked by id, masked like a pasted one", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));

    expect((await pick(owner, id, keyId)).status).toBe(200);
    expect(await config(owner, id)).toMatchObject({
      openrouter_api_key: SECRET_MASK,
      openrouter_key_id: keyId,
    });
    expect((await wallet(owner))[0].agents).toBe(1);
  });

  it("refuses a key from someone else's wallet", async () => {
    const owner = someone("owner");
    const { id: theirs } = await json<KeyView>(addKey(someone("other")));
    const { id } = await json<{ id: string }>(createAgent(owner));
    expect((await pick(owner, id, theirs)).status).toBe(400);
    expect((await config(owner, id)).openrouter_api_key).toBe("");
  });

  it("creates an agent holding a wallet key named in its defaults", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const res = await createAgent(owner, { defaults: { openrouter_key_id: keyId } });
    expect(res.status).toBe(200);
    const { id } = await json<{ id: string }>(res);
    expect(await config(owner, id)).toMatchObject({
      openrouter_api_key: SECRET_MASK,
      openrouter_key_id: keyId,
    });

    const { id: theirs } = await json<KeyView>(addKey(someone("other")));
    const refused = await createAgent(owner, { defaults: { openrouter_key_id: theirs } });
    expect(refused.status).toBe(400);
  });

  it("lets anyone using the agent pick the admin's default key again", async () => {
    const owner = someone("owner");
    const member = someone("member");
    const { id: fleetKey } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(
      SELF.fetch(
        `${BASE}/api/agents`,
        as(owner, {
          method: "POST",
          body: JSON.stringify({
            name: "Fleet",
            allowed_emails: `${owner}, ${member}`,
            meta: { defaults: { openrouter_key_id: fleetKey } },
          }),
        })
      )
    );
    const view = () =>
      json<{ default_key_id: string; config: { openrouter_key_id: string } }>(
        SELF.fetch(`${BASE}/api/agents/${id}/config`, as(member))
      );
    expect((await view()).default_key_id).toBe(fleetKey);

    // Away to a key of their own, and back to the admin's: not in their wallet, but given.
    const { id: mine } = await json<KeyView>(addKey(member));
    expect((await pick(member, id, mine)).status).toBe(200);
    expect((await pick(member, id, fleetKey)).status).toBe(200);
    expect((await view()).config.openrouter_key_id).toBe(fleetKey);

    // Any other key of the admin's stays theirs.
    const { id: otherOfOwner } = await json<KeyView>(addKey(owner, "sk-or-wallet-2"));
    expect((await pick(member, id, otherOfOwner)).status).toBe(400);
  });

  it("clears a pasted key's reference when a key is pasted over a wallet key", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));
    await pick(owner, id, keyId);
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(owner, { method: "PATCH", body: JSON.stringify({ openrouter_api_key: "sk-pasted" }) })
    );
    expect((await config(owner, id)).openrouter_key_id).toBe("");
  });

  it("takes a removed key away from every agent that held it", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));
    await pick(owner, id, keyId);

    expect((await SELF.fetch(`${BASE}/api/wallet/${keyId}`, as(someone("other"), { method: "DELETE" }))).status).toBe(404);
    const removed = await SELF.fetch(`${BASE}/api/wallet/${keyId}`, as(owner, { method: "DELETE" }));
    expect(await json(removed)).toEqual({ removed: keyId, agents: 1 });
    expect(await config(owner, id)).toMatchObject({ openrouter_api_key: "", openrouter_key_id: "" });
    expect(await wallet(owner)).toHaveLength(0);
  });

  it("stops at the deployment's wallet size", async () => {
    const owner = someone("owner");
    const full = await directory().addWalletKey(
      owner,
      { kind: "own", secret: "sk-or-1" },
      1
    );
    expect("error" in full).toBe(false);
    const over = await directory().addWalletKey(
      owner,
      { kind: "own", secret: "sk-or-2" },
      1
    );
    expect("error" in over).toBe(true);
  });
});

/* ---------------------------------------------------------------- payments -- */

const PAYER = "0x00000000000000000000000000000000000000b0";
const OURS = "0x00000000000000000000000000000000000000aa";
const OURS_ON_SOLANA = "Sa1tsPaymentsReceiver1111111111111111111111";

const REOWN_ID = "0123456789abcdef0123456789abcdef";

/** Open purchases: a provisioning key, addresses to be paid at, a wallet modal to pay from. */
async function openPurchases() {
  const dir = directory();
  await dir.setProvisioningKey(PROVISIONING_KEY);
  await dir.setReownProjectId(REOWN_ID);
  await dir.setPaymentAddress("evm", OURS);
  await dir.setPaymentAddress("solana", OURS_ON_SOLANA);
}
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_ON_BASE = { network: "base", asset: "usdc", payer: PAYER };

type QuoteView = {
  id: string;
  to: string;
  token: string | null;
  units: string;
  decimals: number;
  amount_usd: number;
  fee_usd: number;
  total_usd: number;
};

/** The shipped service fee on $10 of credit, in dollars. */
const FEE_ON_10 = Math.ceil(10 * SHIPPED.wallet_fee_bps / 100) / 100;

const word = (n: bigint | string) =>
  `0x${(typeof n === "string" ? n.slice(2) : n.toString(16)).padStart(64, "0")}`;
const txHash = () => `0x${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}`;

function buy(email: string, body: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/api/wallet/purchases`, as(email, { method: "POST", body: JSON.stringify(body) }));
}

function confirm(email: string, id: string, tx: string) {
  return SELF.fetch(
    `${BASE}/api/wallet/purchases/${id}/confirm`,
    as(email, { method: "POST", body: JSON.stringify({ tx }) })
  );
}

/** Put an EVM transaction on the stand-in chain. */
async function onChain(hash: string, receipt: Record<string, unknown>, tx?: Record<string, unknown>) {
  await fetch("https://rpc.test/__tx", {
    method: "POST",
    body: JSON.stringify({ hash, receipt, tx }),
  });
}

/** A mined USDC transfer of `units` from `from` to `to`, `depth` blocks deep. */
function usdcTransfer(units: bigint, from = PAYER, to = OURS, depth = 10) {
  return {
    status: "0x1",
    blockNumber: `0x${(100 - depth + 1).toString(16)}`,
    from,
    to: BASE_USDC,
    logs: [{ address: BASE_USDC, topics: [TRANSFER, word(from), word(to)], data: word(units) }],
  };
}

/** The keys OpenRouter has made for the deployment, by hash. */
async function madeKeys() {
  return await json<Record<string, { name: string; limit: number; key: string }>>(
    fetch("https://openrouter.ai/__keys")
  );
}

function admin(path: string, init: RequestInit = {}) {
  return SELF.fetch(`${BASE}/api/admin/${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-secret": "test-secret" },
  });
}

describe("buying with crypto", () => {
  // Purchases are open only while the deployment has a provisioning key to deliver with.
  beforeEach(openPurchases);

  it("lists the networks payments are open on", async () => {
    const { networks } = await json<{ networks: { id: string; assets: string[]; usdc: string }[] }>(
      SELF.fetch(`${BASE}/api/wallet`, as(someone("owner")))
    );
    expect(networks.map((n) => n.id)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "optimism",
      "polygon",
      "solana",
      "base-sepolia",
    ]);
    expect(networks.find((n) => n.id === "polygon")?.assets).toEqual(["usdc"]);
    // The USDC contract, so the page can show the buyer's balance before they pay.
    expect(networks.find((n) => n.id === "base")?.usdc).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });

  it("quotes USDC at the credit plus the service fee, plus a little dust of its own", async () => {
    const q = await json<QuoteView>(buy(someone("owner"), { ...USDC_ON_BASE, amount: 10 }));
    expect(q).toMatchObject({ to: OURS, token: BASE_USDC, decimals: 6 });
    expect(q).toMatchObject({ amount_usd: 10, fee_usd: FEE_ON_10, total_usd: 10 + FEE_ON_10 });
    const units = BigInt(q.units);
    const total = BigInt(Math.round((10 + FEE_ON_10) * 1e6));
    expect(units > total && units < total + 10_000n).toBe(true);
  });

  it("tells the wallet what fee a purchase carries", async () => {
    const wallet = await json<{ fee_bps: number }>(SELF.fetch(`${BASE}/api/wallet`, as(someone("owner"))));
    expect(wallet.fee_bps).toBe(SHIPPED.wallet_fee_bps);
  });

  it("quotes ETH from the on-chain price", async () => {
    const q = await json<QuoteView>(
      buy(someone("owner"), { network: "base", asset: "eth", payer: PAYER, amount: 10 })
    );
    // $10 and its fee at $2,000 an ETH, plus under a millionth of a gwei of dust.
    const units = BigInt(q.units);
    const wei = BigInt(Math.ceil(((10 + FEE_ON_10) / 2000) * 1e9)) * 1_000_000_000n;
    expect(units >= wei && units < wei + 1_000_000n).toBe(true);
    expect(q.token).toBeNull();
  });

  it("refuses ETH where it isn't native, no wallet, and silly amounts", async () => {
    const owner = someone("owner");
    expect((await buy(owner, { network: "polygon", asset: "eth", payer: PAYER, amount: 10 })).status).toBe(400);
    expect((await buy(owner, { network: "base", asset: "usdc", amount: 10 })).status).toBe(400);
    expect((await buy(owner, { ...USDC_ON_BASE, amount: 0.5 })).status).toBe(400);
    expect((await buy(owner, { ...USDC_ON_BASE, network: "dogechain", amount: 10 })).status).toBe(400);
  });

  it("counts a matching USDC transfer once it is deep enough, and only once", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();

    expect((await confirm(owner, q.id, hash)).status).toBe(202);
    await onChain(hash, usdcTransfer(BigInt(q.units), PAYER, OURS, 1));
    expect((await confirm(owner, q.id, hash)).status).toBe(202);

    await onChain(hash, usdcTransfer(BigInt(q.units)));
    const first = await json<{ status: string; key_id: string }>(confirm(owner, q.id, hash));
    expect(first.status).toBe("paid");
    expect(await json(confirm(owner, q.id, hash))).toEqual(first);

    const other = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    expect((await confirm(owner, other.id, hash)).status).toBe(409);
  });

  it("refuses a short payment, someone else's, and one to another address", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const short = txHash();
    await onChain(short, usdcTransfer(BigInt(q.units) - 1n));
    expect((await confirm(owner, q.id, short)).status).toBe(400);

    const stranger = txHash();
    const from = "0x00000000000000000000000000000000000000c0";
    await onChain(stranger, usdcTransfer(BigInt(q.units), from));
    expect((await confirm(owner, q.id, stranger)).status).toBe(400);

    const elsewhere = txHash();
    await onChain(elsewhere, usdcTransfer(BigInt(q.units), PAYER, "0x00000000000000000000000000000000000000dd"));
    expect((await confirm(owner, q.id, elsewhere)).status).toBe(400);
  });

  it("counts an ETH payment by its value", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(
      buy(owner, { network: "base", asset: "eth", payer: PAYER, amount: 10 })
    );
    const hash = txHash();
    await onChain(
      hash,
      { status: "0x1", blockNumber: "0x10", from: PAYER, to: OURS, logs: [] },
      { to: OURS, value: `0x${BigInt(q.units).toString(16)}` }
    );
    expect(await json(confirm(owner, q.id, hash))).toMatchObject({ status: "paid" });
  });

  it("counts a finalized Solana USDC transfer", async () => {
    const owner = someone("owner");
    const payer = "BuyerWa11et1111111111111111111111111111111";
    const q = await json<QuoteView>(
      buy(owner, { network: "solana", asset: "usdc", payer, amount: 10 })
    );
    const signature = "5".repeat(88);
    await fetch("https://rpc.test/__tx", {
      method: "POST",
      body: JSON.stringify({
        hash: signature,
        solana: {
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            preTokenBalances: [
              { accountIndex: 2, mint: q.token, owner: q.to, uiTokenAmount: { amount: "5" } },
            ],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: q.token,
                owner: q.to,
                uiTokenAmount: { amount: String(BigInt(q.units) + 5n) },
              },
            ],
          },
          transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } },
        },
      }),
    });
    expect(await json(confirm(owner, q.id, signature))).toMatchObject({ status: "paid" });
  });

  it("keeps each buyer's purchases to themselves", async () => {
    const q = await json<QuoteView>(buy(someone("owner"), { ...USDC_ON_BASE, amount: 10 }));
    expect((await confirm(someone("other"), q.id, txHash())).status).toBe(404);
  });

  it("caps one purchase at the deployment's ceiling", async () => {
    const owner = someone("owner");
    const max = SHIPPED.max_wallet_purchase_usd;
    expect((await buy(owner, { ...USDC_ON_BASE, amount: max + 1 })).status).toBe(400);
    expect((await buy(owner, { ...USDC_ON_BASE, amount: max })).status).toBe(200);
    const wallet = await json<{ max_usd: number }>(SELF.fetch(`${BASE}/api/wallet`, as(owner)));
    expect(wallet.max_usd).toBe(max);
  });

  it("closes purchases while no provisioning key is set", async () => {
    const owner = someone("owner");
    await directory().setProvisioningKey("");
    const read = await json<{ networks: unknown[] }>(SELF.fetch(`${BASE}/api/wallet`, as(owner)));
    expect(read.networks).toEqual([]);
    expect((await buy(owner, { ...USDC_ON_BASE, amount: 10 })).status).toBe(503);
  });
});

/* ------------------------------------------------------- stolen payments -- */

describe("a payment is its buyer's alone", () => {
  beforeEach(openPurchases);

  it("refuses someone else's payment claimed against a quote naming their wallet", async () => {
    const victim = someone("victim");
    const theirs = await json<QuoteView>(buy(victim, { ...USDC_ON_BASE, amount: 25 }));
    const hash = txHash();
    await onChain(hash, usdcTransfer(BigInt(theirs.units)));

    // The attacker sees the transaction in the mempool and quotes as its sender.
    const thief = someone("thief");
    const mine = await json<QuoteView>(buy(thief, { ...USDC_ON_BASE, amount: 1 }));
    const stolen = await confirm(thief, mine.id, hash);
    expect(stolen.status).toBe(400);
    expect(await json(confirm(victim, theirs.id, hash))).toMatchObject({ status: "paid" });
  });

  it("refuses more than the quote asks for: the amount is what ties a payment to it", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const over = txHash();
    await onChain(over, usdcTransfer(BigInt(q.units) + 1n));
    expect((await confirm(owner, q.id, over)).status).toBe(400);
  });

  it("refuses a payment made before the quote", async () => {
    const owner = someone("owner");
    const payer = "BuyerWa11et1111111111111111111111111111111";
    const q = await json<QuoteView>(buy(owner, { network: "solana", asset: "usdc", payer, amount: 10 }));
    const signature = "6".repeat(88);
    await fetch("https://rpc.test/__tx", {
      method: "POST",
      body: JSON.stringify({
        hash: signature,
        solana: {
          blockTime: Math.floor(Date.now() / 1000) - 10 * 60,
          meta: {
            err: null,
            preTokenBalances: [],
            postTokenBalances: [
              { accountIndex: 1, mint: q.token, owner: q.to, uiTokenAmount: { amount: q.units } },
            ],
          },
          transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } },
        },
      }),
    });
    const res = await confirm(owner, q.id, signature);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/before this quote/);
  });
});

/* -------------------------------------------------------------- delivery -- */

/** Quote, pay and confirm a purchase on Base; the confirm's answer. */
async function payFor(owner: string, amount: number) {
  const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount }));
  const hash = txHash();
  await onChain(hash, usdcTransfer(BigInt(q.units)));
  return { q, hash, res: await confirm(owner, q.id, hash) };
}

describe("delivering what was paid for", () => {
  beforeEach(openPurchases);

  it("makes a key held to the credit, in the buyer's wallet, never shown", async () => {
    const owner = someone("owner");
    const { q, res } = await payFor(owner, 10);
    const paid = await json<{ status: string; key_id: string }>(res);
    expect(paid.status).toBe("paid");

    const [key] = await wallet(owner);
    expect(key).toMatchObject({ id: paid.key_id, kind: "provisioned", key: null });
    const made = Object.values(await madeKeys()).find((k) => k.name.includes(q.id));
    // The credit, not the fee: the buyer paid for that, and the key spends this.
    expect(made?.limit).toBe(10);
    // Named by its buyer, so the OpenRouter dashboard says whose it is.
    expect(made?.name).toBe(`Salts ${owner} ${q.id}`);
  });

  it("makes one key however many confirms arrive at once", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();
    await onChain(hash, usdcTransfer(BigInt(q.units)));
    await Promise.all([confirm(owner, q.id, hash), confirm(owner, q.id, hash), confirm(owner, q.id, hash)]);
    await confirm(owner, q.id, hash);
    expect(await wallet(owner)).toHaveLength(1);
    expect(Object.values(await madeKeys()).filter((k) => k.name.includes(q.id))).toHaveLength(1);
  });

  it("keeps a counted payment when OpenRouter is down, and delivers it on the next confirm", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();
    await onChain(hash, usdcTransfer(BigInt(q.units)));
    await directory().setProvisioningKey("sk-or-prov-down");
    expect((await confirm(owner, q.id, hash)).status).toBe(202);
    expect(await wallet(owner)).toHaveLength(0);

    await directory().setProvisioningKey(PROVISIONING_KEY);
    expect(await json(confirm(owner, q.id, hash))).toMatchObject({ status: "paid" });
    expect(await wallet(owner)).toHaveLength(1);
  });

  it("refuses a new key into a full wallet before anything is paid", async () => {
    const owner = someone("owner");
    for (let i = 0; i < SHIPPED.max_wallet_keys; i++) {
      await directory().addWalletKey(owner, { kind: "own", secret: `sk-or-${i}` }, SHIPPED.max_wallet_keys);
    }
    expect((await buy(owner, { ...USDC_ON_BASE, amount: 10 })).status).toBe(400);
  });

  it("removes a bought key at OpenRouter too", async () => {
    const owner = someone("owner");
    const paid = await json<{ key_id: string }>((await payFor(owner, 10)).res);
    const [key] = await directory().walletKeys(owner);
    await SELF.fetch(`${BASE}/api/wallet/${paid.key_id}`, as(owner, { method: "DELETE" }));
    expect((await madeKeys())[key.openrouter_hash]).toBeUndefined();
  });
});

/* ------------------------------------------------------ provisioning key -- */

describe("the provisioning key", () => {
  it("is the owner's to set, checked with OpenRouter, and never read back", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/provisioning-key`)).status).toBe(401);
    const refused = await admin("provisioning-key", {
      method: "PUT",
      body: JSON.stringify({ key: "sk-or-v1-not-provisioning" }),
    });
    expect(refused.status).toBe(400);

    const set = await admin("provisioning-key", { method: "PUT", body: JSON.stringify({ key: PROVISIONING_KEY }) });
    expect(await json(set)).toEqual({ set: true, hint: PROVISIONING_KEY.slice(-4) });
    const read = await json<Record<string, unknown>>(admin("provisioning-key"));
    expect(JSON.stringify(read)).not.toContain(PROVISIONING_KEY);

    await admin("provisioning-key", { method: "DELETE" });
    expect(await json(admin("provisioning-key"))).toEqual({ set: false, hint: "" });
  });
});

/* ----------------------------------------------------- payment addresses -- */

describe("recovering a payment the page lost", () => {
  beforeEach(openPurchases);

  function recover(email: string, body: Record<string, unknown>) {
    return SELF.fetch(
      `${BASE}/api/wallet/purchases/recover`,
      as(email, { method: "POST", body: JSON.stringify(body) })
    );
  }

  it("matches the transaction to the buyer's unpaid purchase and delivers its key", async () => {
    const owner = someone("owner");
    const older = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 5 }));
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();
    // Pays the older quote: the newer one is checked first and does not match.
    await onChain(hash, usdcTransfer(BigInt(older.units)));

    // Only the buyer's own purchases are matched.
    expect((await recover(someone("stranger"), { network: "base", tx: hash })).status).toBe(400);

    const res = await json<{ status: string; key_id: string }>(recover(owner, { network: "base", tx: hash }));
    expect(res.status).toBe("paid");
    expect(res).not.toHaveProperty("already");
    const { keys } = await json<{ keys: { id: string; credit_usd: number | null }[] }>(
      SELF.fetch(`${BASE}/api/wallet`, as(owner))
    );
    expect(keys.map((k) => k.id)).toContain(res.key_id);

    // Asking again delivers nothing new, and says the key was already issued; the other
    // quote stays unpaid.
    expect(await json(recover(owner, { network: "base", tx: hash }))).toMatchObject({
      key_id: res.key_id,
      already: true,
    });
    expect(Object.values(await madeKeys()).filter((k) => k.name.endsWith(older.id))).toHaveLength(1);
    expect((await confirm(owner, q.id, hash)).status).toBe(409);
  });

  it("refuses a transaction that pays none of them", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();
    await onChain(hash, usdcTransfer(BigInt(q.units) + 1n));
    const res = await recover(owner, { network: "base", tx: hash });
    expect(res.status).toBe(400);
    expect((await recover(owner, { network: "nowhere", tx: hash })).status).toBe(400);
    expect((await recover(owner, { network: "base", tx: "nope" })).status).toBe(400);
  });

  it("waits while the transaction is not final", async () => {
    const owner = someone("owner");
    const q = await json<QuoteView>(buy(owner, { ...USDC_ON_BASE, amount: 10 }));
    const hash = txHash();
    await onChain(hash, usdcTransfer(BigInt(q.units), PAYER, OURS, 1));
    expect((await recover(owner, { network: "base", tx: hash })).status).toBe(202);
  });
});

describe("the payment addresses", () => {
  beforeEach(openPurchases);

  it("are the owner's to set, checked per family", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/payments`)).status).toBe(401);
    const set = (body: unknown) =>
      admin("payments", { method: "PATCH", body: JSON.stringify(body) });
    expect((await set({ evm: "not-an-address" })).status).toBe(400);
    expect((await set({ solana: OURS })).status).toBe(400);

    const evm = "0x00000000000000000000000000000000000000Ab";
    const shown = {
      evm,
      solana: OURS_ON_SOLANA,
      reown_project_id: REOWN_ID,
      rpc: expect.objectContaining({ base: "", solana: "" }),
      provisioning_key: { set: true, hint: PROVISIONING_KEY.slice(-4) },
    };
    expect(await json(set({ evm }))).toEqual(shown);
    expect(await json(admin("payments"))).toEqual(shown);
    // Quotes ask for payment at the address set, compared lowercased.
    const q = await json<QuoteView>(buy(someone("owner"), { ...USDC_ON_BASE, amount: 10 }));
    expect(q.to).toBe(evm.toLowerCase());
  });

  it("hand the browser Reown's project id, and close payments without one", async () => {
    const owner = someone("owner");
    const read = () =>
      json<{ networks: unknown[]; reown_project_id: string }>(SELF.fetch(`${BASE}/api/wallet`, as(owner)));
    expect((await read()).reown_project_id).toBe(REOWN_ID);
    const set = (reown_project_id: string) =>
      admin("payments", { method: "PATCH", body: JSON.stringify({ reown_project_id }) });
    expect((await set("not-a-project")).status).toBe(400);
    expect((await set("")).status).toBe(200);
    expect(await read()).toMatchObject({ reown_project_id: "", networks: [] });
  });

  it("take a network's RPC URL in place of the configured one, showing only its host", async () => {
    const set = (url: string, network = "solana") =>
      admin("payments", { method: "PATCH", body: JSON.stringify({ rpc: { [network]: url } }) });
    expect((await set("http://rpc.test/keyed")).status).toBe(400);
    expect((await set("not a url")).status).toBe(400);
    expect((await set("https://rpc.test/x", "nowhere")).status).toBe(400);
    expect(await json(set("https://rpc.test/refuses?api-key=s3cret"))).toMatchObject({
      rpc: { solana: "rpc.test" },
    });
    expect(JSON.stringify(await json(admin("payments")))).not.toContain("s3cret");

    // Verifying a Solana payment now asks the endpoint set, which refuses here.
    const owner = someone("owner");
    const payer = "BuyerWa11et1111111111111111111111111111111";
    const q = await json<QuoteView>(buy(owner, { network: "solana", asset: "usdc", payer, amount: 10 }));
    const res = await confirm(owner, q.id, "6".repeat(88));
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Solana didn't answer (403). Try again." });

    // Any network takes one: ETH is priced from Ethereum's.
    await set("https://rpc.test/refuses?api-key=s3cret", "ethereum");
    expect((await buy(owner, { ...USDC_ON_BASE, asset: "eth", amount: 10 })).status).toBe(502);
    await set("", "ethereum");

    // Blank goes back to the configured endpoint.
    expect(await json(set(""))).toMatchObject({ rpc: { solana: "" } });
    expect((await confirm(owner, q.id, "6".repeat(88))).status).not.toBe(502);
  });

  it("switch a family off when blank", async () => {
    await admin("payments", { method: "PATCH", body: JSON.stringify({ solana: "" }) });
    const { networks } = await json<{ networks: { id: string }[] }>(
      SELF.fetch(`${BASE}/api/wallet`, as(someone("owner")))
    );
    expect(networks.map((n) => n.id)).not.toContain("solana");
    expect(networks.map((n) => n.id)).toContain("base");
  });
});

describe("an expired quote's amount", () => {
  it("stays reserved while a payment to it could still be claimed by a later quote", async () => {
    const now = Date.now();
    const units = `${now}`;
    const at = (created_at: number, expires_at: number) =>
      directory().createPurchase({
        email: someone("buyer"),
        key_id: "",
        amount_usd: 10,
        network: "base",
        asset: "usdc",
        to_address: OURS,
        payer: PAYER,
        units,
        created_at,
        expires_at,
      });
    // The victim's quote expired a minute ago, unpaid: inside the slack, so its amount
    // can't be handed to anyone, who could otherwise claim a payment landed before expiry.
    expect("error" in (await at(now - 31 * 60_000, now - 60_000))).toBe(false);
    expect("error" in (await at(now, now + 30 * 60_000))).toBe(true);
    // Past the slack, no payment it could have taken counts for a new quote: free again.
    expect("error" in (await at(now + 2 * 60_000, now + 32 * 60_000))).toBe(false);
  });
});
