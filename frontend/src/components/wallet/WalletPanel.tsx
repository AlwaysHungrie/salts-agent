"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Copy, Link2, Wallet, X } from "lucide-react";
import type { WalletKey } from "@/lib/agent";
import { formatUsdShort } from "@/lib/format";
import { startConnect } from "@/lib/openrouter-connect";
import { BuyCredits } from "./BuyCredits";
import { PayOption } from "./PayOption";
import { forgetPayment, sentPayments } from "./sentPayments";
import { useWallet } from "./useWallet";

/** Opens the wallet sidebar; `onClose` runs once it shuts, e.g. to reread the wallet. */
const WalletPanelContext = createContext<(onClose?: () => void) => void>(
  () => {},
);

/** Open the one OpenRouter wallet sidebar from anywhere under the provider. */
export function useWalletPanel() {
  return useContext(WalletPanelContext);
}

/** Holds the app's single wallet sidebar, shut until something asks for it. */
export function WalletPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const after = useRef<(() => void) | undefined>(undefined);

  const show = useCallback((onClose?: () => void) => {
    after.current = onClose;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    after.current?.();
    after.current = undefined;
  }, []);

  return (
    <WalletPanelContext.Provider value={show}>
      {children}
      {open && <WalletSidebar onClose={close} />}
    </WalletPanelContext.Provider>
  );
}

/** How long the sidebar takes to slide in or out. */
const SLIDE_MS = 200;

/**
 * The caller's OpenRouter wallet, as a sidebar from the right: every key they may give an
 * agent, by nickname, and the ways to get one. A pasted key can be seen and removed; a
 * bought one is never shown.
 */
