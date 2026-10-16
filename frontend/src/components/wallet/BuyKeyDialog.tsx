import { useEffect, useState } from "react";

/**
 * Buying a key, as a full screen like the fleet request. The key is provisioned for the
 * buyer, spent only through their agents, and sold at OpenRouter's price.
 */
export function BuyKeyDialog({
  onBuy,
  onClose,
}: {
  /** Resolves to an error to show, or null once the key is bought. */
  onBuy: (amount: number) => Promise<string | null>;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes, and the page behind stops scrolling while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const submit = async () => {
    if (!valid) {
      setError("Choose an amount to buy.");
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await onBuy(parsed);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Buy an OpenRouter key"
      className="bg-canvas fixed inset-0 z-[60] overflow-y-auto overscroll-contain"
    >
      <div className="from-accent/12 pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-linear-to-b to-transparent" />

      <div className="relative mx-auto w-full max-w-2xl px-5 pt-8 pb-20 sm:px-8 sm:pt-12">
        <div className="flex justify-end">
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:bg-white hover:text-ink flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition"
          >
            ×
          </button>
        </div>

        <div className="pt-6 sm:pt-10">
          <span className="bg-white text-muted inline-flex items-center rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-[1.33]">
            OpenRouter Wallet
          </span>
          <h1 className="mt-5 text-[clamp(30px,4.5vw,44px)] leading-[1.08] tracking-[-0.025em]">
            Get an OpenRouter key without the setup.
          </h1>
          <p className="text-muted mt-4 max-w-lg text-base font-light leading-[1.4] sm:text-xl">
            Pay once and we create an OpenRouter key for you. It lands in your
            wallet, ready to pick for any of your agents.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            {[
              [
                "No markup",
                "Your credit is OpenRouter credit at OpenRouter's prices. We add nothing on top.",
              ],
              [
                "Only for your agents",
                "The key itself stays hidden. It can only be spent by agents you give it to.",
              ],
              [
                "Top up any time",
                "Add credits to the same key from your wallet whenever it runs low.",
              ],
            ].map(([title, body]) => (
              <div key={title} className="rounded-[24px] py-6">
                <h2 className="text-base font-semibold tracking-[-0.01em]">
                  {title}
                </h2>
                <p className="text-muted mt-2 text-sm leading-relaxed">{body}</p>
              </div>
            ))}
          </div>

          <div className="bg-canvas-soft mt-8 rounded-[24px] px-6 py-7 sm:px-8">
            <h2 className="text-xl font-semibold tracking-[-0.01em]">Buy a key.</h2>
            <p className="text-muted mt-2 text-sm leading-relaxed">
              Pay with crypto. Card payments are coming later.
            </p>

            <div className="mt-6 space-y-5">
              <label className="block">
                <span className="text-muted block text-xs leading-[1.33]">
                  Credit (USD)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  className="bg-canvas ring-hairline-soft placeholder:text-faint mt-2 h-12 w-full rounded-2xl px-4 text-sm ring-1 outline-none"
                />
              </label>

              <div>
                <span className="text-muted block text-xs leading-[1.33]">
                  Payment
                </span>
                <div className="bg-canvas ring-hairline-soft mt-2 flex h-12 w-full items-center rounded-2xl px-4 text-sm ring-1">
                  Crypto
                </div>
              </div>
            </div>

            {error && <p className="mt-4 text-xs leading-[1.33]">{error}</p>}

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void submit()}
                disabled={busy}
                className="bg-ink text-on-primary h-12 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
              >
                {busy ? "Starting…" : "Continue to payment"}
              </button>
              <button
                onClick={onClose}
                className="text-muted hover:text-ink h-12 rounded-full px-4 text-sm font-semibold transition"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
