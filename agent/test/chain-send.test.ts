import { env } from "cloudflare:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { walletAddresses } from "../src/chain-wallet";
import { validateNetworks } from "../src/chain-networks";
import { associatedTokenAccount, baseUnits, transfer } from "../src/chain-send";
import { runTool, type ToolContext } from "../src/capabilities";
import { base64ToBytes } from "../src/util/bytes";
import { SHIPPED } from "./shipped";

// Hardhat's first account; its Solana address is 5kMDkdera2vkpd3XkjMd851WJ4EnE9nxGcukW2mW7AU3.
const KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EVM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TO = "GyzzvFLs4GdytV85nhMpdPr1fkih9Vk5bi5spBpfspiw";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/*
 * Reference messages from @solana/web3.js and @solana/spl-token for the same transfers
 * (SystemProgram.transfer of 0.01 SOL; createAssociatedTokenAccountIdempotent plus
 * transferChecked of 2.5 USDC). web3.js orders accounts within a role by their base58
 * text, so these are compared decoded, not byte for byte.
 */
const WEB3_NATIVE =
  "AQABA0aJlc3TwnVp4ATIkJjES/WEsaTGzYmiA/xHgl9IaElk7XlojeQcsBBhOOX4OPv7+BBw2K+JS4xkkN8DuAvdsawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMxJDpKM0uOHO7ND/JXaMxecpg9Nv0bCw26RKZ1V1Oa5AQICAAEMAgAAAICWmAAAAAAA";
const WEB3_SPL =
  "AQAFCEaJlc3TwnVp4ATIkJjES/WEsaTGzYmiA/xHgl9IaElkbQBrHndHGKMUHp3jSBHC2jiUjWSrE1HvHMKL6uNjAAkKfEN3CAwkRj8Aa5nRQi+1TJQ6EIAJC7ki0zBxiwIdFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO0Qss5EhV/E6kz0BNCgtAytf/s0Botvxt3kGCN8ALqeMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4We15aI3kHLAQYTjl+Dj7+/gQcNiviUuMZJDfA7gL3bGsBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKnMSQ6SjNLjhzuzQ/yV2jMXnKYPTb9GwsNukSmdVdTmuQIFBgACBgQDBwEBBwQBBAIACgygJSYAAAAAAAY=";

/** A legacy message as instructions over named accounts with their roles. */
function decodeMessage(m: Uint8Array) {
  const [signers, roSigned, roUnsigned, count] = m;
  const keys = Array.from({ length: count }, (_, i) =>
    base58.encode(m.subarray(4 + i * 32, 4 + (i + 1) * 32))
  );
  let at = 4 + count * 32;
  const blockhash = base58.encode(m.subarray(at, at + 32));
  at += 32;
  const meta = (i: number) => ({
    key: keys[i],
    signer: i < signers,
    writable: i < signers ? i < signers - roSigned : i < count - roUnsigned,
  });
  const instructions = Array.from({ length: m[at++] }, () => {
    const program = keys[m[at++]];
    const accounts = Array.from(m.subarray(at + 1, at + 1 + m[at]), meta);
    at += 1 + accounts.length;
    const data = Array.from(m.subarray(at + 1, at + 1 + m[at]));
    at += 1 + data.length;
    return { program, accounts, data };
  });
  return { payer: keys[0], blockhash, instructions };
}

/** The message of a signed one-signer transaction, after checking its signature. */
function signedMessage(base64: string, signer: string) {
  const bytes = new Uint8Array(base64ToBytes(base64));
  expect(bytes[0]).toBe(1);
  const message = bytes.subarray(65);
  expect(ed25519.verify(bytes.subarray(1, 65), message, base58.decode(signer))).toBe(true);
  return message;
}

/** Answer JSON-RPC calls by method, recording each. */
function rpcStub(answers: Record<string, unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    if (!(body.method in answers)) {
      return Response.json({ jsonrpc: "2.0", id: 1, error: { message: "no such method" } });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: answers[body.method] });
  });
  return calls;
}

