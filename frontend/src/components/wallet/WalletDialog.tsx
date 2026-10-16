import { useEffect, useState } from "react";
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
            <p className="text-lg font-semibold leading-[1.38]">
              OpenRouter wallet
            </p>
            <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
              Manage your OpenRouter API keys.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setBuying(true)}
              className="bg-ink text-on-primary h-9 rounded-full px-4 text-sm font-semibold transition hover:opacity-85"
            >
              Use Card/Crypto
            </button>
          </div>
        </div>

        {wallet.error && (
          <p className="mt-4 text-xs leading-[1.33]">{wallet.error}</p>
        )}

        <div className="mt-6 space-y-3">
          {wallet.keys === null && (
            <p className="text-muted text-sm leading-[1.43]">
              Loading your keys…
            </p>
          )}
          {wallet.keys?.length === 0 && (
            <p className="text-center mt-8 text-muted text-sm leading-[1.43]">
              No keys yet.
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

/** One key, laid out like a pricing card: its name, what it may still spend, its details. */
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

  const usedBy =
    key.agents === 0
      ? "Not used by any agent yet."
      : `Used by ${key.agents === 1 ? "1 agent" : `${key.agents} agents`}.`;

  return (
    <div className="ring-hairline-soft rounded-[24px] p-6 ring-1">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 truncate text-xl font-semibold leading-[1.3]">{key.nickname}</p>
        {!confirming && !crediting && (
          <div className="flex shrink-0 gap-2">
            {key.kind === "provisioned" && (
              <button
                onClick={() => setCrediting(true)}
                className="border-hairline text-ink hover:bg-canvas-soft h-9 rounded-full border px-4 text-xs font-semibold transition"
              >
                Add credits
              </button>
            )}
            <button
              onClick={() => setConfirming(true)}
              className="bg-canvas-soft text-ink h-9 rounded-full px-4 text-xs font-semibold transition hover:opacity-70"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      <Credit walletKey={key} />

      <div className="text-muted mt-5 text-sm leading-[1.43]">
        {key.key !== null ? (
          <p className="break-all">
            {shown ? key.key : `Your key ending ${key.key.slice(-4)}.`}{" "}
            <button
              onClick={() => setShown(!shown)}
              className="hover:text-ink underline underline-offset-2 transition"
            >
              {shown ? "Hide" : "Show"}
            </button>
          </p>
        ) : (
          <p>Bought here. The key itself stays hidden.</p>
        )}
        <p>{usedBy}</p>
      </div>

      {confirming && (
        <div className="bg-canvas-soft mt-5 rounded-2xl px-4 py-4">
          <p className="text-sm leading-[1.43]">
            {key.agents === 0
              ? "Remove this key from your wallet?"
              : `Remove this key? ${key.agents === 1 ? "1 agent" : `${key.agents} agents`} will stop replying until given another.`}
            {key.kind === "provisioned" && " Its remaining credit is lost."}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setConfirming(false)}
              className="border-hairline text-ink hover:bg-canvas h-9 rounded-full border px-4 text-xs font-semibold transition"
            >
              Keep key
            </button>
            <button
              onClick={() => void run(onRemove)}
              disabled={busy}
              className="bg-ink text-on-primary h-9 rounded-full px-4 text-xs font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              {busy ? "Removing…" : "Remove key"}
            </button>
          </div>
        </div>
      )}

      {crediting && (
        <div className="bg-canvas-soft mt-5 rounded-2xl px-4 py-4">
          <label className="block text-sm leading-[1.43]">
            Credit to add, in US dollars
            <input
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-canvas mt-2 block h-11 w-full rounded-2xl px-4 text-sm outline-none focus:ring-2 focus:ring-ink"
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setCrediting(false)}
              className="border-hairline text-ink hover:bg-canvas h-9 rounded-full border px-4 text-xs font-semibold transition"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                void run(() => onAddCredits(Number(amount))).then((ok) => ok && setCrediting(false))
              }
              disabled={busy || !(Number(amount) > 0)}
              className="bg-ink text-on-primary h-9 rounded-full px-4 text-xs font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              Add credits
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm leading-[1.43]">{error}</p>}
    </div>
  );
}

/** What the key may still spend, as OpenRouter reports it: one large figure, a caption under. */
function Credit({ walletKey: key }: { walletKey: WalletKey }) {
  const [figure, caption] = !key.valid
    ? ["—", "OpenRouter isn't accepting this key."]
    : key.limit === null
      ? [formatUsdShort(key.usage), "spent so far, no limit set"]
      : [formatUsdShort(key.remaining), `left of ${formatUsdShort(key.limit)}`];
  return (
    <div className="mt-4">
      <p className="text-[32px] font-[650] leading-[1.13]">{figure}</p>
      <p className="text-muted mt-1 text-xs leading-[1.33]">{caption}</p>
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
          className="bg-field placeholder:text-faint focus:ring-ink h-11 min-w-0 flex-1 rounded-2xl px-4 text-sm outline-none focus:ring-2"
        />
        <button
          onClick={() => void submit()}
          disabled={!ready || busy}
          className="border-hairline text-ink hover:bg-canvas-soft h-11 shrink-0 rounded-full border px-5 text-sm font-semibold transition disabled:opacity-40"
        >
          {busy ? "Checking…" : "Add key"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs leading-[1.33]">{error}</p>}
    </div>
  );
}
