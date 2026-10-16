import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { WalletKey } from "@/lib/agent";
import { formatUsdShort } from "@/lib/format";
import { BuyKeyDialog } from "./BuyKeyDialog";
import { useWallet } from "./useWallet";

/**
 * The caller's OpenRouter wallet: every key they may give an agent, by nickname. A pasted
 * key can be seen and removed; a bought one is never shown, and takes more credit.
 */
export function WalletDialog({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !buying) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, buying]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="OpenRouter wallet"
        className="bg-canvas text-ink my-auto w-full max-w-lg rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-semibold leading-[1.38]">OpenRouter wallet</p>
            <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
              Manage your OpenRouter API keys.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setBuying(true)}
              className="bg-ink text-on-primary h-9 rounded-full px-4 text-sm font-semibold transition hover:opacity-85"
            >
              Buy a key
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-muted hover:bg-canvas-soft hover:text-ink flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition"
            >
              ×
            </button>
          </div>
        </div>

        {wallet.error && <p className="mt-4 text-xs leading-[1.33]">{wallet.error}</p>}

        <div className="mt-5 space-y-2">
          {wallet.keys === null && (
            <p className="text-muted text-sm leading-[1.43]">Loading your keys…</p>
          )}
          {wallet.keys?.length === 0 && (
            <p className="text-muted text-sm leading-[1.43]">
              No keys yet. Add one you already have, or buy one.
            </p>
          )}
          {wallet.keys?.map((key) => (
            <KeyRow
              key={key.id}
              walletKey={key}
              onRemove={() => wallet.remove(key.id)}
              onAddCredits={(amount) => wallet.addCredits(key.id, amount)}
            />
          ))}
        </div>

        <AddKey onAdd={wallet.add} />
      </div>

      {buying && (
        <div onClick={(e) => e.stopPropagation()}>
          <BuyKeyDialog onBuy={wallet.buy} onClose={() => setBuying(false)} />
        </div>
      )}
    </div>
  );
}

/** One key: its nickname, what it may still spend, and what can be done with it. */
function KeyRow({
  walletKey: key,
  onRemove,
  onAddCredits,
}: {
  walletKey: WalletKey;
  onRemove: () => Promise<string | null>;
  onAddCredits: (amount: number) => Promise<string | null>;
}) {
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const failed = await call();
    setBusy(false);
    if (failed) setError(failed);
    return !failed;
  };

  return (
    <div className="bg-canvas-soft rounded-2xl px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-[1.43]">{key.nickname}</p>
          <p className="text-muted text-xs font-light leading-[1.33]">
            {key.kind === "provisioned" ? "Bought here" : "Added by you"}
            {" · "}
            {key.agents === 1 ? "1 agent" : `${key.agents} agents`}
          </p>
        </div>
        <Credit walletKey={key} />
      </div>

      {key.key !== null && (
        <div className="mt-2 flex items-center gap-2">
          <code className="text-muted min-w-0 flex-1 truncate text-xs">
            {shown ? key.key : "sk-or-…" + key.key.slice(-4)}
          </code>
          <button
            onClick={() => setShown(!shown)}
            aria-label={shown ? "Hide key" : "Show key"}
            className="text-muted hover:text-ink flex h-7 w-7 items-center justify-center rounded-full transition"
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      )}

      {crediting && (
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Credit to add, in USD"
            className="bg-canvas ring-hairline-soft h-9 w-28 rounded-full px-4 text-sm ring-1 outline-none"
          />
          <button
            onClick={() =>
              void run(() => onAddCredits(Number(amount))).then((ok) => ok && setCrediting(false))
            }
            disabled={busy || !(Number(amount) > 0)}
            className="bg-ink text-on-primary h-9 rounded-full px-4 text-xs font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            Pay with crypto
          </button>
        </div>
      )}

      {confirming && (
        <p className="mt-3 text-xs leading-[1.33]">
          {key.agents > 0
            ? `${key.agents === 1 ? "1 agent uses" : `${key.agents} agents use`} this key and will stop working until given another.`
            : "No agent uses this key."}
          {key.kind === "provisioned" && " Its remaining credit is lost."}
        </p>
      )}

      {error && <p className="mt-2 text-xs leading-[1.33]">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        {key.kind === "provisioned" && !confirming && (
          <button
            onClick={() => setCrediting(!crediting)}
            className="border-hairline text-ink hover:bg-canvas h-8 rounded-full border px-4 text-xs font-semibold transition"
          >
            {crediting ? "Cancel" : "Add credits"}
          </button>
        )}
        {confirming ? (
          <>
            <button
              onClick={() => setConfirming(false)}
              className="border-hairline text-ink hover:bg-canvas h-8 rounded-full border px-4 text-xs font-semibold transition"
            >
              Keep
            </button>
            <button
              onClick={() => void run(onRemove)}
              disabled={busy}
              className="bg-ink text-on-primary h-8 rounded-full px-4 text-xs font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              Remove
            </button>
          </>
        ) : (
          !crediting && (
            <button
              onClick={() => setConfirming(true)}
              className="text-muted hover:text-ink h-8 rounded-full px-3 text-xs font-semibold transition"
            >
              Remove
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** What the key may still spend, as OpenRouter reports it. */
function Credit({ walletKey: key }: { walletKey: WalletKey }) {
  if (!key.valid) return <p className="shrink-0 text-xs leading-[1.33]">Not working</p>;
  return (
    <div className="shrink-0 text-right">
      <p className="text-sm font-semibold leading-[1.43]">
        {key.limit === null ? "No limit" : `${formatUsdShort(key.remaining)} left`}
      </p>
      <p className="text-muted text-xs font-light leading-[1.33]">
        {key.limit === null
          ? `${formatUsdShort(key.usage)} used`
          : `of ${formatUsdShort(key.limit)}`}
      </p>
    </div>
  );
}

/** The footer: add a key the user already has. The Worker names it. */
function AddKey({ onAdd }: { onAdd: (key: string) => Promise<string | null> }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = secret.trim() !== "";

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onAdd(secret.trim());
    setBusy(false);
    if (failed) setError(failed);
    else setSecret("");
  };

  return (
    <div className="border-hairline-soft mt-6 border-t pt-5">
      <div className="flex gap-2">
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          type="password"
          autoComplete="off"
          placeholder="Paste an OpenRouter key, sk-or-v1-…"
          aria-label="OpenRouter API key"
          className="bg-field placeholder:text-faint min-w-0 flex-1 rounded-full px-4 text-sm outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={!ready || busy}
          className="border-hairline text-ink hover:bg-canvas-soft h-10 shrink-0 rounded-full border px-5 text-sm font-semibold transition disabled:opacity-40"
        >
          {busy ? "Checking…" : "Add key"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs leading-[1.33]">{error}</p>}
    </div>
  );
}
