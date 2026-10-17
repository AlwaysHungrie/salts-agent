import type { Env } from "./env";

/**
 * Crypto payments for wallet keys, with no processor in between: the buyer's wallet sends
 * USDC (or ETH) straight to the deployment's address, and the Worker reads the transaction
 * back from the chain before counting it. Prices come from Chainlink's ETH/USD feed.
 */

export type PayAsset = "usdc" | "eth";
export type PayFamily = "evm" | "solana";

export type PayNetwork = {
  id: string;
  label: string;
  family: PayFamily;
  /** EVM chain id; 0 on Solana. */
  chain_id: number;
  /** The official USDC contract (EVM) or mint (Solana). */
  usdc: string;
  /** Whether the native coin is ETH, so ETH can be paid here. */
  eth: boolean;
  /** Blocks on top of the payment before it counts (EVM); Solana waits for finality. */
  confirmations: number;
};

/** Circle's own USDC on each network, never a bridged copy. */
export const PAY_NETWORKS: PayNetwork[] = [
  {
    id: "ethereum",
    label: "Ethereum",
    family: "evm",
    chain_id: 1,
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    eth: true,
    confirmations: 3,
  },
  {
    id: "base",
    label: "Base",
    family: "evm",
    chain_id: 8453,
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    eth: true,
    confirmations: 5,
  },
  {
    id: "arbitrum",
    label: "Arbitrum",
    family: "evm",
    chain_id: 42161,
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    eth: true,
    confirmations: 5,
  },
  {
    id: "optimism",
    label: "Optimism",
    family: "evm",
    chain_id: 10,
    usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    eth: true,
    confirmations: 5,
  },
  {
    id: "polygon",
    label: "Polygon",
    family: "evm",
    chain_id: 137,
    usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    eth: false,
    confirmations: 5,
  },
  {
    id: "solana",
    label: "Solana",
    family: "solana",
    chain_id: 0,
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    eth: false,
    confirmations: 0,
  },
];

/** Chainlink's ETH/USD feed on Ethereum mainnet, 8 decimals. */
const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
/** `latestRoundData()`. */
const LATEST_ROUND_DATA = "0xfeaf968c";
/** `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** How long a quote may be paid against: long enough to approve, short for ETH's price. */
export const QUOTE_TTL_MS = 30 * 60 * 1000;

/** Where this network's payments go, or "" when the deployment has not set one up. */
export function payAddress(env: Env, network: PayNetwork): string {
  const address = env.PAYMENT_ADDRESSES?.[network.family] ?? "";
  return network.family === "evm" ? address.toLowerCase() : address;
}

/** The networks this deployment takes payments on: an address and an RPC endpoint each. */
export function enabledNetworks(env: Env): PayNetwork[] {
  return PAY_NETWORKS.filter((n) => payAddress(env, n) && env.PAYMENT_RPC?.[n.id]);
}

export class PaymentError extends Error {}

