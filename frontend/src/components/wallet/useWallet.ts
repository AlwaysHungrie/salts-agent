import { useCallback, useEffect, useState } from "react";
import type { PayNetwork, PayQuote, WalletKey } from "@/lib/agent";

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
      error: await errorOf(res, "Couldn't load your wallet."),
    };
  }
  const body = (await res.json()) as {
    keys: WalletKey[];
    networks?: PayNetwork[];
    fee_bps?: number;
    max_usd?: number;
    reown_project_id?: string;
  };
  return {
    keys: body.keys,
    networks: body.networks ?? [],
    feeBps: body.fee_bps ?? 0,
    maxUsd: body.max_usd ?? 0,
    reownProjectId: body.reown_project_id ?? "",
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
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((read: WalletRead) => {
    setKeys(read.keys);
    setNetworks(read.networks);
    setFeeBps(read.feeBps);
    setMaxUsd(read.maxUsd);
    setReownProjectId(read.reownProjectId);
    setError(read.error);
  }, []);

  const load = useCallback(async () => apply(await readWallet()), [apply]);

  useEffect(() => {
    void readWallet().then(apply);
  }, [apply]);

  const add = async (key: string) => {
    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
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

  return {
    keys,
    networks,
    feeBps,
    maxUsd,
    reownProjectId,
    error,
    load,
    add,
    remove,
    quote,
    confirm,
  };
}
