"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Wallet } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";
import {
  type Provider as SolanaProvider,
  useAppKitConnection,
} from "@reown/appkit-adapter-solana/react";
import type { Connection } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { erc20Abi, formatUnits } from "viem";
import {
  useBalance,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWriteContract,
  WagmiProvider,
} from "wagmi";
import type { PayNetwork, PayQuote } from "@/lib/agent";
import { wagmiAdapter } from "./appkit";
import { PAY_TITLE, Step, supported } from "./BuyCredits";

const queryClient = new QueryClient();

/** Asks the Worker for a quote, and to count a sent payment. */
export type CheckoutCalls = {
  quote: (body: {
    network: string;
    asset: string;
    payer: string;
  }) => Promise<PayQuote | string>;
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
  /** What the buyer pays, credit plus fee; null while the amount isn't valid. */
  total: number | null;
  networks: PayNetwork[];
  calls: CheckoutCalls;
  onPaid: () => void;
  /** Told when a payment starts (and stays started once paid), so the amount is locked. */
  onLock: (locked: boolean) => void;
}) {
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Checkout {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// eslint-disable-next-line max-lines-per-function
function Checkout({
  total,
  networks,
  calls,
  onPaid,
  onLock,
}: {
  total: number | null;
  networks: PayNetwork[];
  calls: CheckoutCalls;
  onPaid: () => void;
  onLock: (locked: boolean) => void;
}) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const evm = useAppKitAccount({ namespace: "eip155" });
  const sol = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: solanaWallet } =
    useAppKitProvider<SolanaProvider>("solana");
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
  // The quote is for this amount: changing it mid-payment would show one and charge another.
  useEffect(() => onLock(stage !== "idle"), [stage, onLock]);
  const [error, setError] = useState<string | null>(null);

  const network = choices.find((n) => n.id === networkId) ?? choices[0];
  const coin = network?.assets.includes(asset) ? asset : "usdc";

  /** Send exactly what the quote asks for, from the connected wallet. */
  const send = async (q: PayQuote): Promise<string> => {
    if (q.family === "solana") {
      if (!solanaWallet || !connection || !q.token)
        throw new Error("Reconnect your wallet.");
      const owner = new PublicKey(payer);
      const mint = new PublicKey(q.token);
      const to = new PublicKey(q.to);
      const destination = getAssociatedTokenAddressSync(mint, to);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          destination,
          to,
          mint,
        ),
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

  const busy = stage !== "idle";

  const step = (
    <PayStep
      networks={networks}
      payer={family ? payer : null}
      busy={busy}
      onChange={() => void disconnect()}
    />
  );

  if (stage === "paid")
    return (
      <>
        {step}
        <Paid />
      </>
    );

  if (!family)
    return (
      <>
        {step}
        <button
          onClick={() => void open({ view: "Connect" })}
          className="bg-ink text-on-primary flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85"
        >
          <Wallet className="h-4 w-4" /> Connect wallet
        </button>
      </>
    );

  return (
    <div>
      {step}
      {choices.length === 0 ? (
        <p className="text-muted mt-4 text-sm leading-[1.43]">
          Payments from this wallet aren&apos;t open yet. Connect another
          wallet.
        </p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-[1fr_auto] gap-2">
            <label className="min-w-0">
              <span className="relative block">
                <select
                  value={network?.id ?? ""}
                  disabled={busy}
                  onChange={(e) => setNetworkId(e.target.value)}
                  className="border-hairline focus:border-ink h-11 w-full appearance-none rounded-xl border bg-transparent pr-9 pl-3 text-sm font-semibold outline-none"
                >
                  {choices.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="text-muted pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2" />
              </span>
            </label>
            <div>
              <div
                className="bg-field flex h-11 rounded-xl p-1"
                role="radiogroup"
                aria-label="Coin"
              >
                {(network?.assets ?? ["usdc"]).map((a) => (
                  <button
                    key={a}
                    role="radio"
                    aria-checked={coin === a}
                    disabled={busy}
                    onClick={() => setAsset(a)}
                    className={`rounded-lg px-4 text-sm font-semibold transition ${
                      coin === a
                        ? "bg-canvas shadow-sm"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {network && (
            <Balance
              network={network}
              coin={coin}
              payer={payer}
              total={total}
              connection={connection ?? null}
            />
          )}

          <button
            onClick={() => void pay()}
            disabled={busy || !network || total === null}
            className="bg-ink text-on-primary mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {stage === "sign"
              ? "Approve in your wallet…"
              : stage === "wait"
                ? "Waiting for the network…"
                : total === null
                  ? "Enter an amount"
                  : `Pay $${total.toFixed(2)} in ${coin.toUpperCase()}`}
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

/** Step 2's heading: what can be paid with, or the connected wallet and a way to change it. */
function PayStep({
  networks,
  payer,
  busy,
  onChange,
}: {
  networks: PayNetwork[];
  /** The connected address; null before a wallet connects. */
  payer: string | null;
  busy: boolean;
  onChange: () => void;
}) {
  return (
    <Step
      title={PAY_TITLE}
      hint={
        // Once a payment starts the line goes: no "change" to log the wallet out mid-payment.
        busy ? undefined : payer ? (
          <>
            Wallet connected{" "}
            <span className="text-ink font-mono text-[13px] font-medium tracking-wide">
              {payer.slice(0, 6)}…{payer.slice(-4)}
            </span>{" "}
            (
            <button onClick={onChange} className="hover:text-ink underline transition">
              change
            </button>
            )
          </>
        ) : (
          supported(networks)
        )
      }
    />
  );
}

function Paid() {
  return (
    <div className="bg-canvas-soft flex items-center gap-3 rounded-2xl px-4 py-4">
      <span className="bg-ink text-on-primary flex h-8 w-8 items-center justify-center rounded-full">
        <Check className="h-4 w-4" />
      </span>
      <p className="text-sm font-semibold leading-[1.43]">
        Payment received. Your key is in your wallet.
      </p>
    </div>
  );
}

/** Chainlink's ETH/USD feed on Ethereum mainnet (8 decimals), as the Worker prices ETH. */
const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/**
 * What the connected wallet holds of the chosen coin on the chosen network, and whether
 * it covers the total. ETH is valued at the same feed the Worker quotes from.
 */
function Balance({
  network,
  coin,
  payer,
  total,
  connection,
}: {
  network: PayNetwork;
  coin: "usdc" | "eth";
  payer: string;
  total: number | null;
  connection: Connection | null;
}) {
  const evm = network.family === "evm";
  const address = payer as `0x${string}`;
  const eth = useBalance({
    address,
    chainId: network.chain_id,
    query: { enabled: evm && coin === "eth" },
  });
  const usdc = useReadContract({
    address: network.usdc as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: network.chain_id,
    query: { enabled: evm && coin === "usdc" },
  });
  const price = useReadContract({
    address: ETH_USD_FEED,
    abi: FEED_ABI,
    functionName: "latestRoundData",
    chainId: 1,
    query: { enabled: evm && coin === "eth" },
  });
  const sol = useSolanaUsdc(evm ? null : connection, payer, network.usdc);

  const held = !evm
    ? sol
    : coin === "eth"
      ? eth.data && Number(formatUnits(eth.data.value, 18))
      : usdc.data !== undefined
        ? Number(formatUnits(usdc.data, 6))
        : undefined;
  if (held === undefined || held === null) return null;

  const usd =
    coin === "eth"
      ? price.data
        ? (held * Number(price.data[1])) / 1e8
        : null
      : held;
  const short = total !== null && usd !== null && usd < total;
  const shown =
    coin === "eth"
      ? `${held.toFixed(4)} ETH${usd !== null ? ` ($${usd.toFixed(2)})` : ""}`
      : `${held.toFixed(2)} USDC`;

  return (
    <p
      className={`mt-2 text-xs leading-[1.33] ${short ? "text-red-600" : "text-muted"}`}
    >
      {short
        ? `Insufficient funds. Current balance ${shown}`
        : `Current balance ${shown}`}
    </p>
  );
}

/** The wallet's USDC on Solana; 0 when it has no USDC account, null while loading. */
function useSolanaUsdc(
  connection: Connection | null,
  payer: string,
  mint: string,
) {
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (!connection || !payer) return;
    let live = true;
    const account = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(payer),
    );
    connection
      .getTokenAccountBalance(account)
      .then((r) => live && setHeld(r.value.uiAmount ?? 0))
      .catch(() => live && setHeld(0));
    return () => {
      live = false;
    };
  }, [connection, payer, mint]);
  return held;
}

/** Check a sent payment until the Worker counts it, or gives up waiting: null once paid. */
async function settle(
  confirm: CheckoutCalls["confirm"],
  id: string,
  tx: string,
) {
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
  if (/reject|denied|cancel/i.test(message))
    return "The payment was cancelled in your wallet.";
  if (/insufficient/i.test(message))
    return "This wallet doesn't hold enough to pay that.";
  return `Your wallet couldn't send the payment: ${message.split("\n")[0]}`;
}