async function rpc<T>(env: Env, network: PayNetwork, method: string, params: unknown[]): Promise<T> {
  const url = env.PAYMENT_RPC?.[network.id];
  if (!url) throw new PaymentError(`Payments on ${network.label} aren't set up.`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new PaymentError(`${network.label} didn't answer (${res.status}). Try again.`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new PaymentError(`${network.label} refused: ${body.error.message ?? "error"}`);
  return body.result as T;
}

/** ETH's price in dollars, from Chainlink on Ethereum mainnet. */
export async function ethUsd(env: Env): Promise<number> {
  const mainnet = PAY_NETWORKS[0];
  const data = await rpc<string>(env, mainnet, "eth_call", [
    { to: ETH_USD_FEED, data: LATEST_ROUND_DATA },
    "latest",
  ]);
  // (roundId, answer, startedAt, updatedAt, answeredInRound): the answer is the second word.
  const answer = BigInt(`0x${data.slice(2 + 64, 2 + 128)}`);
  const price = Number(answer) / 1e8;
  if (!(price > 0)) throw new PaymentError("Couldn't read the ETH price. Try again.");
  return price;
}

/**
 * How many base units to ask for: the dollar amount, plus a few units of dust that make
 * this quote's amount its own, so a payment cannot be claimed against someone else's.
 */
export async function quoteUnits(env: Env, asset: PayAsset, usd: number): Promise<bigint> {
  if (asset === "usdc") {
    return BigInt(Math.round(usd * 1e6)) + BigInt(1 + Math.floor(Math.random() * 9999));
  }
  const price = await ethUsd(env);
  // Rounded up to whole gwei, so the buyer is never short of the dollar amount.
  const gwei = BigInt(Math.ceil((usd / price) * 1e9));
  return gwei * 1_000_000_000n + BigInt(1 + Math.floor(Math.random() * 999_999));
}

/** A quote, as the Worker checks a payment against it. */
export type Quote = {
  network: string;
  asset: PayAsset;
  to_address: string;
  payer: string;
  units: string;
  expires_at: number;
};

/** The chain's verdict on a payment: counted, not yet final, or refused with a reason. */
export type Verdict = { status: "paid" } | { status: "pending"; reason: string } | { status: "failed"; reason: string };

/** Check a transaction against a quote, reading it back from the chain. */
export async function verifyPayment(env: Env, quote: Quote, tx: string): Promise<Verdict> {
  const network = PAY_NETWORKS.find((n) => n.id === quote.network);
  if (!network) return { status: "failed", reason: "Unknown network." };
  return network.family === "evm"
    ? await verifyEvm(env, network, quote, tx)
    : await verifySolana(env, network, quote, tx);
}

const hex = (value: string | undefined | null) => BigInt(value ?? "0x0");
/** The address in a 32-byte log topic. */
const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

type EvmLog = { address: string; topics: string[]; data: string };

async function verifyEvm(env: Env, network: PayNetwork, quote: Quote, tx: string): Promise<Verdict> {
  const receipt = await rpc<{
    status: string;
    blockNumber: string;
    from: string;
    to: string | null;
    logs: EvmLog[];
  } | null>(env, network, "eth_getTransactionReceipt", [tx]);
  if (!receipt) return { status: "pending", reason: "Waiting for the transaction to land." };
  if (receipt.status !== "0x1") return { status: "failed", reason: "The transaction failed on-chain." };
  if (receipt.from.toLowerCase() !== quote.payer) {
    return { status: "failed", reason: "That transaction came from a different wallet." };
  }

  const latest = hex(await rpc<string>(env, network, "eth_blockNumber", []));
  const depth = latest - hex(receipt.blockNumber) + 1n;
  if (depth < BigInt(network.confirmations)) {
    return { status: "pending", reason: "Waiting for confirmations." };
  }
  const block = await rpc<{ timestamp: string }>(env, network, "eth_getBlockByNumber", [
    receipt.blockNumber,
    false,
  ]);
  if (Number(hex(block.timestamp)) * 1000 > quote.expires_at) {
    return { status: "failed", reason: "The payment arrived after the quote expired." };
  }

  const wanted = BigInt(quote.units);
  if (quote.asset === "eth") {
    const sent = await rpc<{ to: string | null; value: string }>(
      env,
      network,
      "eth_getTransactionByHash",
      [tx]
    );
    const paid = (sent.to ?? "").toLowerCase() === quote.to_address && hex(sent.value) >= wanted;
    return paid ? { status: "paid" } : { status: "failed", reason: "No matching ETH payment in it." };
  }

  const paid = receipt.logs.some(
    (log) =>
      log.address.toLowerCase() === network.usdc &&
      log.topics[0] === TRANSFER_TOPIC &&
      topicAddress(log.topics[1] ?? "") === quote.payer &&
      topicAddress(log.topics[2] ?? "") === quote.to_address &&
      hex(log.data) >= wanted
  );
  return paid ? { status: "paid" } : { status: "failed", reason: "No matching USDC transfer in it." };
}

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

async function verifySolana(
  env: Env,
  network: PayNetwork,
  quote: Quote,
  tx: string
): Promise<Verdict> {
  const found = await rpc<{
    blockTime: number | null;
    meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] };
    transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
  } | null>(env, network, "getTransaction", [
    tx,
    { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!found) return { status: "pending", reason: "Waiting for the transaction to finalize." };
  if (found.meta.err) return { status: "failed", reason: "The transaction failed on-chain." };
  const signers = found.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
  if (!signers.includes(quote.payer)) {
    return { status: "failed", reason: "That transaction came from a different wallet." };
  }
  if ((found.blockTime ?? 0) * 1000 > quote.expires_at) {
    return { status: "failed", reason: "The payment arrived after the quote expired." };
  }

  // What the deployment's USDC account gained in this transaction.
  const ours = (b: TokenBalance) => b.owner === quote.to_address && b.mint === network.usdc;
  const after = found.meta.postTokenBalances?.find(ours);
  if (!after) return { status: "failed", reason: "No matching USDC transfer in it." };
  const before = found.meta.preTokenBalances?.find((b) => b.accountIndex === after.accountIndex);
  const gained = BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
  return gained >= BigInt(quote.units)
    ? { status: "paid" }
    : { status: "failed", reason: "No matching USDC transfer in it." };
}

/** A transaction id as each family writes it, or undefined when it is not one. */
export function txId(family: PayFamily, value: unknown): string | undefined {
  const tx = typeof value === "string" ? value.trim() : "";
  if (family === "evm") return /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx.toLowerCase() : undefined;
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(tx) ? tx : undefined;
}

/** A payer's address as each family writes it, or undefined when it is not one. */
export function payerAddress(family: PayFamily, value: unknown): string | undefined {
  const address = typeof value === "string" ? value.trim() : "";
  if (family === "evm") return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : undefined;
}
