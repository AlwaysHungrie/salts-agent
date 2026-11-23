"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useCardOrder } from "./useCardOrder";

/** One message pack on sale, as the Worker offers it. */
export type MessagePack = {
  messages: number;
  price_usd: number;
  price_inr: number;
};

/** A pack's price as the buyer is charged it: "$10.00", or "₹940" in India. */
const priceOf = (pack: MessagePack, currency: "INR" | "USD") =>
  currency === "INR"
    ? `₹${pack.price_inr.toLocaleString("en-IN")}`
    : `$${pack.price_usd.toFixed(2)}`;

const count = (n: number) => n.toLocaleString("en-US");

/**
 * Recharge WhatsApp for Business messages: pick a pack, pay by card in Razorpay's window.
 * Its messages go on the account's balance, shared by all its agents.
 */
export function MessagePackCheckout({
  packs,
  currency,
  onPaid,
}: {
  packs: MessagePack[];
  currency: "INR" | "USD";
  onPaid: () => void;
}) {
  const [picked, setPicked] = useState(packs[0]);
  const { state, error, pay } = useCardOrder({
    body: { currency, messages: picked.messages },
    description: `${count(picked.messages)} WhatsApp messages`,
    pending:
      "Your payment is still being processed. Your messages will be added once it clears.",
    onPaid,
  });

  if (state === "paid") {
    return (
      <div className="bg-canvas-soft flex items-center gap-3 rounded-2xl px-4 py-4">
        <span className="bg-ink text-on-primary flex h-8 w-8 items-center justify-center rounded-full">
          <Check className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold leading-[1.43]">
          {count(picked.messages)} messages have been added.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Message pack" className="space-y-3">
        {packs.map((pack) => {
          const on = pack.messages === picked.messages;
          return (
            <button
              key={pack.messages}
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(pack)}
              disabled={state !== "idle"}
              className={`flex w-full items-center justify-between gap-4 rounded-[24px] p-5 text-left transition ${
                on ? "ring-ink ring-2" : "ring-hairline-soft hover:ring-ink ring-1"
              }`}
            >
              <span className="text-base font-semibold leading-[1.38]">
                {count(pack.messages)} messages
              </span>
              <span className="text-base font-semibold leading-[1.38]">
                {priceOf(pack, currency)}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-muted mt-4 text-xs leading-[1.33]">
        Each reply your agents send on WhatsApp uses one message. Messages
        customers send you are free. When none are left, your agents stop
        replying.
      </p>
      <button
        onClick={() => void pay()}
        disabled={state !== "idle"}
        className="bg-ink text-on-primary mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
      >
        {state === "idle" ? (
          `Pay ${priceOf(picked, currency)}`
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {state === "checking" ? "Confirming payment…" : "Opening payment…"}
          </>
        )}
      </button>
      <p className="text-muted mt-2 text-center text-xs leading-[1.33]">
        {currency === "INR"
          ? "Card, UPI or netbanking, secured by Razorpay"
          : "Charged in USD, secured by Razorpay"}
      </p>
      {error && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs leading-[1.33] break-words text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