function WalletSidebar({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  /** Whether the crypto checkout for a new key is open. */
  const [buying, setBuying] = useState(false);
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

  return (
    <div className="fixed inset-0 z-60">
      <div
        onClick={dismiss}
        className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="OpenRouter wallet"
        className={`bg-canvas text-ink absolute inset-y-0 right-0 flex w-full max-w-md flex-col shadow-xl transition-transform duration-200 ease-out ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="border-hairline-soft flex items-center gap-2 border-b px-6 py-4">
          {buying && (
            <button
              onClick={() => setBuying(false)}
              aria-label="Back to wallet"
              className="text-muted hover:bg-canvas-soft hover:text-ink -ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold leading-[1.38]">
              {buying ? "Get key" : "OpenRouter wallet"}
            </p>
            <p className="text-muted text-xs font-light leading-[1.33]">
              {buying
                ? "Get a new OpenRouter API key"
                : "Manage your OpenRouter API keys."}
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

        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-6 flex flex-col">
          {buying ? (
            <BuyCredits
              networks={wallet.networks}
              feeBps={wallet.feeBps}
              maxUsd={wallet.maxUsd}
              reownProjectId={wallet.reownProjectId}
              calls={{
                quote: wallet.quote,
                confirm: wallet.confirm,
              }}
              onPaid={() => void wallet.load()}
            />
          ) : (
            <>
              {wallet.error && (
                <p className="mb-4 text-xs leading-[1.33]">{wallet.error}</p>
              )}
              <ResumePayments recover={wallet.recover} />

              <div className="space-y-3 flex flex-1 flex-col">
                {wallet.keys === null && (
                  <p className="text-muted py-4 my-auto text-center flex-1 text-sm leading-[1.43]">
                    Loading your keys…
                  </p>
                )}
                {wallet.keys?.length === 0 && (
                  <p className="text-muted py-4 my-auto text-center flex-1 text-sm leading-[1.43]">
                    No keys yet.
                  </p>
                )}
                {wallet.keys?.map((key) => (
                  <KeyRow
                    key={key.id}
                    walletKey={key}
                    onRemove={() => wallet.remove(key.id)}
                  />
                ))}
              </div>

              <p className="text-muted mt-8 mb-3 text-xs font-medium">
                Get new key
              </p>
              <div className="space-y-3">
                <PayOption
                  icon={<Wallet className="h-4 w-4" />}
                  title="Pay with crypto"
                  note="USDC or ETH on Ethereum, Base, Solana and more"
                  onClick={() => setBuying(true)}
                />
                <PayOption
                  icon={<Link2 className="h-4 w-4" />}
                  title="Connect OpenRouter"
                  note="Sign in to OpenRouter and approve a key"
                  onClick={() => void startConnect()}
                />
              </div>

              {wallet.networks.length > 0 && (
                <RecoverPayment
                  networks={wallet.networks}
                  recover={wallet.recover}
                />
              )}

              <div className="text-muted mt-8 mb-3 text-xs font-medium flex">
                <span>Already have a key?</span>
                <a
                  href="/guide/openrouter"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-ink ml-auto"
                >
                  (OpenRouter guide)
                </a>
              </div>
              <AddKey onAdd={wallet.add} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** One key, laid out like a pricing card: its name, what it may still spend, its details. */
function KeyRow({
  walletKey: key,
  onRemove,
}: {
  walletKey: WalletKey;
  onRemove: () => Promise<string | null>;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  const copy = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const usedBy =
    key.agents === 0
      ? "Not used by any agent yet."
      : `Used by ${key.agents === 1 ? "1 agent" : `${key.agents} agents`}.`;

  return (
    <div className="ring-hairline-soft rounded-[24px] p-6 ring-1">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 truncate text-xl font-semibold leading-[1.3]">
          {key.nickname}
        </p>
        {!confirming && (
          <div className="flex shrink-0 gap-2">
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

      <div className="text-muted mt-5 flex items-center justify-between gap-3 text-sm leading-[1.43]">
        <p className="min-w-0">{usedBy}</p>
        {key.key !== null ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span>{`${key.key.slice(0, 4)}...${key.key.slice(-4)}`}</span>
            <button
              onClick={() => void copy(key.key ?? "")}
              title={copied ? "Copied" : "Copy key"}
              aria-label={copied ? "Copied" : "Copy key"}
              className="hover:text-ink transition"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        ) : (
          <span className="shrink-0">
            Purchased{" "}
            {new Date(key.created_at).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
              year: "2-digit",
            })}
          </span>
        )}
      </div>

      {confirming && key.kind === "provisioned" && (
        <RemoveBoughtKey
          walletKey={key}
          busy={busy}
          onKeep={() => setConfirming(false)}
          onRemove={() => void run(onRemove)}
        />
      )}

      {confirming && key.kind !== "provisioned" && (
        <div className="bg-canvas-soft mt-5 rounded-2xl px-4 py-4">
          <p className="text-sm leading-[1.43]">
            {key.agents === 0
              ? "Remove this key from your wallet?"
              : `Remove this key? ${key.agents === 1 ? "1 agent" : `${key.agents} agents`} will stop replying until given another.`}
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

      {error && <p className="mt-3 text-sm leading-[1.43]">{error}</p>}
    </div>
  );
}

/**
 * Removing a bought key: its credit was paid for and goes with it, so the nickname must be
 * typed exactly, as for deleting an agent. Drawn on the page body, as the sidebar's slide
 * would otherwise contain it.
 */
function RemoveBoughtKey({
  walletKey: key,
  busy,
  onKeep,
  onRemove,
}: {
  walletKey: WalletKey;
  busy: boolean;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const matches = typed === key.nickname;
  const left =
    key.valid && key.remaining !== null ? formatUsdShort(key.remaining) : null;

  // Escape keeps the key and leaves the sidebar open: caught before the sidebar's own.
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

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-center justify-center bg-black/30 px-5">
      <div
        role="alertdialog"
        aria-modal="true"
        className="bg-canvas text-ink w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl"
      >
        <p className="text-base font-semibold leading-[1.38]">
          Remove {key.nickname}?
        </p>
        <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
          {left
            ? `The ${left} of credit left on this key`
            : "Any credit left on this key"}{" "}
          will be lost forever. It can&rsquo;t be refunded or moved to another
          key.
          {key.agents > 0 &&
            ` ${key.agents === 1 ? "1 agent" : `${key.agents} agents`} using it will stop replying until given another.`}
          <br />
          <br />
          This can&rsquo;t be undone.
        </p>
        <label className="mt-4 block">
          <span className="text-muted block text-xs leading-[1.33]">
            Type <span className="text-ink font-semibold">{key.nickname}</span>{" "}
            to confirm
          </span>
          <input
            ref={field}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches && !busy) onRemove();
            }}
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onKeep}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={onRemove}
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
    <div>
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
          className="bg-field placeholder:text-faint focus:ring-ink h-11 w-full rounded-2xl px-4 text-sm outline-none focus:ring-2"
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

type Recover = ReturnType<typeof useWallet>["recover"];

/**
 * Checks again the payments this browser sent but never saw a key for (the page was
 * refreshed or closed, or the network was down), once each time the wallet opens.
 */
function ResumePayments({ recover }: { recover: Recover }) {
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void (async () => {
      for (const sent of sentPayments()) {
        if (!live) return;
        setNotes((n) => [
          ...n,
          `Checking a payment you sent (${sent.tx.slice(0, 10)}…)`,
        ]);
        const verdict = await recover(sent.network, sent.tx);
        if (
          verdict === "paid" ||
          verdict === "already" ||
          (typeof verdict === "object" && verdict.final)
        ) {
          forgetPayment(sent.tx);
        }
        if (!live) return;
        const line =
          verdict === "paid" || verdict === "already"
            ? "A payment you sent went through, and its key is in your wallet."
            : verdict === "pending"
              ? "A payment you sent isn't final yet. We'll check it again next time you open your wallet."
              : verdict.final
                ? verdict.error
                : `${verdict.error} We'll check it again next time you open your wallet.`;
        setNotes((n) => [...n.slice(0, -1), line]);
      }
    })();
    return () => {
      live = false;
    };
  }, [recover]);

  if (!notes.length) return null;
  return (
    <div className="bg-canvas-soft mb-4 space-y-1 rounded-2xl px-4 py-3 text-xs leading-[1.33]">
      {notes.map((note, i) => (
        <p key={i}>{note}</p>
      ))}
    </div>
  );
}

