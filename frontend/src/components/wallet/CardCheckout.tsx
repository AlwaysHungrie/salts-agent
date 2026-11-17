"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { CardOrder } from "@/lib/agent";
import { Paid, Step } from "./BuyCredits";

/** Asks the Worker for a Razorpay order, and to count a payment made on it. */
export type CardCalls = {
  order: () => Promise<CardOrder | string>;
  confirm: (id: string, paymentId: string) => Promise<"paid" | "pending" | string>;
};

/** Razorpay's checkout script, which opens its payment window over the page. */
const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";

type RazorpayWindow = {
  open: () => void;
  on: (event: "payment.failed", fn: (r: { error?: { description?: string } }) => void) => void;
};
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayWindow;

let loading: Promise<RazorpayCtor> | null = null;

/** Load Razorpay's checkout once per page. */
function loadCheckout(): Promise<RazorpayCtor> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_JS;
    script.onload = () => resolve((window as unknown as { Razorpay: RazorpayCtor }).Razorpay);
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load the payment window. Check your connection and try again."));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/** How often, and for how long, a payment is checked before the buyer is told to wait. */
const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60 * 1000;

/**
 * Pay by card, UPI or netbanking in Razorpay's window. The Worker reads the payment back
 * from Razorpay before it counts, so the key is issued only for a payment that went through.
 */
export function CardCheckout({
  total,
  calls,
  onPaid,
  onLock,
}: {
  /** What the buyer pays in rupees; null while the amount isn't valid. */
  total: number | null;
  calls: CardCalls;
  onPaid: () => void;
  /** Told when a payment starts (and stays started once paid), so the amount is locked. */
  onLock: (locked: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "checking" | "paid">("idle");
  const [error, setError] = useState<string | null>(null);

  const finish = async (order: CardOrder, paymentId: string) => {
    setState("checking");
    const until = Date.now() + POLL_FOR_MS;
    while (Date.now() < until) {
      const verdict = await calls.confirm(order.id, paymentId);
      if (verdict === "paid") {
        setState("paid");
        onPaid();
        return;
      }
      if (verdict !== "pending") {
        setError(verdict);
        setState("idle");
        onLock(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    setError(
      `Your payment is still being processed. Your key will appear in your wallet once it clears. Payment id: ${paymentId}`,
    );
    setState("idle");
  };

  const pay = async () => {
    setError(null);
    setState("busy");
    try {
      const [Razorpay, order] = await Promise.all([loadCheckout(), calls.order()]);
      if (typeof order === "string") throw new Error(order);
      onLock(true);
      const window = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: "Salts",
        description: `₹${order.credit_inr.toLocaleString("en-IN")} AI credits`,
        handler: (r: { razorpay_payment_id: string }) => void finish(order, r.razorpay_payment_id),
        modal: {
          ondismiss: () => {
            setState((s) => (s === "busy" ? "idle" : s));
            onLock(false);
          },
        },
      });
      window.on("payment.failed", (r) => setError(r.error?.description ?? "The payment didn't go through."));
      window.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
      onLock(false);
    }
  };

  if (state === "paid") return <Paid />;

  return (
    <div>
      <Step title="Pay with card or UPI" hint="Cards, UPI and netbanking, through Razorpay." />
      <button
        onClick={() => void pay()}
        disabled={total === null || state !== "idle"}
        className="bg-ink text-on-primary flex h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
      >
        {state === "idle" ? (
          `Pay ₹${total === null ? "—" : total.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {state === "checking" ? "Confirming payment…" : "Opening payment…"}
          </>
        )}
      </button>
      {error && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs leading-[1.33] break-words text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
