import type { DeploymentSettings } from "./settings";

/**
 * The networks the Wallet capability reads balances on, each with its own RPC URL and
 * the tokens the owner tracks there. Configured on the capabilities page; the agent calls
 * the RPC itself, so no MCP server is needed to look a balance up.
 */

export type ChainFamily = "evm" | "solana";

export type ChainToken = {
  symbol: string;
  /** The ERC-20 contract on EVM, the mint on Solana. */
  address: string;
  decimals: number;
};

export type ChainNetwork = {
  /** What the model names the network by: a slug of `name`, unique across the list. */
  id: string;
  family: ChainFamily;
  name: string;
  rpc_url: string;
  /** Where people look the network up (a block explorer's home); blank when not set. */
  explorer_url: string;
  /** The native coin's symbol (ETH, POL, SOL). Its decimals follow from the family. */
  native_symbol: string;
  tokens: ChainToken[];
};

const NATIVE_DECIMALS: Record<ChainFamily, number> = { evm: 18, solana: 9 };
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** SPL Token and Token-2022. */
const SOLANA_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isAddress = (family: ChainFamily, address: string) =>
  (family === "evm" ? EVM_ADDRESS : SOLANA_ADDRESS).test(address);

const text = (value: unknown, what: string, max: number): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} is required`);
  return value.trim().slice(0, max);
};

/** `value` when it is an https URL (or localhost, for a node on this machine). */
function httpsUrl(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`${what} must be https`);
  }
  return value;
}

/** Check a list sent by the capabilities page and give each network its id. Throws a reason to show. */
export function validateNetworks(input: unknown, settings: DeploymentSettings): ChainNetwork[] {
  if (!Array.isArray(input)) throw new Error("networks must be a list");
  if (input.length > settings.max_chain_networks) {
    throw new Error(`at most ${settings.max_chain_networks} networks`);
  }
  const ids = new Set<string>();
  return input.map((raw: Record<string, unknown>) => {
    const name = text(raw?.name, "a network name", 60);
    const family = raw.family;
    if (family !== "evm" && family !== "solana")
      throw new Error(`${name}: family must be evm or solana`);
    const id = slug(name);
    if (!id) throw new Error(`${name}: the name needs a letter or a digit`);
    if (ids.has(id)) throw new Error(`two networks are called ${name}`);
    ids.add(id);
    const rpc = httpsUrl(text(raw.rpc_url, `${name}: the RPC URL`, 500), `${name}: the RPC URL`);
    const explorer =
      typeof raw.explorer_url === "string" && raw.explorer_url.trim()
        ? httpsUrl(raw.explorer_url.trim().slice(0, 500), `${name}: the explorer URL`)
        : "";
    const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
    if (tokens.length > settings.max_chain_tokens) {
      throw new Error(`${name}: at most ${settings.max_chain_tokens} tokens`);
    }
    return {
      id,
      family,
      name,
      rpc_url: rpc,
      explorer_url: explorer,
      native_symbol:
        typeof raw.native_symbol === "string" && raw.native_symbol.trim()
          ? raw.native_symbol.trim().slice(0, 12)
          : family === "evm"
            ? "ETH"
            : "SOL",
      tokens: tokens.map((t: Record<string, unknown>) => {
        const symbol = text(t?.symbol, `${name}: a token symbol`, 12);
        const address = text(t.address, `${name} ${symbol}: the address`, 64);
        if (!isAddress(family, address)) {
          throw new Error(
            `${name} ${symbol}: not a ${family === "evm" ? "0x contract" : "mint"} address`
          );
        }
        const decimals = Number(t.decimals);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
          throw new Error(`${name} ${symbol}: decimals must be a whole number from 0 to 36`);
        }
        return { symbol, address, decimals };
      }),
    };
  });
}

/** The network the model named, by id or name, ignoring case. */
export function findNetwork(networks: ChainNetwork[], named: string): ChainNetwork | undefined {
  const want = slug(named);
  return networks.find((n) => n.id === want || slug(n.name) === want);
}

/** How the networks read to the model: what to pass as `network`, and what it tracks. */
export function describeNetworks(networks: ChainNetwork[]): string {
  if (networks.length === 0) return "No networks are configured for balances yet.";
  return networks
    .map((n) => {
      const tokens = n.tokens.map((t) => t.symbol).join(", ") || "none";
      const explorer = n.explorer_url ? `; explorer: ${n.explorer_url}` : "";
      return `- ${n.id} (${n.name}, ${n.family === "evm" ? "EVM" : "Solana"}): ${n.native_symbol}; tokens: ${tokens}${explorer}`;
    })
    .join("\n");
}

async function rpc(network: ChainNetwork, method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(network.rpc_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    throw new Error(`${network.name} RPC could not be reached: ${String(err)}`);
  }
  if (res.status === 403 || res.status === 429) {
    // Public endpoints (api.devnet.solana.com, mainnet-beta) turn servers away.
    throw new Error(
      `${network.name} RPC refused the request (${res.status}). Public endpoints often block servers; use a provider's RPC URL.`
    );
  }
  if (!res.ok) throw new Error(`${network.name} RPC answered ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${network.name} RPC refused ${method}: ${body.error.message}`);
  return body.result;
}

