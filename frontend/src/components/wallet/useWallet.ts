import { useCallback, useEffect, useState } from "react";
import type { CardOrder, PayNetwork, PayQuote, WalletKey } from "@/lib/agent";

/** The error a wallet route answered with, or a fallback when it said nothing readable. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error ?? fallback;
}

type WalletRead = {
  keys: WalletKey[];
  networks: PayNetwork[];
  feeBps: number;
  maxUsd: number;
  reownProjectId: string;
  razorpayKeyId: string;
  inrPerUsd: number;
  error: string | null;
};

/** The wallet as the Worker holds it, or the error it answered with. */
async function readWallet(): Promise<WalletRead> {
  const res = await fetch("/api/wallet", { cache: "no-store" });
  if (!res.ok) {
    return {
      keys: [],
      networks: [],
      feeBps: 0,
      maxUsd: 0,
      reownProjectId: "",
      razorpayKeyId: "",
      inrPerUsd: 0,
      error: await errorOf(res, "Couldn't load your wallet."),
    };
  }
  const body = (await res.json()) as {
    keys: WalletKey[];
    networks?: PayNetwork[];
    fee_bps?: number;
    max_usd?: number;
    reown_project_id?: string;
    razorpay_key_id?: string;
    inr_per_usd?: number;
  };
  return {
    keys: body.keys,
    networks: body.networks ?? [],
    feeBps: body.fee_bps ?? 0,
    maxUsd: body.max_usd ?? 0,
    reownProjectId: body.reown_project_id ?? "",
    razorpayKeyId: body.razorpay_key_id ?? "",
    inrPerUsd: body.inr_per_usd ?? 0,
    error: null,
  };
}

/**
 * The caller's OpenRouter wallet, and the calls that change it. Each call resolves to an
 * error to show, or null once it worked.
 */
export function useWallet() {
  const [keys, setKeys] = useState<WalletKey[] | null>(null);
  const [networks, setNetworks] = useState<PayNetwork[]>([]);
  /** The service fee on a purchase, in basis points of the credit. */
  const [feeBps, setFeeBps] = useState(0);
  /** The most credit one purchase may buy, in dollars. */
  const [maxUsd, setMaxUsd] = useState(0);
  /** Reown's project id, which the wallet modal is opened with; blank when payments are off. */
  const [reownProjectId, setReownProjectId] = useState("");
  /** Razorpay's key id, which card checkout is opened with; blank when card payments are off. */
  const [razorpayKeyId, setRazorpayKeyId] = useState("");
  /** Rupees charged per dollar of a card purchase. */
  const [inrPerUsd, setInrPerUsd] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((read: WalletRead) => {
    setKeys(read.keys);
    setNetworks(read.networks);
    setFeeBps(read.feeBps);
    setMaxUsd(read.maxUsd);
    setReownProjectId(read.reownProjectId);
    setRazorpayKeyId(read.razorpayKeyId);
    setInrPerUsd(read.inrPerUsd);
    setError(read.error);
  }, []);

  const load = useCallback(async () => apply(await readWallet()), [apply]);

  useEffect(() => {
    void readWallet().then(apply);
  }, [apply]);

  /** `connected` marks a key just made through "From OpenRouter", which needs a credit limit. */
  const add = async (key: string, connected?: boolean) => {
    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, connected }),
    });
    if (!res.ok) return await errorOf(res, "Couldn't add that key.");
    await load();
    return null;
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/wallet/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) return await errorOf(res, "Couldn't remove that key.");
    await load();
    return null;
  };

  /**
   * Ask for a quote for a new key. Resolves to the quote, or an error to show.
   */
  const quote = async (body: {
    amount: number;
    network: string;
    asset: string;
    payer: string;
  }): Promise<PayQuote | string> => {
    const res = await fetch("/api/wallet/purchases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return await errorOf(res, "Couldn't start the payment.");
    return (await res.json()) as PayQuote;
  };

  /**
   * Ask the Worker to count a sent payment: "paid", "pending" while the chain is not
   * final, or an error to show.
   */
  const confirm = async (
    id: string,
    tx: string,
  ): Promise<"paid" | "pending" | string> => {
    const res = await fetch(
      `/api/wallet/purchases/${encodeURIComponent(id)}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx }),
      },
    );
    if (res.status === 202) return "pending";
    if (!res.ok) return await errorOf(res, "Couldn't check the payment.");
    await load();
    return "paid";
  };

  /** Make a Razorpay order for a new key. Resolves to the order, or an error to show. */
  const cardOrder = async (amount: number): Promise<CardOrder | string> => {
    const res = await fetch("/api/wallet/card-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) return await errorOf(res, "Couldn't start the payment.");
    return (await res.json()) as CardOrder;
  };

  /**
   * Ask the Worker to count a card payment by its Razorpay id: "paid", "pending" while
   * Razorpay or the key isn't done, or an error to show.
   */
  const cardConfirm = async (
    id: string,
    paymentId: string,
  ): Promise<"paid" | "pending" | string> => {
    const res = await fetch(
      `/api/wallet/card-orders/${encodeURIComponent(id)}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payment_id: paymentId }),
      },
    );
    if (res.status === 202) return "pending";
    if (!res.ok) return await errorOf(res, "Couldn't check the payment.");
    await load();
    return "paid";
  };

  /**
   * Count a payment the page lost track of, by its network and transaction id: "paid",
   * "pending" while the chain or the delivery isn't done, or `{ error, final }`, final
   * when asking again can't help (it pays for none of the buyer's purchases).
   */
  const recover = useCallback(
    async (
      network: string,
      tx: string,
    ): Promise<
      "paid" | "already" | "pending" | { error: string; final: boolean }
    > => {
      const res = await fetch("/api/wallet/purchases/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, tx }),
      });
      if (res.status === 202) return "pending";
      if (!res.ok) {
        return {
          error: await errorOf(res, "Couldn't check the payment."),
          final: res.status === 400 || res.status === 409,
        };
      }
      const { already } = (await res.json()) as { already?: boolean };
      await load();
      return already ? "already" : "paid";
    },
    [load],
  );

  return {
    keys,
    networks,
    feeBps,
    maxUsd,
    reownProjectId,
    razorpayKeyId,
    inrPerUsd,
    error,
    load,
    add,
    remove,
    quote,
    confirm,
    cardOrder,
    cardConfirm,
    recover,
  };
}
