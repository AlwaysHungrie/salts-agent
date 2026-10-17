import { useState } from "react";
import dynamic from "next/dynamic";
import type { PayNetwork } from "@/lib/agent";
import type { CheckoutCalls } from "./CryptoCheckout";

/** The credit amounts offered with one click, in US dollars. */
const PRESETS = [10, 25, 50, 100];

/** Wallet payments need Reown's project id; without one the screen offers none. */
export const WALLETS_ON = !!process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

// The wallet libraries are heavy and browser-only, so they load with this view.
const CryptoCheckout = dynamic(() => import("./CryptoCheckout"), {
  ssr: false,
  loading: () => <p className="text-muted text-sm leading-[1.43]">Loading wallets…</p>,
});

/**
 * Buying credit with crypto, inside the wallet sidebar: a new key for the wallet, or more
 * credit on a bought one.
 */
export function BuyCredits({
  networks,
  calls,
  onPaid,
}: {
  networks: PayNetwork[];
  /** The checkout's calls, with the amount still to be added to each quote. */
  calls: {
    quote: (
      body: Parameters<CheckoutCalls["quote"]>[0] & { amount: number },
    ) => ReturnType<CheckoutCalls["quote"]>;
    confirm: CheckoutCalls["confirm"];
  };
  onPaid: () => void;
}) {
  /** A preset, or null while a custom amount is being typed. */
  const [preset, setPreset] = useState<number | null>(PRESETS[0]);
  const [custom, setCustom] = useState("");

  const amount = preset ?? Number(custom);
  const valid = Number.isFinite(amount) && amount >= 1 && amount <= 10_000;

  const tile = (active: boolean) =>
    `h-11 rounded-xl border text-sm font-semibold transition ${
      active ? "border-ink ring-ink ring-1" : "border-hairline hover:border-ink/40"
    }`;

  return (
    <div>
      <p className="text-muted mb-2 text-xs font-medium">Amount</p>
      <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Amount">
        {PRESETS.map((usd) => (
          <button
            key={usd}
            role="radio"
            aria-checked={preset === usd}
            onClick={() => setPreset(usd)}
            className={tile(preset === usd)}
          >
            ${usd}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={preset === null}
          onClick={() => setPreset(null)}
          className={tile(preset === null)}
        >
          Other
        </button>
      </div>

      {preset === null && (
        <label className="border-hairline focus-within:border-ink mt-2 flex h-11 items-center gap-1 rounded-xl border px-4 text-sm transition">
          <span className="text-muted">$</span>
          <input
            type="number"
            min={1}
            max={10000}
            step={1}
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Amount in US dollars"
            className="placeholder:text-faint min-w-0 flex-1 bg-transparent outline-none"
            placeholder="40"
          />
          <span className="text-faint text-xs">$1 – $10,000</span>
        </label>
      )}

      <p className="text-muted mt-6 mb-2 text-xs font-medium">Pay from</p>
      {!WALLETS_ON || networks.length === 0 ? (
        <p className="text-muted text-sm leading-[1.43]">Wallet payments aren&apos;t open yet.</p>
      ) : !valid ? (
        <p className="text-muted text-sm leading-[1.43]">Enter an amount from $1 to $10,000.</p>
      ) : (
        <CryptoCheckout
          amount={amount}
          networks={networks}
          calls={{
            quote: (body) => calls.quote({ ...body, amount }),
            confirm: calls.confirm,
          }}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}
