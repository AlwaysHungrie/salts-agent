import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { isHex, type Hex } from "viem";
import {
  NATIVE_DECIMALS,
  SOLANA_TOKEN_PROGRAMS,
  isAddress,
  rpc,
  type ChainNetwork,
  type ChainToken,
} from "./chain-networks";
import { signEvmTransaction, signSolanaTransaction, walletAddresses } from "./chain-wallet";
import { base64ToBytes, bytesToBase64, toArrayBuffer } from "./util/bytes";

/**
 * Moving funds from the agent's wallet over a configured network's RPC: a transfer built,
 * signed and broadcast in one go, and the broadcast alone for a transaction signed before.
 * Both return once the RPC accepts the transaction, not once it is confirmed.
 */

/** A whole-unit amount ("0.01") in base units, refusing more decimals than the coin has. */
export function baseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match || (!match[1] && !match[2])) throw new Error(`${amount} is not an amount`);
  const fraction = match[2] ?? "";
  if (fraction.replace(/0+$/, "").length > decimals) {
    throw new Error(`${amount} has more than ${decimals} decimals`);
  }
  const value = BigInt((match[1] || "0") + fraction.padEnd(decimals, "0").slice(0, decimals));
  if (value <= 0n) throw new Error("the amount must be more than 0");
  return value;
}

