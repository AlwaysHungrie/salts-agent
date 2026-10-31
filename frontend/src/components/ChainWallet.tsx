"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Lock, Plus, Settings } from "lucide-react";
import {
  ChainMark,
  ChainNetworksDialog,
  type ChainFamily,
  type ChainNetwork,
} from "@/components/ChainNetworksDialog";

type Wallet = { evm: string; solana: string; networks: ChainNetwork[] };

/** Which network the dialog is open on: an existing one, or a new one for a chain. */
type Editing = { family: ChainFamily; network?: ChainNetwork };

const CHAINS: { family: ChainFamily; name: string; hint: string }[] = [
  { family: "evm", name: "EVM", hint: "Ethereum, Base and other EVM chains" },
  { family: "solana", name: "Solana", hint: "Solana mainnet and devnet" },
];

const short = (address: string) =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

/**
 * The wallet's page on a network's explorer: `/address/<address>` after the explorer's
 * path, keeping its query (`?cluster=devnet`). Undefined when there is no explorer.
 */
const explorerLink = (explorer: string, address: string) => {
  if (!explorer) return undefined;
  try {
    const url = new URL(explorer);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/address/${address}`;
    return url.toString();
  } catch {
    return undefined;
  }
};

/**
 * The agent's wallet: one address per chain and its balances on the networks the owner
 * set up. The wallet is made on first read while the capability is on, and the switch's
 * save may still be in flight when this mounts, so a refusal is asked again a few times
 * before it is shown. The private key never reaches the browser.
 */
export function ChainWallet({ agentId }: { agentId: string }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      for (let attempt = 0; attempt < 4 && live; attempt++) {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(agentId)}/chain-wallet`,
        ).catch(() => null);
        if (res?.ok) {
          const body = (await res.json()) as Wallet;
          if (live) setWallet(body);
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (live) setError(true);
    })();
    return () => {
      live = false;
    };
  }, [agentId]);

  if (error)
    return (
      <p className="text-muted text-xs leading-[1.33]">
        Couldn&rsquo;t load the wallet. Refresh the page to try again.
      </p>
    );
  if (!wallet)
    return <p className="text-muted text-xs leading-[1.33]">Loading wallet…</p>;
  return (
    <>
      <div className="border-hairline overflow-hidden rounded-3xl border">
        <div className="bg-canvas-soft flex items-center justify-between gap-3 px-5 py-3">
          <span className="text-sm font-semibold">Agent wallet</span>
          <Lock
            size={13}
            strokeWidth={2}
            className="text-muted"
            aria-label="Private key never shown"
          />
        </div>
        <div className="divide-hairline-soft divide-y">
          {CHAINS.map((chain) => (
            <ChainBlock
              key={chain.family}
              chain={chain}
              address={wallet[chain.family]}
              networks={wallet.networks.filter(
                (n) => n.family === chain.family,
              )}
              onEdit={(network) =>
                setEditing({ family: chain.family, network })
              }
            />
          ))}
        </div>
      </div>
      {editing && (
        <ChainNetworksDialog
          agentId={agentId}
          family={editing.family}
          network={editing.network}
          networks={wallet.networks}
          onClose={() => setEditing(null)}
          onSaved={(networks) => {
            setWallet({ ...wallet, networks });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** One chain: its mark, its address and the networks balances are read on. */
function ChainBlock({
  chain,
  address,
  networks,
  onEdit,
}: {
  chain: (typeof CHAINS)[number];
  address: string;
  networks: ChainNetwork[];
  onEdit: (network?: ChainNetwork) => void;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-3">
        <ChainMark family={chain.family} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-[1.3]">{chain.name}</p>
          <p className="text-muted truncate text-xs leading-[1.33]">
            {chain.hint}
          </p>
        </div>
        <CopyAddress label={chain.name} address={address} />
      </div>

      <div className="mt-3 space-y-1 pl-12">
        {networks.map((network) => (
          <NetworkRow
            key={network.id}
            network={network}
            address={address}
            onEdit={() => onEdit(network)}
          />
        ))}
        <button
          onClick={() => onEdit()}
          className="text-muted hover:text-ink -ml-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold transition"
        >
          <Plus size={12} strokeWidth={2.5} aria-hidden /> Add network
        </button>
      </div>
    </div>
  );
}

/** A configured network: its name, a link to the wallet on its explorer, its settings. */
function NetworkRow({
  network,
  address,
  onEdit,
}: {
  network: ChainNetwork;
  address: string;
  onEdit: () => void;
}) {
  const explorer = explorerLink(network.explorer_url, address);
  return (
    <div className="group hover:bg-canvas-soft -mx-3 flex items-center gap-3 rounded-2xl px-3 py-1.5 transition">
      <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[1.38]">
        {network.name}
      </p>
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open on ${network.name} explorer`}
          title="Open in explorer"
          className="text-muted hover:text-ink shrink-0 rounded-lg p-1.5 opacity-60 transition group-hover:opacity-100"
        >
          <ExternalLink size={13} strokeWidth={2} />
        </a>
      )}
      <button
        onClick={onEdit}
        aria-label={`${network.name} settings`}
        className="text-muted hover:text-ink shrink-0 rounded-lg p-1.5 opacity-60 transition group-hover:opacity-100"
      >
        <Settings size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/** The short address in a pill; the whole address is what is copied. */
function CopyAddress({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access denied: the full address is in the tooltip.
    }
  };
  return (
    <button
      onClick={copy}
      title={address}
      aria-label={`Copy ${label} address`}
      className="bg-canvas-soft hover:bg-field text-ink inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 font-mono text-xs transition"
    >
      {short(address)}
      {copied ? (
        <Check size={12} strokeWidth={2.5} aria-hidden />
      ) : (
        <Copy size={12} strokeWidth={2} className="text-muted" aria-hidden />
      )}
    </button>
  );
}
