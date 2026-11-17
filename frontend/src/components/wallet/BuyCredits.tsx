import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import dynamic from "next/dynamic";
import type { PayNetwork } from "@/lib/agent";
import type { CardRange } from "./useWallet";
import type { CheckoutCalls } from "./CryptoCheckout";
import { type CardCalls, CardCheckout } from "./CardCheckout";

/** The credit amounts offered with one click, in US dollars. */
const PRESETS = [5, 10, 25, 50];

/** The most credit one payment buys, in US dollars. */

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

/** What a finished payment shows, by card or crypto. */
export function Paid() {
  return (
    <div className="bg-canvas-soft flex items-center gap-3 rounded-2xl px-4 py-4">
      <span className="bg-ink text-on-primary flex h-8 w-8 items-center justify-center rounded-full">
        <Check className="h-4 w-4" />
      </span>
      <p className="text-sm font-semibold leading-[1.43]">
        Your key has been added to your wallet.
      </p>
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

/** Rupees to two places, as India writes them. */
const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Buying a new key with crypto, or by card when `card` is given, inside the wallet sidebar. The buyer sees the credit, the
 * service fee and the total before anything is asked of their wallet.
 */
export function BuyCredits({
  networks,
  feeBps,
  maxUsd,
  reownProjectId,
  calls,
  card,
  onPaid,
}: {
  networks: PayNetwork[];
  /** The service fee, in basis points of the credit. */
  feeBps: number;
  /** The most credit one purchase may buy, in dollars. */
  maxUsd: number;
  /** Reown's project id, set from the admin CLI; blank leaves wallet payments off. */
  reownProjectId: string;
  /** The checkout's calls, with the amount still to be added to each quote. */
  calls: {
    quote: (
      body: Parameters<CheckoutCalls["quote"]>[0] & { amount: number },
    ) => ReturnType<CheckoutCalls["quote"]>;
    confirm: CheckoutCalls["confirm"];
  };
  /** Pay by card or UPI through Razorpay instead, choosing the credit in rupees. */
  card?: {
    inrPerUsd: number;
    /** The Indian range and quick picks, in whole rupees. */
    range: CardRange;
    order: (amountInr: number) => ReturnType<CardCalls["order"]>;
    confirm: CardCalls["confirm"];
  };
  onPaid: () => void;
}) {
  // By card the credit is chosen in whole rupees; by crypto, in dollars.
  const rate = card?.inrPerUsd ?? 0;
  const presets = card ? card.range.presets : PRESETS;
  const min = card ? card.range.min : 1;
  const max = card ? card.range.max : maxUsd;
  const money = card ? inr : usd;
  const [text, setText] = useState(
    String(card ? card.range.start : presets[0]),
  );
  /** A payment is under way or done: the amount it was quoted for is no longer asked. */
  const [locked, setLocked] = useState(false);

  const amount = Number(text);
  const valid =
    text.trim() !== "" &&
    Number.isFinite(amount) &&
    (!card || Number.isInteger(amount)) &&
    amount >= min &&
    amount <= max;
  // The Worker's rounding: the fee to the cent (or paisa) above.
  const fee = valid
    ? Math.ceil((Math.round(amount * 100) * feeBps) / 10_000) / 100
    : 0;
  const total = valid ? Math.round((amount + fee) * 100) / 100 : 0;
  // What a card payment comes to in dollars, for reference.
  const totalUsd = card && valid ? Math.round((total * 100) / rate) / 100 : 0;

  return (
    <div>
      {!locked && (
        <>
          <Step title="Credit" />
          <label className="border-hairline focus-within:border-ink flex h-14 items-center gap-1 rounded-2xl border px-4 transition">
            <span className="text-muted text-2xl font-semibold">
              {card ? "₹" : "$"}
            </span>
            <input
              type="number"
              inputMode={card ? "numeric" : "decimal"}
              min={min}
              max={max}
              step={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={card ? "Credit in rupees" : "Credit in US dollars"}
              className="placeholder:text-faint min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              placeholder="0"
            />
            <span className="text-faint text-xs font-semibold">
              {card ? "INR" : "USD"}
            </span>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {presets
              .filter((p) => p <= max)
              .map((p) => (
                <button
                  key={p}
                  onClick={() => setText(String(p))}
                  className={`h-7 rounded-full px-3 text-xs font-semibold transition ${
                    amount === p
                      ? "bg-ink text-on-primary"
                      : "bg-canvas-soft hover:bg-hairline"
                  }`}
                >
                  {card ? `₹${p.toLocaleString("en-IN")}` : `$${p}`}
                </button>
              ))}
            <span
              className={`ml-auto text-xs ${valid || !text ? "text-faint" : "text-red-600"}`}
            >
              {card ? `Max ₹${max.toLocaleString("en-IN")}` : `Max $${max}`}
            </span>
          </div>
        </>
      )}

      <div
        className={`bg-canvas-soft rounded-2xl ${locked ? "" : "mt-4"} px-4 py-3 text-sm leading-[1.43]`}
      >
        <div className="flex justify-between">
          <span className="text-muted">Credit added to your key</span>
          <span>{valid ? money(amount) : "—"}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Service fee ({feeBps / 100}%)</span>
          <span>{valid ? money(fee) : "—"}</span>
        </div>
        <div className="border-hairline mt-2 flex justify-between border-t pt-2 font-semibold">
          <span>You pay</span>
          <span>{valid ? money(total) : "—"}</span>
        </div>
        {card && (
          <div className="mt-1 flex justify-between">
            <span className="text-muted">In USD</span>
            <span>{valid ? usd(totalUsd) : "—"}</span>
          </div>
        )}
        <p className="text-muted mt-4 text-xs leading-[1.5]">
          {card ? (
            <>
              Credits once issued cannot be transferred or refunded. Your
              purchase is subject to our{" "}
              <a
                href="https://salts.dev/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-ink underline"
              >
                terms and conditions
              </a>
              .
            </>
          ) : (
            "The service fee covers network, routing and crypto payment costs. Your key is issued as soon as your payment is confirmed."
          )}
        </p>
      </div>

      <div className="mt-8">
        {card ? (
          <CardCheckout
            total={valid ? total : null}
            calls={{ order: () => card.order(amount), confirm: card.confirm }}
            onPaid={onPaid}
            onLock={setLocked}
          />
        ) : !reownProjectId || networks.length === 0 ? (
          <>
            <Step title={PAY_TITLE} />
            <p className="text-muted text-sm leading-[1.43]">
              Wallet payments aren&apos;t open yet.
            </p>
          </>
        ) : (
          <CryptoCheckout
            projectId={reownProjectId}
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
