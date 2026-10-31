"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

export type ChainFamily = "evm" | "solana";

export type ChainToken = { symbol: string; address: string; decimals: number };

export type ChainNetwork = {
  id: string;
  family: ChainFamily;
  name: string;
  rpc_url: string;
  explorer_url: string;
  native_symbol: string;
  tokens: ChainToken[];
};

/** A token row while it is typed: decimals stay text until saved. */
type TokenDraft = { symbol: string; address: string; decimals: string };

const COPY: Record<
  ChainFamily,
  {
    chain: string;
    name: string;
    rpc: string;
    explorer: string;
    native: string;
    address: string;
    addressHint: string;
  }
> = {
  evm: {
    chain: "EVM",
    name: "Base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    native: "ETH",
    address: "Contract",
    addressHint: "0x…",
  },
  solana: {
    chain: "Solana",
    name: "Solana Devnet",
    rpc: "https://api.devnet.solana.com",
    explorer: "https://explorer.solana.com/?cluster=devnet",
    native: "SOL",
    address: "Mint",
    addressHint: "Mint address",
  },
};

// Pills on the soft tint, like the wallet card's address.
const field =
  "bg-canvas-soft focus:bg-field placeholder:text-faint text-ink min-w-0 rounded-full px-4 py-2 text-sm outline-none transition";
// Plain inputs inside a table cell: the table's lines frame them.
const cell =
  "placeholder:text-faint text-ink focus:bg-canvas-soft min-w-0 bg-transparent px-3 py-2 text-[13px] outline-none transition";
/** Symbol, address, decimals, remove: one grid for the header and every row. */
const columns = "grid grid-cols-[5.5rem_minmax(0,1fr)_5rem_2rem] items-center";
const label = "text-muted mb-1.5 block text-xs font-semibold leading-[1.33]";
const section = "px-5 py-4";

/**
 * Add or edit one network of one chain: its name, RPC URL, native coin and the tokens
 * to track. The Worker takes the whole list, so the rest goes back untouched.
 */
