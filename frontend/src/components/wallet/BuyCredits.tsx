import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { PayNetwork } from "@/lib/agent";
import type { CheckoutCalls } from "./CryptoCheckout";

/** The credit amounts offered with one click, in US dollars. */
const PRESETS = [5, 10, 25, 50];

/** The most credit one payment buys, in US dollars. */

/** Wallet payments need Reown's project id; without one the screen offers none. */
export const WALLETS_ON = !!process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

// The wallet libraries are heavy and browser-only, so they load with this view.
const CryptoCheckout = dynamic(() => import("./CryptoCheckout"), {
  ssr: false,
  loading: () => (
    <p className="text-muted text-sm leading-[1.43]">Loading wallets…</p>
  ),
});

/** One numbered step of the checkout: its number, a title, and a line on what it's for. */
export function Step({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-[1.43]">{title}</p>
        {hint && (
          <div className="text-muted mt-1 text-xs leading-[1.33]">{hint}</div>
        )}
      </div>
    </div>
  );
}

/** Step 2's title, shared with the checkout that renders it once wallets load. */
export const PAY_TITLE = "Connect your crypto wallet";

/** What can be paid with, from the open networks: "USDC or ETH on Ethereum, Base or Solana". */
export function supported(networks: PayNetwork[]): string {
  const or = (xs: string[]) =>
    xs.length < 2
      ? xs.join("")
      : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
  const coins = [...new Set(networks.flatMap((n) => n.assets))].map((a) =>
    a.toUpperCase(),
  );
  return `${or(coins)} on ${or(networks.map((n) => n.label))}`;
}

/** Dollars to two places. */
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Buying a new key with crypto, inside the wallet sidebar. The buyer sees the credit, the
 * service fee and the total before anything is asked of their wallet.
 */
export function BuyCredits({
  networks,
  feeBps,
  maxUsd,
  calls,
  onPaid,
}: {
  networks: PayNetwork[];
  /** The service fee, in basis points of the credit. */
  feeBps: number;
  /** The most credit one purchase may buy, in dollars. */
  maxUsd: number;
  /** The checkout's calls, with the amount still to be added to each quote. */
  calls: {
    quote: (
      body: Parameters<CheckoutCalls["quote"]>[0] & { amount: number },
    ) => ReturnType<CheckoutCalls["quote"]>;
    confirm: CheckoutCalls["confirm"];
  };
  onPaid: () => void;
}) {
  const [text, setText] = useState(String(PRESETS[0]));
  /** A payment is under way or done: the amount it was quoted for is no longer asked. */
  const [locked, setLocked] = useState(false);

  const amount = Number(text);
  const valid =
    text.trim() !== "" &&
    Number.isFinite(amount) &&
    amount >= 1 &&
    amount <= maxUsd;
  // The Worker's rounding: the fee to the cent above.
  const fee = valid
    ? Math.ceil((Math.round(amount * 100) * feeBps) / 10_000) / 100
    : 0;
  const total = valid ? Math.round((amount + fee) * 100) / 100 : 0;

  return (
    <div>
      {!locked && (
        <>
          <Step title="LLM Credits" />
          <label className="border-hairline focus-within:border-ink flex h-14 items-center gap-1 rounded-2xl border px-4 transition">
            <span className="text-muted text-2xl font-semibold">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={maxUsd}
              step={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Credit in US dollars"
              className="placeholder:text-faint min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              placeholder="0"
            />
            <span className="text-faint text-xs font-semibold">USD</span>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {PRESETS.filter((p) => p <= maxUsd).map((p) => (
              <button
                key={p}
                onClick={() => setText(String(p))}
                className={`h-7 rounded-full px-3 text-xs font-semibold transition ${
                  amount === p
                    ? "bg-ink text-on-primary"
                    : "bg-canvas-soft hover:bg-hairline"
                }`}
              >
                ${p}
              </button>
            ))}
            <span
              className={`ml-auto text-xs ${valid || !text ? "text-faint" : "text-red-600"}`}
            >
              Max ${maxUsd}
            </span>
          </div>
        </>
      )}

      <div
        className={`bg-canvas-soft rounded-2xl ${locked ? "" : "mt-4"} px-4 py-3 text-sm leading-[1.43]`}
      >
        <div className="flex justify-between">
          <span className="text-muted">Credit added to your key</span>
          <span>{valid ? usd(amount) : "—"}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Service fee ({feeBps / 100}%)</span>
          <span>{valid ? usd(fee) : "—"}</span>
        </div>
        <div className="border-hairline mt-2 flex justify-between border-t pt-2 font-semibold">
          <span>You pay</span>
          <span>{valid ? usd(total) : "—"}</span>
        </div>
        <p className="text-muted mt-2 text-xs leading-[1.33]">
          The service fee helps us cover the network and routing costs and
          crypto payment processing fees. We can only issue a key if we have
          received confirmation of payment from your wallet.
        </p>
      </div>

      <div className="mt-8">
        {!WALLETS_ON || networks.length === 0 ? (
          <>
            <Step title={PAY_TITLE} />
            <p className="text-muted text-sm leading-[1.43]">
              Wallet payments aren&apos;t open yet.
            </p>
          </>
        ) : (
          <CryptoCheckout
            total={valid ? total : null}
            networks={networks}
            calls={{
              quote: (body) => calls.quote({ ...body, amount }),
              confirm: calls.confirm,
            }}
            onPaid={onPaid}
            onLock={setLocked}
          />
        )}
      </div>
    </div>
  );
}