const [devnet, base] = validateNetworks(
  [
    {
      family: "solana",
      name: "Solana Devnet",
      rpc_url: "https://devnet.example.com",
      explorer_url: "https://explorer.solana.com/?cluster=devnet",
      tokens: [{ symbol: "USDC", address: USDC_DEVNET, decimals: 6 }],
    },
    {
      family: "evm",
      name: "Base",
      rpc_url: "https://base.example.com",
      explorer_url: "https://basescan.org",
      tokens: [{ symbol: "USDC", address: BASE_USDC, decimals: 6 }],
    },
  ],
  SHIPPED
);

afterEach(() => vi.restoreAllMocks());

describe("amounts", () => {
  it("turns whole units into base units exactly", () => {
    expect(baseUnits("0.01", 9)).toBe(10_000_000n);
    expect(baseUnits("2.5", 6)).toBe(2_500_000n);
    expect(baseUnits("1.50", 1)).toBe(15n);
    expect(baseUnits(".5", 18)).toBe(5n * 10n ** 17n);
  });

  it("refuses extra decimals, zero and junk", () => {
    expect(() => baseUnits("0.0000001", 6)).toThrow(/more than 6 decimals/);
    expect(() => baseUnits("0", 6)).toThrow(/more than 0/);
    expect(() => baseUnits("-1", 6)).toThrow(/not an amount/);
    expect(() => baseUnits("1e3", 6)).toThrow(/not an amount/);
  });
});

describe("Solana transfers", () => {
  const from = walletAddresses(KEY).solana;

  it("derives associated token accounts as spl-token does, under both programs", async () => {
    expect(await associatedTokenAccount(from, USDC_DEVNET, TOKEN)).toBe(
      "8LVovtBE1L18x2z1ZHP5iGoUm2DwyicKrK7AvuxiTSv4"
    );
    expect(await associatedTokenAccount(TO, USDC_DEVNET, TOKEN)).toBe(
      "hvydCYGbNgNAVpGGZLN8gGi1iJXdANcJDTuPkvWzYmj"
    );
    expect(await associatedTokenAccount(from, USDC_DEVNET, TOKEN_2022)).toBe(
      "3soVg4sNYNZcF7R3k9iTzdiF1Wh34xwf8kUMsoea8z7m"
    );
  });

  it("sends SOL with the same instruction web3.js builds, signed by the wallet", async () => {
    const calls = rpcStub({
      getLatestBlockhash: { value: { blockhash: BLOCKHASH } },
      sendTransaction: "5ig",
    });
    const out = await transfer(KEY, devnet, TO, "0.01");
    const send = calls.find((c) => c.method === "sendTransaction")!;
    expect(send.params[1]).toMatchObject({ encoding: "base64" });
    const message = signedMessage(String(send.params[0]), from);
    expect(decodeMessage(message)).toEqual(
      decodeMessage(new Uint8Array(base64ToBytes(WEB3_NATIVE)))
    );
    expect(out).toContain(`Sent 0.01 SOL to ${TO} on Solana Devnet`);
    expect(out).toContain("Signature: 5ig");
    expect(out).toContain("https://explorer.solana.com/tx/5ig?cluster=devnet");
  });

  it("sends a token, creating the recipient's account, as spl-token does", async () => {
    const calls = rpcStub({
      getAccountInfo: { value: { owner: TOKEN } },
      getLatestBlockhash: { value: { blockhash: BLOCKHASH } },
      sendTransaction: "5ig",
    });
    await transfer(KEY, devnet, TO, "2.5", "usdc");
    const send = calls.find((c) => c.method === "sendTransaction")!;
    const ours = decodeMessage(signedMessage(String(send.params[0]), from));
    expect(ours).toEqual(decodeMessage(new Uint8Array(base64ToBytes(WEB3_SPL))));
  });

  it("refuses an untracked token, a bad address and a mint that is not one", async () => {
    await expect(transfer(KEY, devnet, TO, "1", "BONK")).rejects.toThrow(/can send SOL, USDC/);
    await expect(transfer(KEY, devnet, EVM, "1")).rejects.toThrow(/not a Solana address/);
    rpcStub({ getAccountInfo: { value: { owner: "11111111111111111111111111111111" } } });
    await expect(transfer(KEY, devnet, TO, "1", "USDC")).rejects.toThrow(/not a token mint/);
  });
});

