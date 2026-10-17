"use client";

import { useState } from "react";
import { Check, Loader2, Wallet } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from "@reown/appkit/react";
import { type Provider as SolanaProvider, useAppKitConnection } from "@reown/appkit-adapter-solana/react";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { erc20Abi } from "viem";
import { useSendTransaction, useSwitchChain, useWriteContract, WagmiProvider } from "wagmi";
import type { PayNetwork, PayQuote } from "@/lib/agent";
import { wagmiAdapter } from "./appkit";

const queryClient = new QueryClient();

/** Asks the Worker for a quote, and to count a sent payment. */
export type CheckoutCalls = {
  quote: (body: { network: string; asset: string; payer: string }) => Promise<PayQuote | string>;
  confirm: (id: string, tx: string) => Promise<"paid" | "pending" | string>;
};

/** How often, and for how long, a sent payment is checked before the buyer is told to wait. */
const POLL_MS = 4000;
const POLL_FOR_MS = 15 * 60 * 1000;

/**
 * Pay from the buyer's own wallet: connect, choose the coin and network, send. The
 * Worker reads the transaction back from the chain before it counts.
 */
export default function CryptoCheckout(props: {
  amount: number;
  networks: PayNetwork[];
  calls: CheckoutCalls;
  onPaid: () => void;
}) {
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Checkout {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Checkout({
  amount,
  networks,
  calls,
  onPaid,
}: {
  amount: number;
  networks: PayNetwork[];
  calls: CheckoutCalls;
  onPaid: () => void;
}) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const evm = useAppKitAccount({ namespace: "eip155" });
  const sol = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: solanaWallet } = useAppKitProvider<SolanaProvider>("solana");
  const { connection } = useAppKitConnection();
  const switchChain = useSwitchChain();
  const sendTransaction = useSendTransaction();
  const writeContract = useWriteContract();

  const family = evm.isConnected ? "evm" : sol.isConnected ? "solana" : null;
  const payer = (family === "evm" ? evm.address : sol.address) ?? "";
  const choices = networks.filter((n) => n.family === family);

  const [networkId, setNetworkId] = useState("");
  const [asset, setAsset] = useState<"usdc" | "eth">("usdc");
  const [stage, setStage] = useState<"idle" | "sign" | "wait" | "paid">("idle");
  const [error, setError] = useState<string | null>(null);

  const network = choices.find((n) => n.id === networkId) ?? choices[0];
  const coin = network?.assets.includes(asset) ? asset : "usdc";

  /** Send exactly what the quote asks for, from the connected wallet. */
  const send = async (q: PayQuote): Promise<string> => {
    if (q.family === "solana") {
      if (!solanaWallet || !connection || !q.token) throw new Error("Reconnect your wallet.");
      const owner = new PublicKey(payer);
      const mint = new PublicKey(q.token);
      const to = new PublicKey(q.to);
      const destination = getAssociatedTokenAddressSync(mint, to);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(owner, destination, to, mint),
        createTransferCheckedInstruction(
          getAssociatedTokenAddressSync(mint, owner),
          mint,
          destination,
          owner,
          BigInt(q.units),
          q.decimals,
        ),
      );
      tx.feePayer = owner;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      return await solanaWallet.sendTransaction(tx, connection);
    }
    await switchChain.mutateAsync({ chainId: q.chain_id });
    if (q.asset === "eth") {
      return await sendTransaction.mutateAsync({
        to: q.to as `0x${string}`,
        value: BigInt(q.units),
        chainId: q.chain_id,
      });
    }
    return await writeContract.mutateAsync({
      address: q.token as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [q.to as `0x${string}`, BigInt(q.units)],
      chainId: q.chain_id,
    });
  };

  const pay = async () => {
    if (!network) return;
    setError(null);
    setStage("sign");
    const q = await calls.quote({ network: network.id, asset: coin, payer });
    if (typeof q === "string") {
      setError(q);
      setStage("idle");
      return;
    }
    let tx: string;
    try {
      tx = await send(q);
    } catch (err) {
      setError(declined(err));
      setStage("idle");
      return;
    }
    setStage("wait");
    const failed = await settle(calls.confirm, q.id, tx);
    if (failed) {
      setError(failed);
      setStage("idle");
      return;
    }
    setStage("paid");
    onPaid();
  };

  if (stage === "paid") return <Paid />;

  if (!family)
    return (
      <button
        onClick={() => void open({ view: "Connect" })}
        className="bg-ink text-on-primary flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85"
      >
        <Wallet className="h-4 w-4" /> Connect wallet
      </button>
    );

  const busy = stage !== "idle";

  return (
    <div>
      <div className="bg-canvas-soft flex h-12 items-center justify-between gap-3 rounded-2xl px-4 text-sm leading-[1.43]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate font-mono text-[13px]">
            {payer.slice(0, 6)}…{payer.slice(-4)}
          </span>
        </span>
        <button
          onClick={() => void disconnect()}
          disabled={busy}
          className="text-muted hover:text-ink shrink-0 text-xs font-semibold transition disabled:opacity-40"
        >
          Change
        </button>
      </div>

      {choices.length === 0 ? (
        <p className="text-muted mt-4 text-sm leading-[1.43]">
          Payments from this wallet aren&apos;t open yet. Connect another wallet.
        </p>
      ) : (
        <>
          <p className="text-muted mt-5 mb-2 text-xs font-medium">Network</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Network">
            {choices.map((n) => (
              <button
                key={n.id}
                role="radio"
                aria-checked={network?.id === n.id}
                disabled={busy}
                onClick={() => setNetworkId(n.id)}
                className={`h-10 truncate rounded-xl border px-2 text-sm font-semibold transition disabled:opacity-60 ${
                  network?.id === n.id
                    ? "border-ink ring-ink ring-1"
                    : "border-hairline hover:border-ink/40"
                }`}
              >
                {n.label}
              </button>
            ))}
          </div>

          {network && network.assets.length > 1 && (
            <>
              <p className="text-muted mt-5 mb-2 text-xs font-medium">Token</p>
              <div className="bg-field inline-flex rounded-full p-1" role="radiogroup" aria-label="Token">
                {network.assets.map((a) => (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={coin === a}
                    disabled={busy}
                    onClick={() => setAsset(a)}
                    className={`h-8 rounded-full px-5 text-sm font-semibold transition ${
                      coin === a ? "bg-canvas shadow-sm" : "text-muted hover:text-ink"
                    }`}
                  >
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="border-hairline-soft mt-6 flex items-baseline justify-between border-t pt-4">
            <span className="text-muted text-sm">Total</span>
            <span className="text-right">
              <span className="text-lg font-semibold">${amount}</span>
              <span className="text-muted ml-1.5 text-xs">
                in {coin.toUpperCase()} on {network?.label}
              </span>
            </span>
          </div>

          <button
            onClick={() => void pay()}
            disabled={busy || !network}
            className="bg-ink text-on-primary mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {stage === "sign"
              ? "Confirm in your wallet…"
              : stage === "wait"
                ? "Confirming payment…"
                : `Pay $${amount}`}
          </button>
        </>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs leading-[1.33] break-words text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function Paid() {
  return (
    <div className="bg-canvas-soft flex items-center gap-3 rounded-2xl px-4 py-4">
      <span className="bg-ink text-on-primary flex h-8 w-8 items-center justify-center rounded-full">
        <Check className="h-4 w-4" />
      </span>
      <p className="text-sm font-semibold leading-[1.43]">Payment received.</p>
    </div>
  );
}

/** Check a sent payment until the Worker counts it, or gives up waiting: null once paid. */
async function settle(confirm: CheckoutCalls["confirm"], id: string, tx: string) {
  const until = Date.now() + POLL_FOR_MS;
  while (Date.now() < until) {
    const verdict = await confirm(id, tx);
    if (verdict === "paid") return null;
    if (verdict !== "pending") return verdict;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return `The network hasn't confirmed your payment yet. Keep this transaction id to follow up: ${tx}`;
}

/** A wallet's refusal, in a sentence: most are the buyer pressing reject. */
function declined(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel/i.test(message)) return "The payment was cancelled in your wallet.";
  if (/insufficient/i.test(message)) return "This wallet doesn't hold enough to pay that.";
  return `Your wallet couldn't send the payment: ${message.split("\n")[0]}`;
}