/** Base units as a plain decimal, trailing zeros dropped. */
export function units(amount: bigint, decimals: number): string {
  const digits = amount.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function nativeBalance(network: ChainNetwork, address: string): Promise<bigint> {
  if (network.family === "evm") {
    return BigInt(String(await rpc(network, "eth_getBalance", [address, "latest"])));
  }
  const result = (await rpc(network, "getBalance", [address, { commitment: "confirmed" }])) as {
    value: number;
  };
  return BigInt(result.value);
}

type ParsedTokenAccount = {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
};

async function tokenBalance(network: ChainNetwork, address: string, token: ChainToken) {
  if (network.family === "evm") {
    // balanceOf(address)
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const result = String(await rpc(network, "eth_call", [{ to: token.address, data }, "latest"]));
    return result === "0x" ? 0n : BigInt(result);
  }
  // Asked per token program and filtered by mint here: public RPCs refuse the `mint`
  // filter ("could not find mint") while answering this.
  let total = 0n;
  for (const programId of SOLANA_TOKEN_PROGRAMS) {
    const result = (await rpc(network, "getTokenAccountsByOwner", [
      address,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ])) as { value: ParsedTokenAccount[] };
    for (const account of result.value) {
      const info = account.account.data.parsed.info;
      if (info.mint === token.address) total += BigInt(info.tokenAmount.amount);
    }
  }
  return total;
}

export type Balance = { symbol: string; amount: string };

/**
 * What `address` holds on `network`: the native coin and every tracked token, or only
 * `symbol`, in whole units. Read in parallel.
 */
export async function readBalances(
  network: ChainNetwork,
  address: string,
  symbol?: string
): Promise<Balance[]> {
  if (!isAddress(network.family, address)) {
    throw new Error(`${address} is not a ${network.family === "evm" ? "0x" : "Solana"} address`);
  }
  const wanted = symbol?.trim().toLowerCase();
  const native = !wanted || wanted === network.native_symbol.toLowerCase();
  const tokens = wanted
    ? network.tokens.filter((t) => t.symbol.toLowerCase() === wanted)
    : network.tokens;
  if (!native && tokens.length === 0) {
    const tracked = [network.native_symbol, ...network.tokens.map((t) => t.symbol)].join(", ");
    throw new Error(`${network.name} tracks no ${symbol}; it tracks ${tracked}`);
  }
  return Promise.all([
    ...(native
      ? [
          nativeBalance(network, address).then((amount) => ({
            symbol: network.native_symbol,
            amount: units(amount, NATIVE_DECIMALS[network.family]),
          })),
        ]
      : []),
    ...tokens.map((token) =>
      tokenBalance(network, address, token).then((amount) => ({
        symbol: token.symbol,
        amount: units(amount, token.decimals),
      }))
    ),
  ]);
}

/** The same, as the model reads it: one line each under the address and network. */
export async function balances(
  network: ChainNetwork,
  address: string,
  symbol?: string
): Promise<string> {
  const held = await readBalances(network, address, symbol);
  return [`${address} on ${network.name}:`, ...held.map((b) => `${b.amount} ${b.symbol}`)].join(
    "\n"
  );
}
