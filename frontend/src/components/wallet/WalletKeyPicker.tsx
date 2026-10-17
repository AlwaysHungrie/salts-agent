import { Wallet } from "lucide-react";
import { formatUsdShort } from "@/lib/format";
import { useWallet } from "./useWallet";
import { useWalletPanel } from "./WalletPanel";

/** Stands for a key that is set but was not picked from this wallet. */
const ELSEWHERE = "__elsewhere";

/**
 * Where an OpenRouter key is asked for: a dropdown of the caller's wallet keys by
 * nickname. The value is a wallet key's id; blank means no key.
 */
export function WalletKeyPicker({
  value,
  hasKey = false,
  onChange,
  label,
  hint,
}: {
  value: string;
  /** Whether a key is already set, so one not from this wallet still reads as set. */
  hasKey?: boolean;
  onChange: (keyId: string) => void;
  label?: string;
  hint?: string;
}) {
  const wallet = useWallet();
  const openWallet = useWalletPanel();
  const keys = wallet.keys ?? [];
  const known = keys.some((k) => k.id === value);
  // A key someone else picked, or one pasted before the wallet existed.
  const elsewhere = value ? !known : hasKey;
  const selected = elsewhere ? ELSEWHERE : value;

  return (
    <div>
      {label && <p className="text-sm font-semibold leading-[1.43]">{label}</p>}
      {hint && <p className="text-muted text-xs font-light leading-[1.33]">{hint}</p>}
      <div className="relative mt-2">
        <select
          value={selected}
          onChange={(e) => {
            if (e.target.value !== ELSEWHERE) onChange(e.target.value);
          }}
          disabled={wallet.keys === null}
          aria-label="OpenRouter key"
          className="bg-field text-ink focus:ring-ink w-full appearance-none rounded-2xl py-3 pr-12 pl-4 text-sm outline-none focus:ring-2"
        >
          <option value="">{keys.length ? "Choose a key" : "No keys in your wallet"}</option>
          {elsewhere && (
            <option value={ELSEWHERE}>
              {value ? "A key from someone else's wallet" : "A key added before the wallet"}
            </option>
          )}
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.nickname}
              {k.limit !== null ? ` (${formatUsdShort(k.remaining)} left)` : ""}
            </option>
          ))}
        </select>
        <button
          onClick={() => openWallet(() => void wallet.load())}
          title="Open your OpenRouter wallet"
          aria-label="Open your OpenRouter wallet"
          className="text-muted hover:text-ink absolute top-1/2 right-4 -translate-y-1/2 transition"
        >
          <Wallet size={16} />
        </button>
      </div>
    </div>
  );
}
