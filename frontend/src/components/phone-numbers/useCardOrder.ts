"use client";

import { useState } from "react";
import { loadCheckout } from "@/components/wallet/CardCheckout";

type CardOrder = {
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

/**
 * Pay by card in Razorpay's window for something sold under Business Phone Numbers: a
 * number, or a message pack. `body` is the order as `/api/phone-numbers/orders` takes it.
 * The Worker reads the payment back from Razorpay before it counts, then delivers.
 */
export function useCardOrder({
  body,
  description,
  pending,
  onPaid,
}: {
  body: Record<string, unknown>;
  /** What Razorpay's window says is being bought. */
  description: string;
  /** Said when the payment hasn't cleared after five minutes; the payment id follows. */
  pending: string;
  onPaid: () => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "checking" | "paid">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const finish = async (order: CardOrder, paymentId: string) => {
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
    setError(`${pending} Payment id: ${paymentId}`);
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
          body: JSON.stringify(body),
        }),
      ]);
      if (!res.ok)
        throw new Error(await errorOf(res, "Couldn't start the payment."));
      const order = (await res.json()) as CardOrder;
      const window = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: "Salts",
        description,
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

  return { state, error, pay };
}
