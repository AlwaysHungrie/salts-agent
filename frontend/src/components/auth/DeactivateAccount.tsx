"use client";

import { useEffect, useState } from "react";

/**
 * Deactivating an account: deletes it and its sign-in for good. Only possible once the
 * user has no agents, no Tokens Wallet keys and no business numbers; until then the
 * dialog says what is left instead of offering the button. The address is typed in to
 * confirm, since nothing brings the account back.
 */
export function DeactivateAccount({
  email,
  onClose,
  onDone,
}: {
  email: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/account").catch(() => null);
      const body = (await res?.json().catch(() => null)) as {
        blockers?: string[];
        error?: string;
      } | null;
      if (!res?.ok || !body?.blockers) {
        setError(body?.error ?? "Couldn't check your account. Try again.");
        return;
      }
      setBlockers(body.blockers);
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const deactivate = async () => {
    setBusy(true);
    const res = await fetch("/api/account", { method: "DELETE" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      blockers?: string[];
      error?: string;
    } | null;
    if (!res?.ok) {
      setBusy(false);
      if (body?.blockers?.length) setBlockers(body.blockers);
      setError(body?.error ?? "Couldn't deactivate your account. Try again.");
      return;
    }
    onDone();
  };

  const confirmed = typed.trim().toLowerCase() === email.toLowerCase();
  const ready = blockers !== null && blockers.length === 0;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-5">
      <button
        onClick={() => !busy && onClose()}
        aria-label="Keep account"
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="deactivate-title"
        className="border-hairline bg-canvas text-ink relative w-full max-w-sm rounded-[20px] border p-6 shadow-xl"
      >
        <h2 id="deactivate-title" className="text-lg font-[650] leading-[1.35]">
          Deactivate your account?
        </h2>

        {blockers === null && !error && (
          <p className="text-muted mt-2 text-sm leading-normal">Checking your account…</p>
        )}

        {blockers !== null && blockers.length > 0 && (
          <>
            <p className="text-muted mt-2 text-sm leading-normal">
              Before you can deactivate your account:
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm leading-normal">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </>
        )}

        {ready && (
          <>
            <p className="text-muted mt-2 text-sm leading-normal">
              This deletes your account, your lists and your sign-in, and signs you out.
              You keep access to agents other people shared with you if you sign up again
              with the same email. This can&rsquo;t be undone.
            </p>
            <label className="mt-4 block text-xs font-medium">
              Type <span className="font-semibold">{email}</span> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                className="bg-field mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none"
              />
            </label>
          </>
        )}

        {error && <p className="text-muted mt-3 text-xs leading-[1.33]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            autoFocus
            className="border-hairline text-ink hover:bg-canvas-soft rounded-full border px-4 py-2 text-sm font-medium transition disabled:opacity-40"
          >
            {ready ? "Cancel" : "Close"}
          </button>
          {ready && (
            <button
              onClick={() => void deactivate()}
              disabled={!confirmed || busy}
              className="bg-ink text-on-primary rounded-full px-4 py-2 text-sm font-medium transition hover:opacity-85 disabled:opacity-40"
            >
              {busy ? "Deactivating…" : "Deactivate account"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
