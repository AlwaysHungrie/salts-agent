"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { loadCheckout } from "@/components/wallet/CardCheckout";

/** What buying a number costs here, as the Worker offers it. */
export type NumberOffer = {
  price_usd: number;
  price_inr: number;
  term_months: number;
  /** Razorpay's key id; blank while buying is closed. */
  razorpay_key_id: string;
  /** Set by the Next route from the caller's IP country. */
  card_currency: "INR" | "USD";
};

type NumberOrder = {
  id: string;
  key_id: string;
  order_id: string;
  currency: "INR" | "USD";
  amount: number;
  email: string;
};

/** How often, and for how long, a payment is checked before the buyer is told to wait. */
const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60 * 1000;

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? fallback;
}

/** The price as the buyer is charged it: "$10.00", or "₹940" in India. */
export function priceOf(offer: NumberOffer): string {
  return offer.card_currency === "INR"
    ? `₹${offer.price_inr.toLocaleString("en-IN")}`
    : `$${offer.price_usd.toFixed(2)}`;
}

/**
 * Pay by card in Razorpay's window for a US number. The Worker reads the payment back
 * from Razorpay before it counts, then buys the number.
 */
export function NumberCheckout({
  offer,
  onPaid,
}: {
  offer: NumberOffer;
  onPaid: () => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "checking" | "paid">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const months = `${offer.term_months} ${offer.term_months === 1 ? "month" : "months"}`;

  const finish = async (order: NumberOrder, paymentId: string) => {
    setState("checking");
    const until = Date.now() + POLL_FOR_MS;
    while (Date.now() < until) {
      const res = await fetch(
        `/api/phone-numbers/orders/${encodeURIComponent(order.id)}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payment_id: paymentId }),
        },
      );
      if (res.ok && res.status !== 202) {
        setState("paid");
        onPaid();
        return;
      }
      if (res.status !== 202) {
        setError(await errorOf(res, "Couldn't check the payment."));
        setState("idle");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    setError(
      `Your payment is still being processed. Your number will appear in your wallet once it clears. Payment id: ${paymentId}`,
    );
    setState("idle");
  };

  const pay = async () => {
    setError(null);
    setState("busy");
    try {
      const [Razorpay, res] = await Promise.all([
        loadCheckout(),
        fetch("/api/phone-numbers/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currency: offer.card_currency }),
        }),
      ]);
      if (!res.ok)
        throw new Error(await errorOf(res, "Couldn't start the payment."));
      const order = (await res.json()) as NumberOrder;
      const window = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: "Salts",
        description: `US phone number, ${months}`,
        prefill: { email: order.email },
        handler: (r: { razorpay_payment_id: string }) =>
          void finish(order, r.razorpay_payment_id),
        modal: {
          ondismiss: () => setState((s) => (s === "busy" ? "idle" : s)),
        },
      });
      window.on("payment.failed", (r) =>
        setError(r.error?.description ?? "The payment didn't go through."),
      );
      window.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
    }
  };

  if (state === "paid") {
    return (
      <div className="bg-canvas-soft flex items-center gap-3 rounded-2xl px-4 py-4">
        <span className="bg-ink text-on-primary flex h-8 w-8 items-center justify-center rounded-full">
          <Check className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold leading-[1.43]">
          Your new number has been added to your wallet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="ring-hairline-soft rounded-[24px] p-6 ring-1">
        <p className="text-base font-semibold leading-[1.38]">
          Busniess phone number
        </p>
        <p className="mt-4 text-[32px] font-[650] leading-[1.13]">
          {priceOf(offer)}
        </p>
        <p className="text-muted mt-1 text-xs leading-[1.33]">for {months}</p>
      </div>
      <p className="text-muted mt-4 text-xs leading-[1.33]">
        A renew reminder will be sent 1 month before this number expires.
      </p>
      <button
        onClick={() => void pay()}
        disabled={state !== "idle"}
        className="bg-ink text-on-primary mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
      >
        {state === "idle" ? (
          `Pay ${priceOf(offer)}`
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {state === "checking" ? "Confirming payment…" : "Opening payment…"}
          </>
        )}
      </button>
      <p className="text-muted mt-2 text-center text-xs leading-[1.33]">
        {offer.card_currency === "INR"
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
