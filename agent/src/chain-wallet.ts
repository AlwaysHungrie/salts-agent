import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base58 } from "@scure/base";
import {
  bytesToHex,
  hexToBytes,
  isHex,
  keccak256,
  type Hex,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base64ToBytes, bytesToBase64, toArrayBuffer } from "./util/bytes";

/**
 * The agent's one wallet: 32 random bytes, used as is as the secp256k1 private key (EVM)
 * and as the ed25519 seed (Solana). Both addresses come from the same secret, so there is
 * one thing to keep, and it never leaves the Worker: only addresses and signatures do.
 */

export type WalletAddresses = { evm: string; solana: string };

/** A fresh secret, as 0x-prefixed hex. Redrawn in the astronomically rare case it is not a valid secp256k1 key. */
export function newWalletKey(): Hex {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    if (secp256k1.utils.isValidPrivateKey(bytes)) return bytesToHex(bytes);
  }
}

export function walletAddresses(key: Hex): WalletAddresses {
  return {
    evm: privateKeyToAccount(key).address,
    solana: base58.encode(ed25519.getPublicKey(hexToBytes(key))),
  };
}

/* ------------------------------------------------------------------ evm -- */

const BIG_FIELDS = ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"] as const;

/** A number the model sent as a decimal string, a hex string or a JSON number. */
function bigOf(name: string, value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(
    `${name} must be a whole number (decimal or 0x hex), got ${JSON.stringify(value)}`
  );
}

/** The model's transaction object as viem takes it: numbers made bigints, the rest checked. */
export function evmTransaction(input: Record<string, unknown>): TransactionSerializable {
  const tx: Record<string, unknown> = {};
  if (input.chainId === undefined) throw new Error("chainId is required");
  tx.chainId = Number(bigOf("chainId", input.chainId));
  if (input.nonce !== undefined) tx.nonce = Number(bigOf("nonce", input.nonce));
  for (const key of BIG_FIELDS) {
    if (input[key] !== undefined) tx[key] = bigOf(key, input[key]);
  }
  if (input.to !== undefined) {
    if (typeof input.to !== "string" || !/^0x[0-9a-f]{40}$/i.test(input.to)) {
      throw new Error("to must be a 0x address");
    }
    tx.to = input.to;
  }
  if (input.data !== undefined) {
    if (typeof input.data !== "string" || !isHex(input.data))
      throw new Error("data must be 0x hex");
    tx.data = input.data;
  }
  if (input.accessList !== undefined) tx.accessList = input.accessList;
  if (input.type !== undefined) tx.type = input.type;
  return tx as TransactionSerializable;
}

/** A signed transaction, ready for `eth_sendRawTransaction`, and its hash. */
export async function signEvmTransaction(
  key: Hex,
  input: Record<string, unknown>
): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await privateKeyToAccount(key).signTransaction(evmTransaction(input));
  return { raw, hash: keccak256(raw) };
}

/** An EIP-712 signature: permits, x402 payments, order books. */
export async function signEvmTypedData(key: Hex, typed: Record<string, unknown>): Promise<Hex> {
  if (!typed.types || !typed.primaryType || !typed.message) {
    throw new Error("typed data needs types, primaryType and message");
  }
  return privateKeyToAccount(key).signTypedData(typed as unknown as TypedDataDefinition);
}

/* --------------------------------------------------------------- solana -- */

/** Solana's compact-u16: the value, and how many bytes it took. */
function shortvec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) throw new Error("transaction is cut short");
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  throw new Error("transaction has a malformed length");
}

/** How many signatures a message needs, and the accounts that give them (legacy and v0 alike). */
function signers(message: Uint8Array): Uint8Array[] {
  // A versioned message starts with 0x80 | version; a legacy one with its header.
  const at = message[0] !== undefined && message[0] & 0x80 ? 1 : 0;
  const required = message[at];
  if (required === undefined) throw new Error("transaction is cut short");
  const [count, size] = shortvec(message, at + 3);
  const keys = at + 3 + size;
  if (count < required || keys + count * 32 > message.length) {
    throw new Error("not a Solana transaction");
  }
  return Array.from({ length: required }, (_, i) =>
    message.subarray(keys + i * 32, keys + (i + 1) * 32)
  );
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The transaction's signature slots and message; a bare message gets empty slots. */
function splitTransaction(bytes: Uint8Array): { slots: Uint8Array[]; message: Uint8Array } {
  try {
    const [count, size] = shortvec(bytes, 0);
    const message = bytes.subarray(size + count * 64);
    if (signers(message).length === count) {
      const slots = Array.from({ length: count }, (_, i) =>
        bytes.slice(size + i * 64, size + (i + 1) * 64)
      );
      return { slots, message };
    }
  } catch {
    // Not a whole transaction; read it as a message below.
  }
  const required = signers(bytes).length;
  return { slots: Array.from({ length: required }, () => new Uint8Array(64)), message: bytes };
}

/**
 * Sign a serialized Solana transaction (base64, legacy or v0, other signatures kept) or a
 * bare message. Returns the transaction, base64, ready for `sendTransaction`.
 */
export function signSolanaTransaction(key: Hex, base64: string): string {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(base64ToBytes(base64.trim()));
  } catch {
    throw new Error("transaction must be base64");
  }
  const seed = hexToBytes(key);
  const own = ed25519.getPublicKey(seed);
  const { slots, message } = splitTransaction(bytes);
  const index = signers(message).findIndex((k) => same(k, own));
  if (index < 0) throw new Error("this wallet is not a signer of that transaction");
  slots[index] = ed25519.sign(message, seed);
  const prefix =
    slots.length < 0x80 ? [slots.length] : [(slots.length & 0x7f) | 0x80, slots.length >> 7];
  const out = new Uint8Array(prefix.length + slots.length * 64 + message.length);
  out.set(prefix, 0);
  slots.forEach((s, i) => out.set(s, prefix.length + i * 64));
  out.set(message, prefix.length + slots.length * 64);
  return bytesToBase64(toArrayBuffer(out));
}
