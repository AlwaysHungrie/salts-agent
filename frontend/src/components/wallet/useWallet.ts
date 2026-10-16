import { useCallback, useEffect, useState } from "react";
import type { WalletKey } from "@/lib/agent";

/** The error a wallet route answered with, or a fallback when it said nothing readable. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? fallback;
}

/** The wallet as the Worker holds it, or the error it answered with. */
async function readWallet(): Promise<{ keys: WalletKey[]; error: string | null }> {
  const res = await fetch("/api/wallet", { cache: "no-store" });
  if (!res.ok) return { keys: [], error: await errorOf(res, "Couldn't load your wallet.") };
  return { keys: ((await res.json()) as { keys: WalletKey[] }).keys, error: null };
}

/**
 * The caller's OpenRouter wallet, and the calls that change it. Each call resolves to an
 * error to show, or null once it worked.
 */
export function useWallet() {
  const [keys, setKeys] = useState<WalletKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((read: { keys: WalletKey[]; error: string | null }) => {
    setKeys(read.keys);
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
    const res = await fetch(`/api/wallet/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return await errorOf(res, "Couldn't remove that key.");
    await load();
    return null;
  };

  const addCredits = async (id: string, amount: number) => {
    const res = await fetch(`/api/wallet/${encodeURIComponent(id)}/credits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) return await errorOf(res, "Couldn't add credits.");
    await load();
    return null;
  };

  const buy = async (amount: number) => {
    const res = await fetch("/api/wallet/purchases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) return await errorOf(res, "Couldn't start the purchase.");
    await load();
    return null;
  };

  return { keys, error, load, add, remove, addCredits, buy };
}
