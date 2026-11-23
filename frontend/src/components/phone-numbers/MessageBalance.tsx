"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { type MessagePack, MessagePackCheckout } from "./MessagePackCheckout";

/** The account's WhatsApp messages left, and the packs that recharge them. */
type Balance = {
  messages_remaining: number;
  message_packs: MessagePack[];
  /** Razorpay's key id; blank while buying is closed. */
  razorpay_key_id: string;
  /** Set by the Next route from the caller's IP country. */
  card_currency: "INR" | "USD";
};

/** How long the drawer takes to slide in or out. */
const SLIDE_MS = 200;

async function readBalance(): Promise<Balance | null> {
  const res = await fetch("/api/phone-numbers", { cache: "no-store" });
  return res.ok ? ((await res.json()) as Balance) : null;
}

/**
 * WhatsApp message credits left on the account, shared by all its agents. "Buy more"
 * opens a drawer with the packs that recharge them.
 */
export function MessageBalance() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [buying, setBuying] = useState(false);

  const apply = useCallback((read: Balance | null) => setBalance(read), []);
  const load = useCallback(async () => apply(await readBalance()), [apply]);

  useEffect(() => {
    void readBalance().then(apply);
  }, [apply]);

  const open = !!balance?.razorpay_key_id && !!balance.message_packs.length;

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-semibold leading-[1.43]">Message Credits</p>
        {open && (
          <button
            onClick={() => setBuying(true)}
            className="text-ink text-xs font-normal leading-[1.33] underline underline-offset-2 transition hover:opacity-70"
          >
            Buy more
          </button>
        )}
      </div>
      <p className="bg-field mt-2 rounded-2xl px-4 py-3 text-sm">
        {balance === null
          ? "Loading…"
          : `${balance.messages_remaining.toLocaleString("en-US")} left`}
      </p>
      <p className="text-muted mt-2 text-xs font-light leading-[1.33]">
        Set up per WhatsApp account usage limits to prevent abuse.
      </p>
      {balance?.messages_remaining === 0 && (
        <p className="text-muted mt-2 text-xs font-light leading-[1.33]">
          Your agents can&apos;t reply on WhatsApp until you buy more.
        </p>
      )}
      {buying && balance && (
        <CreditsDrawer onClose={() => setBuying(false)}>
          <MessagePackCheckout
            packs={balance.message_packs}
            currency={balance.card_currency}
            onPaid={() => void load()}
          />
        </CreditsDrawer>
      )}
    </div>
  );
}

/** A sidebar from the right, as Business Phone Numbers opens, holding the checkout. */
function CreditsDrawer({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState(false);

  // Slide in once mounted; slide out before unmounting.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const dismiss = useCallback(() => {
    setShown(false);
    setTimeout(onClose, SLIDE_MS);
  }, [onClose]);

  // Escape closes; the page behind stops scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [dismiss]);

  return (
    <div className="fixed inset-0 z-60">
      <div
        onClick={dismiss}
        className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Buy message credits"
        className={`bg-canvas text-ink absolute inset-y-0 right-0 flex w-full max-w-md flex-col shadow-xl transition-transform duration-200 ease-out ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="border-hairline-soft flex items-center gap-2 border-b px-6 py-4">
          <p className="min-w-0 flex-1 truncate text-lg font-semibold leading-[1.38]">
            Buy message credits
          </p>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="text-muted hover:bg-canvas-soft hover:text-ink -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-6">
          {children}
        </div>
      </aside>
    </div>
  );
}
