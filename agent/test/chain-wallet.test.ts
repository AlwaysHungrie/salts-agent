import { SELF, env } from "cloudflare:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, recoverTransactionAddress, verifyTypedData, type Hex } from "viem";
import {
  newWalletKey,
  signEvmTransaction,
  signEvmTypedData,
  signSolanaTransaction,
  walletAddresses,
} from "../src/chain-wallet";
import { balances, units, validateNetworks, type ChainNetwork } from "../src/chain-networks";
import { runTool, toolsFor, type ToolContext } from "../src/capabilities";
import { DEFAULT_CONFIG, type Config } from "../src/registry";
import { base64ToBytes, bytesToBase64, toArrayBuffer } from "../src/util/bytes";
import { registry } from "../src/worker/stores";
import { signedIn } from "./clerk";
import { SHIPPED } from "./shipped";

/**
 * The agent's wallet: one secret, two chains. What matters is that the addresses are the
 * ones the secret really controls, that what it signs verifies on each chain, and that
 * the secret itself never leaves the Worker.
 */

// Hardhat's first account: a key whose EVM address everyone knows.
const KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const solanaKey = (key: Hex) => base58.decode(walletAddresses(key).solana);
const b64 = (bytes: Uint8Array) => bytesToBase64(toArrayBuffer(bytes));
const unb64 = (text: string) => new Uint8Array(base64ToBytes(text));

/** A minimal Solana message: header, `keys`, a blockhash, no instructions. */
function solanaMessage(keys: Uint8Array[], required: number, v0 = false): Uint8Array {
  return new Uint8Array([
    ...(v0 ? [0x80] : []),
    required,
    0,
    1,
    keys.length,
    ...keys.flatMap((k) => [...k]),
    ...new Uint8Array(32).fill(7),
    0,
    ...(v0 ? [0] : []),
  ]);
}

describe("wallet keys", () => {
  it("draws a 32-byte secret", () => {
    expect(newWalletKey()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newWalletKey()).not.toBe(newWalletKey());
  });

  it("derives the EVM address the key controls", () => {
    expect(walletAddresses(KEY).evm).toBe(EVM);
  });

  it("derives the Solana address from the same secret as an ed25519 seed", () => {
    const seed = Uint8Array.from(Buffer.from(KEY.slice(2), "hex"));
    expect(solanaKey(KEY)).toEqual(ed25519.getPublicKey(seed));
  });
});

describe("EVM signing", () => {
  it("signs an EIP-1559 transaction that recovers to the wallet", async () => {
    const { raw, hash } = await signEvmTransaction(KEY, {
      chainId: 8453,
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      value: "0",
      data: "0xa9059cbb",
      nonce: 3,
      gas: "60000",
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: 1000000,
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const parsed = parseTransaction(raw);
    expect(parsed.chainId).toBe(8453);
    expect(parsed.maxFeePerGas).toBe(1_000_000_000n);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(EVM);
  });

  it("refuses a transaction with no chain id", async () => {
    await expect(signEvmTransaction(KEY, { to: EVM, value: "1" })).rejects.toThrow(/chainId/);
  });

  it("refuses an amount that is not a whole number", async () => {
    await expect(signEvmTransaction(KEY, { chainId: 1, value: "1.5" })).rejects.toThrow(/value/);
  });

  it("signs typed data that verifies against the wallet", async () => {
    const typed = {
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Mail: [{ name: "contents", type: "string" }] },
      primaryType: "Mail",
      message: { contents: "hi" },
    };
    const signature = await signEvmTypedData(KEY, typed);
    expect(await verifyTypedData({ ...typed, address: EVM, signature } as never)).toBe(true);
  });
});

describe("Solana signing", () => {
  const program = new Uint8Array(32).fill(9);

  it("signs a bare legacy message into a transaction", () => {
    const message = solanaMessage([solanaKey(KEY), program], 1);
    const signed = unb64(signSolanaTransaction(KEY, b64(message)));
    expect(signed[0]).toBe(1);
    expect(signed.subarray(65)).toEqual(message);
    expect(ed25519.verify(signed.subarray(1, 65), message, solanaKey(KEY))).toBe(true);
  });

  it("fills its own slot in a v0 transaction and keeps the other signer's", () => {
    const other = new Uint8Array(32).fill(5);
    const message = solanaMessage([other, solanaKey(KEY), program], 2, true);
    const theirs = new Uint8Array(64).fill(1);
    const tx = new Uint8Array([2, ...theirs, ...new Uint8Array(64), ...message]);
    const signed = unb64(signSolanaTransaction(KEY, b64(tx)));
    expect(signed.subarray(1, 65)).toEqual(theirs);
    expect(ed25519.verify(signed.subarray(65, 129), message, solanaKey(KEY))).toBe(true);
  });

  it("refuses a transaction this wallet does not sign", () => {
    const message = solanaMessage([new Uint8Array(32).fill(5), program], 1);
    expect(() => signSolanaTransaction(KEY, b64(message))).toThrow(/not a signer/);
  });
});

describe("the wallet capability", () => {
  const config = (patch: Partial<Config>): Config => ({
    model: "vendor/model",
    ...SHIPPED.config_defaults,
    ...DEFAULT_CONFIG,
    ...patch,
  });

  it("hands the model the signing tools only while switched on", () => {
    const names = (c: Config) => toolsFor(c).map((t) => t.name);
    expect(names(config({ cap_wallet: 0 }))).not.toContain("sign_evm_transaction");
    expect(names(config({ cap_wallet: 1 }))).toEqual(
      expect.arrayContaining([
        "wallet_address",
        "wallet_balance",
        "sign_evm_transaction",
        "sign_evm_typed_data",
        "sign_solana_transaction",
      ])
    );
  });

  it("keeps one secret per agent, drawn only when asked to", async () => {
    const reg = env.SessionRegistry.get(env.SessionRegistry.idFromName(crypto.randomUUID()));
    expect(await reg.chainWalletKey(false)).toBeUndefined();
    const key = await reg.chainWalletKey(true);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await reg.chainWalletKey(true)).toBe(key);
  });
});