describe("EVM transfers", () => {
  const chain = {
    eth_chainId: "0x2105",
    eth_getTransactionCount: "0x7",
    eth_estimateGas: "0x5208",
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
    eth_maxPriorityFeePerGas: "0x5f5e100",
    eth_sendRawTransaction: "0xabc",
  };

  it("sends ETH as an EIP-1559 transaction from the wallet", async () => {
    const calls = rpcStub(chain);
    const out = await transfer(KEY, base, "0x000000000000000000000000000000000000dEaD", "0.5");
    const raw = calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as Hex;
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(EVM);
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({
      type: "eip1559",
      chainId: 8453,
      nonce: 7,
      to: "0x000000000000000000000000000000000000dead",
      value: 5n * 10n ** 17n,
      gas: 25_200n,
      maxPriorityFeePerGas: 100_000_000n,
      maxFeePerGas: 2_100_000_000n,
    });
    expect(calls.find((c) => c.method === "eth_getTransactionCount")!.params).toEqual([
      EVM,
      "pending",
    ]);
    expect(out).toContain("Hash: 0xabc");
    expect(out).toContain("https://basescan.org/tx/0xabc");
  });

  it("sends an ERC-20 as transfer(to, amount) on the token, with a legacy gas price where there is no base fee", async () => {
    const calls = rpcStub({
      ...chain,
      eth_getBlockByNumber: {},
      eth_gasPrice: "0x3b9aca00",
    });
    await transfer(KEY, base, "0x000000000000000000000000000000000000dEaD", "2.5", "USDC");
    const tx = parseTransaction(
      calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as Hex
    );
    expect(tx.type).toBe("legacy");
    expect(tx.gasPrice).toBe(1_000_000_000n);
    expect(tx.to).toBe(BASE_USDC.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.data).toBe(
      `0xa9059cbb${"dead".padStart(64, "0")}${(2_500_000).toString(16).padStart(64, "0")}`
    );
  });
});

describe("send_transaction and wallet_transfer tools", () => {
  async function agent() {
    const reg = env.SessionRegistry.get(env.SessionRegistry.idFromName(crypto.randomUUID()));
    await reg.setChainNetworks([devnet, base]);
    return { registry: reg } as unknown as ToolContext;
  }

  it("broadcasts a signed transaction with the method its chain uses", async () => {
    const ctx = await agent();
    const calls = rpcStub({ eth_sendRawTransaction: "0xabc", sendTransaction: "5ig" });
    const evm = await runTool("send_transaction", { network: "base", transaction: "0x02f8" }, ctx);
    expect(evm.content).toContain("Hash: 0xabc");
    const sol = await runTool(
      "send_transaction",
      { network: "Solana Devnet", transaction: "AQID" },
      ctx
    );
    expect(sol.content).toContain("Signature: 5ig");
    expect(calls).toEqual([
      { method: "eth_sendRawTransaction", params: ["0x02f8"] },
      {
        method: "sendTransaction",
        params: ["AQID", { encoding: "base64", preflightCommitment: "confirmed" }],
      },
    ]);
  });

  it("refuses a transaction in the other chain's encoding and an unknown network", async () => {
    const ctx = await agent();
    const calls = rpcStub({});
    const evm = await runTool("send_transaction", { network: "base", transaction: "AQID" }, ctx);
    expect(evm.ok).toBe(false);
    expect(evm.content).toContain("0x hex");
    const missing = await runTool(
      "send_transaction",
      { network: "polygon", transaction: "0x02" },
      ctx
    );
    expect(missing.content).toContain("solana-devnet");
    expect(calls).toHaveLength(0);
  });

  it("sends from the agent's own wallet with wallet_transfer", async () => {
    const ctx = await agent();
    const calls = rpcStub({
      getLatestBlockhash: { value: { blockhash: BLOCKHASH } },
      sendTransaction: "5ig",
    });
    const result = await runTool(
      "wallet_transfer",
      { network: "solana-devnet", to: TO, amount: "0.01" },
      ctx
    );
    expect(result.ok).toBe(true);
    const own = walletAddresses((await ctx.registry.chainWalletKey(false))!).solana;
    const send = calls.find((c) => c.method === "sendTransaction")!;
    expect(decodeMessage(signedMessage(String(send.params[0]), own)).payer).toBe(own);
  });
});
