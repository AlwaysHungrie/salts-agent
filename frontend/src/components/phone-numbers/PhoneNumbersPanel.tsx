"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import {
  ArrowLeft,
  ChevronRight,
  CreditCard,
  Phone,
  Trash2,
  X,
} from "lucide-react";
import { formatDaysAgo } from "@/lib/format";
import { PayOption } from "@/components/wallet/PayOption";
import { NumberCheckout, type NumberOffer, priceOf } from "./NumberCheckout";

/** One number in the caller's Business Phone Numbers, as the Worker shows it. */
type PhoneNumber = {
  id: string;
  /** Digits only, country code first. */
  number: string;
  kind: "own" | "bought";
  created_at: number;
  /** When a bought number's paid time runs out; 0 for the user's own. */
  expires_at: number;
};

/** How long the sidebar takes to slide in or out. */
const SLIDE_MS = 200;

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? fallback;
}

/** The caller's numbers as the Worker holds them, or the error it answered with. */
async function readNumbers(): Promise<{
  numbers: PhoneNumber[];
  offer: NumberOffer | null;
  error: string | null;
}> {
  const res = await fetch("/api/phone-numbers", { cache: "no-store" });
  if (!res.ok)
    return {
      numbers: [],
      offer: null,
      error: await errorOf(res, "Couldn't load your numbers."),
    };
  const body = (await res.json()) as NumberOffer & { numbers: PhoneNumber[] };
  return { numbers: body.numbers, offer: body, error: null };
}

/**
 * The caller's Business Phone Numbers, as a sidebar from the right, laid out like the
 * Tokens Wallet: every number they may give a WhatsApp for Business agent, and a way to
 * add one they already own.
 */