export function ChainNetworksDialog({
  agentId,
  family,
  network,
  networks,
  onClose,
  onSaved,
}: {
  agentId: string;
  family: ChainFamily;
  /** The network being edited; absent when adding one. */
  network?: ChainNetwork;
  networks: ChainNetwork[];
  onClose: () => void;
  onSaved: (networks: ChainNetwork[]) => void;
}) {
  const copy = COPY[family];
  const [name, setName] = useState(network?.name ?? "");
  const [rpc, setRpc] = useState(network?.rpc_url ?? "");
  const [explorer, setExplorer] = useState(network?.explorer_url ?? "");
  const [native, setNative] = useState(network?.native_symbol ?? copy.native);
  const [tokens, setTokens] = useState<TokenDraft[]>(
    network?.tokens.map((t) => ({ ...t, decimals: String(t.decimals) })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Send the list with this network replaced, added, or (`keep` false) left out. */
  const send = async (keep: boolean) => {
    setSaving(true);
    setError(null);
    const others = networks.filter((n) => n.id !== network?.id);
    const mine = {
      family,
      name,
      rpc_url: rpc,
      explorer_url: explorer,
      native_symbol: native,
      tokens: tokens.map((t) => ({ ...t, decimals: Number(t.decimals) })),
    };
    const res = await fetch(
      `/api/agents/${encodeURIComponent(agentId)}/chain-wallet/networks`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ networks: keep ? [...others, mine] : others }),
      },
    ).catch(() => null);
    setSaving(false);
    const body = (await res?.json().catch(() => null)) as {
      networks?: ChainNetwork[];
      error?: string;
    } | null;
    if (!res?.ok || !body?.networks) {
      setError(body?.error ?? "Couldn't save. Try again.");
      return;
    }
    onSaved(body.networks);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5">
      <div className="bg-canvas border-hairline flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border shadow-xl">
        <div className="bg-canvas-soft flex items-center gap-3 px-5 py-3">
          <ChainMark family={family} />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">
            {network
              ? `Edit ${network.name}`
              : `Configure ${copy.chain} network`}
          </p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink hover:bg-field -mr-1.5 shrink-0 rounded-full p-1.5 transition"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="divide-hairline-soft flex-1 divide-y overflow-y-auto">
          <div className={`${section} flex gap-3`}>
            <label className="min-w-0 flex-1">
              <span className={label}>Network name</span>
              <input
                ref={first}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={copy.name}
                className={`${field} w-full`}
              />
            </label>
            <label className="w-28 shrink-0">
              <span className={label}>Native token</span>
              <input
                value={native}
                onChange={(e) => setNative(e.target.value)}
                placeholder={copy.native}
                className={`${field} w-full`}
              />
            </label>
          </div>

          <div className={`${section} space-y-4`}>
            <label className="block">
              <span className={label}>RPC URL</span>
              <input
                value={rpc}
                onChange={(e) => setRpc(e.target.value)}
                placeholder={copy.rpc}
                className={`${field} w-full font-mono text-[13px]`}
              />
            </label>
            <label className="block">
              <span className={label}>Explorer URL</span>
              <input
                value={explorer}
                onChange={(e) => setExplorer(e.target.value)}
                placeholder={copy.explorer}
                className={`${field} w-full font-mono text-[13px]`}
              />
            </label>
          </div>

          <div className={section}>
            <TokenTable copy={copy} tokens={tokens} onChange={setTokens} />
          </div>
        </div>

        <div className="border-hairline-soft flex items-center gap-2 border-t px-5 py-3">
          {network && (
            <button
              onClick={() => send(false)}
              disabled={saving}
              className="text-muted hover:text-ink mr-auto text-xs font-semibold transition disabled:opacity-40"
            >
              Remove network
            </button>
          )}
          {error && (
            <p className="text-ink mr-auto line-clamp-2 text-xs leading-[1.33]">
              {error}
            </p>
          )}
          <button
            onClick={onClose}
            className="border-hairline text-ink hover:bg-canvas-soft ml-auto h-9 rounded-full border px-4 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={() => send(true)}
            disabled={saving || !name.trim() || !rpc.trim()}
            className="bg-ink text-on-primary h-9 rounded-full px-4 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {saving ? "Saving…" : network ? "Save" : "Add network"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The tokens to track, as a table: symbol, address and decimals, edited in place. */
function TokenTable({
  copy,
  tokens,
  onChange,
}: {
  copy: (typeof COPY)[ChainFamily];
  tokens: TokenDraft[];
  onChange: (tokens: TokenDraft[]) => void;
}) {
  const edit = (k: number, patch: Partial<TokenDraft>) =>
    onChange(tokens.map((t, j) => (j === k ? { ...t, ...patch } : t)));
  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <span className="text-muted text-xs font-semibold leading-[1.33]">
          Tracked tokens
        </span>
        <button
          onClick={() =>
            onChange([...tokens, { symbol: "", address: "", decimals: "" }])
          }
          aria-label="Add token"
          title="Add token"
          className="text-muted hover:text-ink hover:bg-canvas-soft rounded-full p-1 transition"
        >
          <Plus size={13} strokeWidth={2.5} />
        </button>
      </div>
      {tokens.length > 0 && (
        <div className="border-hairline divide-hairline-soft divide-y overflow-hidden rounded-2xl border">
          <div
            className={`${columns} bg-canvas-soft text-muted text-[11px] font-semibold uppercase tracking-wide`}
          >
            <span className="px-3 py-2">Symbol</span>
            <span className="border-hairline-soft border-l px-3 py-2">
              {copy.address}
            </span>
            <span className="border-hairline-soft border-l px-3 py-2">
              Decimals
            </span>
            <span />
          </div>
          {tokens.map((t, k) => (
            <div key={k} className={columns}>
              <input
                value={t.symbol}
                onChange={(e) => edit(k, { symbol: e.target.value })}
                placeholder="USDC"
                aria-label="Symbol"
                className={cell}
              />
              <input
                value={t.address}
                onChange={(e) => edit(k, { address: e.target.value })}
                placeholder={copy.addressHint}
                aria-label={copy.address}
                className={`${cell} border-hairline-soft border-l font-mono text-[12px]`}
              />
              <input
                value={t.decimals}
                onChange={(e) => edit(k, { decimals: e.target.value })}
                placeholder="6"
                inputMode="numeric"
                aria-label="Decimals"
                className={`${cell} border-hairline-soft border-l tabular-nums`}
              />
              <button
                onClick={() => onChange(tokens.filter((_, j) => j !== k))}
                aria-label={`Remove ${t.symbol || "token"}`}
                className="text-muted hover:text-ink flex h-full items-center justify-center transition"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The chain's logo on a squircle tile: the only colour in the section. */
export function ChainMark({ family }: { family: ChainFamily }) {
  return (
    <span className="bg-canvas-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-[30%]">
      {family === "evm" ? (
        <svg viewBox="0 0 256 417" className="h-5" aria-hidden>
          <path
            fill="#343434"
            d="M127.9 0 125.1 9.5v275.7l2.8 2.8 127.9-75.6z"
          />
          <path fill="#8C8C8C" d="M127.9 0 0 212.4l127.9 75.6V154.2z" />
          <path
            fill="#3C3C3B"
            d="m127.9 312.2-1.6 1.9v98.2l1.6 4.6L256 236.6z"
          />
          <path fill="#8C8C8C" d="M127.9 416.9V312.2L0 236.6z" />
          <path fill="#141414" d="m127.9 288 127.9-75.6-127.9-58.2z" />
          <path fill="#393939" d="m0 212.4 127.9 75.6V154.2z" />
        </svg>
      ) : (
        <svg viewBox="0 0 398 312" className="h-4" aria-hidden>
          <defs>
            <linearGradient
              id="sol-mark"
              x1="360"
              y1="-37"
              x2="141"
              y2="383"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#00FFA3" />
              <stop offset="1" stopColor="#DC1FFF" />
            </linearGradient>
          </defs>
          <path
            fill="url(#sol-mark)"
            d="M64.6 237.9a13 13 0 0 1 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1zM64.6 3.8A13.4 13.4 0 0 1 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1zM333.1 120.1a13 13 0 0 0-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7a13 13 0 0 0 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1z"
          />
        </svg>
      )}
    </span>
  );
}