/**
 * Paste a payment's transaction id to get the key it paid for, when the page lost it. A
 * link in the sidebar opens a dialog on the page body, as the sidebar's slide would
 * otherwise contain it.
 */
function RecoverPayment({
  networks,
  recover,
}: {
  networks: { id: string; label: string }[];
  recover: Recover;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-muted hover:text-ink mt-3 text-xs underline underline-offset-2"
      >
        Paid but didn&apos;t get a key?
      </button>
      {open && (
        <RecoverDialog networks={networks} recover={recover} onClose={close} />
      )}
    </>
  );
}

function RecoverDialog({
  networks,
  recover,
  onClose,
}: {
  networks: { id: string; label: string }[];
  recover: Recover;
  onClose: () => void;
}) {
  const [network, setNetwork] = useState(networks[0]?.id ?? "");
  const [tx, setTx] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const ready = tx.trim() !== "" && network !== "";

  // Escape closes the dialog and leaves the sidebar open: caught before the sidebar's own.
  useEffect(() => {
    field.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setNote(null);
    const verdict = await recover(network, tx.trim());
    setBusy(false);
    if (verdict === "paid" || verdict === "already") {
      forgetPayment(tx.trim());
      setTx("");
      setNote(
        verdict === "already"
          ? "Transaction confirmed. The key has already been added to your wallet."
          : "Transaction confirmed. The key has been added to your wallet.",
      );
    } else if (verdict === "pending") {
      setNote("That payment isn't final yet. Try again in a minute.");
    } else {
      setNote(
        verdict.final ? "Couldn't find that payment. Check the network and the transaction ID." : verdict.error,
      );
    }
  };

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/30 px-5"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recover a payment"
        onClick={(e) => e.stopPropagation()}
        className="bg-canvas text-ink w-full max-w-md rounded-[20px] px-6 py-6 shadow-xl"
      >
        <div className="flex items-start gap-2">
          <p className="flex-1 text-base font-semibold leading-[1.38]">
            Recover a lost payment
          </p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:bg-canvas-soft hover:text-ink -mr-2 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-muted mt-2 mb-4 text-sm font-light leading-[1.43]">
          Paid, but no key showed up in your wallet? Enter the payment details
          below and we&rsquo;ll look for it.
        </p>
        <div className="flex flex-col gap-2">
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            aria-label="Network"
            className="bg-field h-11 w-full rounded-2xl px-3 text-sm outline-none"
          >
            {networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          <input
            ref={field}
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            autoComplete="off"
            placeholder="Transaction id"
            aria-label="Transaction id"
            className="bg-field placeholder:text-faint focus:ring-ink h-11 w-full rounded-2xl px-4 text-sm outline-none focus:ring-2"
          />
        </div>
        {note && <p className="mt-3 text-xs leading-[1.33]">{note}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Close
          </button>
          <button
            onClick={() => void submit()}
            disabled={!ready || busy}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Get my key"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