export function PhoneNumbersPanel({ onClose }: { onClose: () => void }) {
  const [numbers, setNumbers] = useState<PhoneNumber[] | null>(null);
  const [offer, setOffer] = useState<NumberOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  /** Whether the checkout for a new number is open. */
  const [buying, setBuying] = useState(false);

  const apply = useCallback((read: Awaited<ReturnType<typeof readNumbers>>) => {
    setNumbers(read.numbers);
    setOffer(read.offer);
    setError(read.error);
  }, []);
  const load = useCallback(async () => apply(await readNumbers()), [apply]);

  useEffect(() => {
    void readNumbers().then(apply);
  }, [apply]);

  // Slide in once mounted; slide out before unmounting.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const dismiss = useCallback(() => {
    setShown(false);
    setTimeout(onClose, SLIDE_MS);
  }, [onClose]);

  // Escape steps back from the checkout, else closes; the page behind stops scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (buying) setBuying(false);
      else dismiss();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [dismiss, buying]);

  const add = async (number: string) => {
    const res = await fetch("/api/phone-numbers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number }),
    });
    if (!res.ok) return await errorOf(res, "Couldn't add that number.");
    await load();
    return null;
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/phone-numbers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) return await errorOf(res, "Couldn't remove that number.");
    await load();
    return null;
  };

  return (
    <div className="fixed inset-0 z-60">
      <div
        onClick={dismiss}
        className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Business Phone Numbers"
        className={`bg-canvas text-ink absolute inset-y-0 right-0 flex w-full max-w-md flex-col shadow-xl transition-transform duration-200 ease-out ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="border-hairline-soft flex items-center gap-2 border-b px-6 py-4">
          {buying && (
            <button
              onClick={() => setBuying(false)}
              aria-label="Back to numbers"
              className="text-muted hover:bg-canvas-soft hover:text-ink -ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold leading-[1.38]">
              {buying ? "Buy a US number" : "Business Phone Numbers"}
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="text-muted hover:bg-canvas-soft hover:text-ink -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-6">
          {buying && offer ? (
            <NumberCheckout offer={offer} onPaid={() => void load()} />
          ) : (
            <>
              {error && <p className="mb-4 text-xs leading-[1.33]">{error}</p>}

              <div className="flex flex-1 flex-col space-y-3">
                {numbers === null && (
                  <>
                    <NumberRowSkeleton />
                    <NumberRowSkeleton />
                  </>
                )}
                {numbers?.length === 0 && !error && (
                  <p className="text-muted my-auto flex-1 py-4 text-center text-sm leading-[1.43]">
                    No numbers yet.
                  </p>
                )}
                {[...(numbers ?? [])]
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((n) => (
                    <NumberRow
                      key={n.id}
                      entry={n}
                      onRemove={() => remove(n.id)}
                    />
                  ))}
              </div>

              <p className="text-muted mt-8 mb-3 text-xs font-medium">
                Add a number
              </p>
              <div className="space-y-3">
                {offer?.razorpay_key_id && (
                  <PayOption
                    icon={<CreditCard className="h-4 w-4" />}
                    title="Buy a US number"
                    note={`${priceOf(offer)} for ${offer.term_months} ${offer.term_months === 1 ? "month" : "months"}, paid by card`}
                    onClick={() => setBuying(true)}
                  />
                )}
                <AddNumber onAdd={add} />
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** How a number is shown everywhere here, in its country's own grouping: +1 318 726 8259. */
function shownNumber(digits: string): string {
  return (
    parsePhoneNumberFromString(`+${digits}`)?.formatInternational() ??
    `+${digits}`
  );
}

/** A day as the wallet shows it: "12 May 2027". */
const shownDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** One number, laid out like a key card in the Tokens Wallet. */
function NumberRow({
  entry,
  onRemove,
}: {
  entry: PhoneNumber;
  onRemove: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="ring-hairline-soft rounded-[24px] p-6 ring-1">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 truncate text-xl font-semibold leading-[1.3]">
          {shownNumber(entry.number)}
        </p>
        <button
          onClick={() => setConfirming(true)}
          aria-label={`Remove ${shownNumber(entry.number)}`}
          title="Remove"
          className="bg-canvas-soft text-ink flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:opacity-70"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <p className="text-muted mt-5 text-sm leading-[1.43]">
        {entry.kind === "bought"
          ? `Expires ${shownDay(entry.expires_at)}`
          : `Added ${formatDaysAgo(entry.created_at)}`}
      </p>

      {confirming && (
        <RemoveNumberDialog
          entry={entry}
          onKeep={() => setConfirming(false)}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}

/** Digits only, so "+1 (415) 555-0123" matches "14155550123". */
const digitsOf = (text: string) => text.replace(/\D/g, "");

/**
 * Removing a number: it must be typed out, as for removing a bought key. A bought one is
 * released at the carrier and its paid time is lost. Drawn on the page body, as the
 * sidebar's slide would otherwise contain it.
 */
function RemoveNumberDialog({
  entry,
  onKeep,
  onRemove,
}: {
  entry: PhoneNumber;
  onKeep: () => void;
  onRemove: () => Promise<string | null>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const matches = digitsOf(typed) === entry.number;
  const shown = shownNumber(entry.number);

  // Escape keeps the number and leaves the sidebar open: caught before the sidebar's own.
  useEffect(() => {
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onKeep();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onKeep]);

  const remove = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onRemove();
    setBusy(false);
    if (failed) setError(failed);
  };

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-center justify-center bg-black/30 px-5">
      <div
        role="alertdialog"
        aria-modal="true"
        className="bg-canvas text-ink w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl"
      >
        <p className="text-base font-semibold leading-[1.38]">
          Remove {shown}?
        </p>
        <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
          {entry.kind === "bought" ? (
            <>
              You&rsquo;ll lose this number permanently. Any time left on it
              (until {shownDay(entry.expires_at)}) won&rsquo;t be refunded.
            </>
          ) : (
            <>It will be removed from your wallet.</>
          )}
          <br />
          <br />
          This can&rsquo;t be undone.
        </p>
        <label className="mt-4 block">
          <span className="text-muted block text-xs leading-[1.33]">
            Type <span className="text-ink font-semibold">{shown}</span> to
            confirm
          </span>
          <input
            ref={field}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void remove();
            }}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>
        {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onKeep}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={() => void remove()}
            disabled={!matches || busy}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A number card's outline while the wallet loads. */
function NumberRowSkeleton() {
  return (
    <div
      aria-hidden
      className="ring-hairline-soft animate-pulse rounded-[24px] p-6 ring-1"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="bg-canvas-soft h-6.5 w-40 rounded-lg" />
        <div className="bg-canvas-soft h-9 w-20 rounded-full" />
      </div>
      <div className="bg-canvas-soft mt-5 h-5 w-24 rounded" />
    </div>
  );
}

/** Add a number the user already owns, typed with its country code. */
function AddNumber({
  onAdd,
}: {
  onAdd: (number: string) => Promise<string | null>;
}) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = number.trim() !== "";

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onAdd(number.trim());
    setBusy(false);
    if (failed) setError(failed);
    else setNumber("");
  };

  return (
    <div>
      <div className="ring-hairline-soft flex w-full items-center gap-4 rounded-[24px] p-5 text-left ring-1 transition">
        <span className="bg-ink text-on-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
          <Phone className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold leading-[1.38]">
            Already have a spare number?
          </span>
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+1 415 555 0123"
            aria-label="Phone number with country code"
            className="bg-field placeholder:text-faint focus:ring-ink text-muted mt-1 block w-full rounded-md px-3 py-1 text-xs leading-[1.33] outline-none focus:ring-2"
          />
        </span>
        <button
          onClick={() => void submit()}
          disabled={!ready || busy}
          aria-label="Add number"
          className="text-faint hover:text-ink h-4 w-4 shrink-0 transition"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <p className="text-muted mt-2 text-xs leading-[1.33]">
        Use a different number from your personal WhatsApp account.
        <br />
        One number can only be associated with one WhatsApp account at a time.
      </p>
      {error && <p className="mt-2 text-xs leading-[1.33]">{error}</p>}
    </div>
  );
}