/** The transaction's page on the network's explorer, keeping its query (`?cluster=devnet`). */
export function explorerTx(network: ChainNetwork, hash: string): string | undefined {
  if (!network.explorer_url) return undefined;
  try {
    const url = new URL(network.explorer_url);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/tx/${hash}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** How a broadcast reads to the model. */
function sent(network: ChainNetwork, hash: string, what: string): string {
  const link = explorerTx(network, hash);
  return [
    `${what} on ${network.name}. Broadcast; not yet confirmed.`,
    `${network.family === "evm" ? "Hash" : "Signature"}: ${hash}`,
    ...(link ? [`Explorer: ${link}`] : []),
  ].join("\n");
}

/** Broadcast a signed transaction: 0x hex on EVM, base64 on Solana. */
export async function sendTransaction(network: ChainNetwork, transaction: string): Promise<string> {
  const tx = transaction.trim();
  if (network.family === "evm") {
    if (!isHex(tx) || tx.length < 4) throw new Error("an EVM transaction must be 0x hex");
    return sent(network, String(await rpc(network, "eth_sendRawTransaction", [tx])), "Sent");
  }
  try {
    base64ToBytes(tx);
  } catch {
    throw new Error("a Solana transaction must be base64");
  }
  const signature = await rpc(network, "sendTransaction", [
    tx,
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  return sent(network, String(signature), "Sent");
}

/** The coin to move: the native one when no symbol is named or it names the native coin. */
function pickToken(network: ChainNetwork, symbol?: string): ChainToken | undefined {
  const wanted = symbol?.trim().toLowerCase();
  if (!wanted || wanted === network.native_symbol.toLowerCase()) return undefined;
  const token = network.tokens.find((t) => t.symbol.toLowerCase() === wanted);
  if (!token) {
    const tracked = [network.native_symbol, ...network.tokens.map((t) => t.symbol)].join(", ");
    throw new Error(`${network.name} tracks no ${symbol}; it can send ${tracked}`);
  }
  return token;
}

/**
 * Send `amount` (whole units) of the native coin or a tracked token from the wallet to
 * `to`. Solana token transfers create the recipient's token account when it is missing.
 */
export async function transfer(
  key: Hex,
  network: ChainNetwork,
  to: string,
  amount: string,
  symbol?: string
): Promise<string> {
  if (!isAddress(network.family, to)) {
    throw new Error(`${to} is not a ${network.family === "evm" ? "0x" : "Solana"} address`);
  }
  const token = pickToken(network, symbol);
  const value = baseUnits(amount, token ? token.decimals : NATIVE_DECIMALS[network.family]);
  const hash =
    network.family === "evm"
      ? await evmTransfer(key, network, to, value, token)
      : await solanaTransfer(key, network, to, value, token);
  return sent(network, hash, `Sent ${amount} ${token?.symbol ?? network.native_symbol} to ${to}`);
}

/* ------------------------------------------------------------------ evm -- */

const big = (value: unknown) => BigInt(String(value));

async function evmTransfer(
  key: Hex,
  network: ChainNetwork,
  to: string,
  value: bigint,
  token?: ChainToken
): Promise<string> {
  const from = walletAddresses(key).evm;
  // An ERC-20 transfer(address,uint256) call to the token, or plain value to `to`.
  const call = token
    ? {
        to: token.address,
        value: 0n,
        data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${value.toString(16).padStart(64, "0")}`,
      }
    : { to, value, data: "0x" };
  const [chainId, nonce, gas, block] = await Promise.all([
    rpc(network, "eth_chainId", []),
    rpc(network, "eth_getTransactionCount", [from, "pending"]),
    rpc(network, "eth_estimateGas", [
      { from, to: call.to, value: `0x${call.value.toString(16)}`, data: call.data },
    ]),
    rpc(network, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const baseFee = (block as { baseFeePerGas?: string } | null)?.baseFeePerGas;
  const priority = baseFee
    ? await rpc(network, "eth_maxPriorityFeePerGas", []).catch(() => undefined)
    : undefined;
  // EIP-1559 where the chain has a base fee and the RPC suggests a tip; a legacy gas price otherwise.
  const fees =
    baseFee && priority !== undefined
      ? {
          maxPriorityFeePerGas: big(priority).toString(),
          maxFeePerGas: (big(baseFee) * 2n + big(priority)).toString(),
        }
      : { gasPrice: big(await rpc(network, "eth_gasPrice", [])).toString() };
  const { raw } = await signEvmTransaction(key, {
    chainId: big(chainId).toString(),
    nonce: big(nonce).toString(),
    // A fifth over the estimate, for state that moves between estimate and inclusion.
    gas: ((big(gas) * 6n) / 5n).toString(),
    to: call.to,
    value: call.value.toString(),
    data: call.data,
    ...fees,
  });
  return String(await rpc(network, "eth_sendRawTransaction", [raw]));
}

/* --------------------------------------------------------------- solana -- */

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

type Meta = { key: string; signer: boolean; writable: boolean };
type Instruction = { program: string; accounts: Meta[]; data: Uint8Array };

/** Solana's compact-u16 length prefix. */
function shortvec(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if (n === 0) return [...out, byte];
    out.push(byte | 0x80);
  }
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/**
 * A legacy message: the fee payer first, then signers, writable accounts and read-only
 * ones (each account once, with the widest role any instruction gives it).
 */
export function compileMessage(
  payer: string,
  instructions: Instruction[],
  blockhash: string
): Uint8Array {
  const metas = new Map<string, Meta>([[payer, { key: payer, signer: true, writable: true }]]);
  const add = (m: Meta) => {
    const had = metas.get(m.key);
    metas.set(m.key, {
      key: m.key,
      signer: m.signer || !!had?.signer,
      writable: m.writable || !!had?.writable,
    });
  };
  for (const ix of instructions) {
    ix.accounts.forEach(add);
    add({ key: ix.program, signer: false, writable: false });
  }
  const rank = (m: Meta) => (m.signer ? 0 : 2) + (m.writable ? 0 : 1);
  const keys = [...metas.values()].sort((a, b) =>
    a.key === payer ? -1 : b.key === payer ? 1 : rank(a) - rank(b)
  );
  const index = new Map(keys.map((m, i) => [m.key, i]));
  const bytes: number[] = [
    keys.filter((m) => m.signer).length,
    keys.filter((m) => m.signer && !m.writable).length,
    keys.filter((m) => !m.signer && !m.writable).length,
    ...shortvec(keys.length),
    ...keys.flatMap((m) => [...base58.decode(m.key)]),
    ...base58.decode(blockhash),
    ...shortvec(instructions.length),
  ];
  for (const ix of instructions) {
    bytes.push(
      index.get(ix.program)!,
      ...shortvec(ix.accounts.length),
      ...ix.accounts.map((a) => index.get(a.key)!),
      ...shortvec(ix.data.length),
      ...ix.data
    );
  }
  return new Uint8Array(bytes);
}

/** Whether 32 bytes are a point on ed25519: program-derived addresses must not be. */
function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAccount(
  owner: string,
  mint: string,
  tokenProgram: string
): Promise<string> {
  const seeds = [owner, tokenProgram, mint].flatMap((k) => [...base58.decode(k)]);
  const tail = [
    ...base58.decode(ASSOCIATED_TOKEN_PROGRAM),
    ...new TextEncoder().encode("ProgramDerivedAddress"),
  ];
  for (let bump = 255; bump >= 0; bump--) {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array([...seeds, bump, ...tail]))
    );
    if (!onCurve(hash)) return base58.encode(hash);
  }
  throw new Error("no associated token account address");
}

/** Which token program a mint belongs to: SPL Token or Token-2022. */
async function tokenProgramOf(network: ChainNetwork, mint: string): Promise<string> {
  const result = (await rpc(network, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "confirmed" },
  ])) as { value: { owner: string } | null };
  const owner = result.value?.owner;
  if (!owner) throw new Error(`mint ${mint} does not exist on ${network.name}`);
  if (!SOLANA_TOKEN_PROGRAMS.includes(owner)) throw new Error(`${mint} is not a token mint`);
  return owner;
}

async function solanaTransfer(
  key: Hex,
  network: ChainNetwork,
  to: string,
  value: bigint,
  token?: ChainToken
): Promise<string> {
  const from = walletAddresses(key).solana;
  const instructions: Instruction[] = [];
  if (!token) {
    // SystemProgram Transfer: instruction 2, then lamports.
    instructions.push({
      program: SYSTEM_PROGRAM,
      accounts: [
        { key: from, signer: true, writable: true },
        { key: to, signer: false, writable: true },
      ],
      data: new Uint8Array([2, 0, 0, 0, ...u64(value)]),
    });
  } else {
    const program = await tokenProgramOf(network, token.address);
    const source = await associatedTokenAccount(from, token.address, program);
    const destination = await associatedTokenAccount(to, token.address, program);
    instructions.push(
      // CreateIdempotent: makes the recipient's token account, or does nothing if it exists.
      {
        program: ASSOCIATED_TOKEN_PROGRAM,
        accounts: [
          { key: from, signer: true, writable: true },
          { key: destination, signer: false, writable: true },
          { key: to, signer: false, writable: false },
          { key: token.address, signer: false, writable: false },
          { key: SYSTEM_PROGRAM, signer: false, writable: false },
          { key: program, signer: false, writable: false },
        ],
        data: new Uint8Array([1]),
      },
      // TransferChecked: instruction 12, amount, decimals (checked against the mint).
      {
        program,
        accounts: [
          { key: source, signer: false, writable: true },
          { key: token.address, signer: false, writable: false },
          { key: destination, signer: false, writable: true },
          { key: from, signer: true, writable: false },
        ],
        data: new Uint8Array([12, ...u64(value), token.decimals]),
      }
    );
  }
  const latest = (await rpc(network, "getLatestBlockhash", [{ commitment: "confirmed" }])) as {
    value: { blockhash: string };
  };
  const message = compileMessage(from, instructions, latest.value.blockhash);
  const signed = signSolanaTransaction(key, bytesToBase64(toArrayBuffer(message)));
  return String(
    await rpc(network, "sendTransaction", [
      signed,
      { encoding: "base64", preflightCommitment: "confirmed" },
    ])
  );
}
