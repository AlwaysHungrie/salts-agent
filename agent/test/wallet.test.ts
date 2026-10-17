import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SECRET_MASK } from "../src/capabilities";
import { signedIn } from "./clerk";
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

function addKey(email: string, key = "sk-or-wallet") {
  return SELF.fetch(`${BASE}/api/wallet`, as(email, { method: "POST", body: JSON.stringify({ key }) }));
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

  it("adds credits only to bought keys", async () => {
    const owner = someone("owner");
    const { id: own } = await json<KeyView>(addKey(owner));
    const credit = (keyId: string) =>
      SELF.fetch(
        `${BASE}/api/wallet/${keyId}/credits`,
        as(owner, { method: "POST", body: JSON.stringify({ ...USDC_ON_BASE, amount: 5 }) })
      );
    expect((await credit(own)).status).toBe(400);
    const bought = await directory().addWalletKey(
      owner,
      { kind: "provisioned", secret: "sk-or-provisioned" },
      20
    );
    expect((await credit((bought as { id: string }).id)).status).toBe(200);
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

describe("buying with crypto", () => {
  it("lists the networks payments are open on", async () => {
    const { networks } = await json<{ networks: { id: string; assets: string[] }[] }>(
      SELF.fetch(`${BASE}/api/wallet`, as(someone("owner")))
    );
    expect(networks.map((n) => n.id)).toEqual([
      "ethereum",
      "base",
      "arbitrum",
      "optimism",
      "polygon",
      "solana",
    ]);
    expect(networks.find((n) => n.id === "polygon")?.assets).toEqual(["usdc"]);
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
    expect(await json(confirm(owner, q.id, hash))).toEqual({ status: "paid" });
    expect(await json(confirm(owner, q.id, hash))).toEqual({ status: "paid" });

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
    expect(await json(confirm(owner, q.id, hash))).toEqual({ status: "paid" });
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
    expect(await json(confirm(owner, q.id, signature))).toEqual({ status: "paid" });
  });

  it("keeps each buyer's purchases to themselves", async () => {
    const q = await json<QuoteView>(buy(someone("owner"), { ...USDC_ON_BASE, amount: 10 }));
    expect((await confirm(someone("other"), q.id, txHash())).status).toBe(404);
  });
});