describe("GET /api/agents/:id/chain-wallet", () => {
  const BASE = "https://worker.test";
  const as = (email: string, init: RequestInit = {}) => ({
    ...init,
    headers: { "content-type": "application/json", ...signedIn(email) },
  });

  async function agent() {
    const email = `wallet-${crypto.randomUUID().slice(0, 8)}@x.com`;
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, { method: "POST", body: JSON.stringify({ name: "W", allowed_emails: email }) })
    );
    return { email, id: ((await res.json()) as { id: string }).id };
  }

  it("404s while the capability is off, and draws no key", async () => {
    const { email, id } = await agent();
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/chain-wallet`, as(email));
    expect(res.status).toBe(404);
    expect(await registry(env, id).chainWalletKey(false)).toBeUndefined();
  });

  it("shows the addresses once on, and never the key", async () => {
    const { email, id } = await agent();
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(email, { method: "PATCH", body: JSON.stringify({ cap_wallet: true }) })
    );
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/chain-wallet`, as(email));
    expect(res.status).toBe(200);
    const text = await res.text();
    const key = (await registry(env, id).chainWalletKey(false))!;
    expect(JSON.parse(text)).toEqual({ ...walletAddresses(key), networks: [] });
    expect(text).not.toContain(key.slice(2));
    const config = await SELF.fetch(`${BASE}/api/agents/${id}/config`, as(email));
    expect(await config.text()).not.toContain(key.slice(2));
  });

  it("hides the addresses from a stranger", async () => {
    const { id } = await agent();
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/chain-wallet`, as("stranger@x.com"));
    expect(res.status).toBe(404);
  });
});

describe("wallet networks", () => {
  const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const devnet = {
    family: "solana",
    name: "Solana Devnet",
    rpc_url: "https://api.devnet.solana.com",
    tokens: [{ symbol: "USDC", address: USDC_DEVNET, decimals: 6 }],
  };

  afterEach(() => vi.restoreAllMocks());

  /** Answer JSON-RPC calls by method, recording each. */
  function rpcStub(answers: Record<string, unknown>) {
    const calls: { url: string; method: string; params: unknown[] }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ url: String(input), ...body });
      return Response.json({ jsonrpc: "2.0", id: 1, result: answers[body.method] });
    });
    return calls;
  }

  const tokenAccount = (mint: string, amount: string) => ({
    account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } },
  });

  it("names each network from its name and fills in the native symbol", () => {
    const [net] = validateNetworks([devnet], SHIPPED);
    expect(net.id).toBe("solana-devnet");
    expect(net.native_symbol).toBe("SOL");
    expect(net.explorer_url).toBe("");
    const [linked] = validateNetworks(
      [{ ...devnet, explorer_url: "https://explorer.solana.com/?cluster=devnet" }],
      SHIPPED
    );
    expect(linked.explorer_url).toBe("https://explorer.solana.com/?cluster=devnet");
    expect(() =>
      validateNetworks([{ ...devnet, explorer_url: "javascript:alert(1)" }], SHIPPED)
    ).toThrow(/explorer URL/);
  });

  it("refuses a token address of the other chain, plain http and too many networks", () => {
    const evm = { ...devnet, family: "evm", name: "Base" };
    expect(() => validateNetworks([evm], SHIPPED)).toThrow(/0x contract/);
    expect(() => validateNetworks([{ ...devnet, rpc_url: "http://x.io" }], SHIPPED)).toThrow(
      /https/
    );
    const many = Array.from({ length: SHIPPED.max_chain_networks + 1 }, (_, i) => ({
      ...devnet,
      name: `n${i}`,
    }));
    expect(() => validateNetworks(many, SHIPPED)).toThrow(/at most/);
  });

  it("formats base units without losing precision", () => {
    expect(units(0n, 6)).toBe("0");
    expect(units(1n, 6)).toBe("0.000001");
    expect(units(123_450_000n, 6)).toBe("123.45");
    expect(units(10n ** 30n, 18)).toBe("1000000000000");
  });

  it("sums a Solana token over every account of its mint, across both token programs", async () => {
    const [net] = validateNetworks([devnet], SHIPPED);
    const calls = rpcStub({
      getTokenAccountsByOwner: {
        value: [tokenAccount(USDC_DEVNET, "1500000"), tokenAccount("Other1111", "9")],
      },
    });
    const out = await balances(net, walletAddresses(KEY).solana, "usdc");
    expect(out.endsWith("3 USDC")).toBe(true);
    expect(calls.every((c) => c.url === devnet.rpc_url)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("explains an RPC that turns the Worker away", async () => {
    const [net] = validateNetworks([devnet], SHIPPED);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(balances(net, walletAddresses(KEY).solana)).rejects.toThrow(
      /refused the request \(403\).*provider/
    );
  });

  it("reads an EVM native coin and ERC-20 balance", async () => {
    const [net] = validateNetworks(
      [
        {
          family: "evm",
          name: "Base",
          rpc_url: "https://mainnet.base.org",
          tokens: [
            { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
          ],
        },
      ],
      SHIPPED
    );
    rpcStub({ eth_getBalance: "0x14d1120d7b160000", eth_call: "0x2625a0" });
    const out = await balances(net, EVM);
    expect(out).toContain("1.5 ETH");
    expect(out).toContain("2.5 USDC");
  });

  it("checks the agent's own address with wallet_balance, on the network named", async () => {
    const reg = env.SessionRegistry.get(env.SessionRegistry.idFromName(crypto.randomUUID()));
    const networks: ChainNetwork[] = validateNetworks([devnet], SHIPPED);
    await reg.setChainNetworks(networks);
    const calls = rpcStub({ getTokenAccountsByOwner: { value: [] } });
    const ctx = { registry: reg } as unknown as ToolContext;
    const result = await runTool(
      "wallet_balance",
      { network: "Solana devnet", token: "USDC" },
      ctx
    );
    expect(result.ok).toBe(true);
    const own = walletAddresses((await reg.chainWalletKey(false))!).solana;
    expect(result.content).toContain(`${own} on Solana Devnet`);
    expect(calls[0].params[0]).toBe(own);
    const missing = await runTool("wallet_balance", { network: "polygon" }, ctx);
    expect(missing.content).toContain("solana-devnet");
  });
});

describe("PUT /api/agents/:id/chain-wallet/networks", () => {
  const BASE = "https://worker.test";
  const as = (email: string, init: RequestInit = {}) => ({
    ...init,
    headers: { "content-type": "application/json", ...signedIn(email) },
  });

  it("saves the list and reads it back with the addresses", async () => {
    const email = `nets-${crypto.randomUUID().slice(0, 8)}@x.com`;
    const created = await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, { method: "POST", body: JSON.stringify({ name: "N", allowed_emails: email }) })
    );
    const { id } = (await created.json()) as { id: string };
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(email, { method: "PATCH", body: JSON.stringify({ cap_wallet: true }) })
    );
    const network = {
      family: "solana",
      name: "Solana Devnet",
      rpc_url: "https://api.devnet.solana.com",
      tokens: [],
    };
    const put = (body: unknown) =>
      SELF.fetch(
        `${BASE}/api/agents/${id}/chain-wallet/networks`,
        as(email, { method: "PUT", body: JSON.stringify(body) })
      );
    expect((await put({ networks: [network, network] })).status).toBe(400);
    expect((await put({ networks: [network] })).status).toBe(200);
    const read = (await (
      await SELF.fetch(`${BASE}/api/agents/${id}/chain-wallet`, as(email))
    ).json()) as { networks: ChainNetwork[] };
    expect(read.networks.map((n) => n.id)).toEqual(["solana-devnet"]);
    vi.restoreAllMocks();
  });
});
