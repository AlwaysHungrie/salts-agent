"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge } from "./Badge";

/** The user picks up their badge by proving they hold a Devcon ticket with its .pkpass. */
export function UserIdForm() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  function open() {
    setError("");
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
  }

  function pick(next: File | null) {
    if (input.current) input.current.value = "";
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".pkpass")) {
      setError("That isn’t a .pkpass file. Use the one that came with your ticket.");
      return;
    }
    setFile(next);
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose your .pkpass file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("pass", file);
      const res = await fetch("/api/badge", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { userId?: string; error?: string };
      if (!res.ok || !data.userId) throw new Error(data.error || "Something went wrong. Try again.");
      router.push(`/u/${encodeURIComponent(data.userId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <Badge strap="h-24 lg:h-40" className="badge-swing mx-auto w-full max-w-[420px]">
      <p className="font-display text-2xl font-semibold tracking-tight">Hello, I&rsquo;m</p>
      <div className="mt-2 border-b-2 border-line pb-2 font-display text-4xl font-bold tracking-tight text-line">
        Name Here
      </div>
      <p className="mt-3 text-sm text-ink-2">Devcon ticket required. Your name comes from your ticket.</p>
      <button
        type="button"
        onClick={open}
        className="mt-6 w-full rounded-full bg-ink px-5 py-3.5 font-semibold text-white transition-colors hover:bg-violet-deep"
      >
        Pick up my badge
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="badge-dialog-title"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-[22px] bg-card p-6 text-ink shadow-badge backdrop:bg-ink/40 backdrop:backdrop-blur-sm sm:p-7"
      >
        <form onSubmit={submit} noValidate>
          <div className="flex items-start justify-between gap-4">
            <h2 id="badge-dialog-title" className="font-display text-2xl font-semibold tracking-tight">
              Add your Devcon ticket
            </h2>
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="-mt-1 -mr-2 grid size-9 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-paper hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <p className="mt-2 text-sm text-ink-2">
            Use the <strong className="font-semibold text-ink">.pkpass</strong> file that came with your ticket.
          </p>

          <input
            ref={input}
            id="badge-pass"
            type="file"
            accept=".pkpass,application/vnd.apple.pkpass"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="mt-5 flex items-center gap-3 rounded-2xl border-2 border-violet bg-violet-soft px-4 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet text-white" aria-hidden>
                <TicketIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{file.name}</span>
                <span className="block text-sm text-ink-2">Ready to verify</span>
              </span>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold text-violet-deep hover:bg-card disabled:opacity-60"
              >
                Change
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                pick(e.dataTransfer.files[0] ?? null);
              }}
              aria-describedby={error ? "badge-dialog-error" : undefined}
              className={`mt-5 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors ${
                over ? "border-violet bg-violet-soft" : error ? "border-raspberry" : "border-line hover:border-violet hover:bg-violet-soft/50"
              }`}
            >
              <span className="grid size-11 place-items-center rounded-xl bg-violet-soft text-violet" aria-hidden>
                <TicketIcon />
              </span>
              <span className="font-medium">
                Drop your .pkpass here or <span className="text-violet underline underline-offset-4">choose a file</span>
              </span>
              <span className="text-sm text-ink-2">Find it in your ticket email or Apple Wallet</span>
            </button>
          )}

          {error && (
            <p id="badge-dialog-error" role="alert" className="mt-3 text-sm text-raspberry">
              {error}
            </p>
          )}

          <div className="mt-5 flex gap-3 rounded-2xl bg-paper p-4 text-sm text-ink-2">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden className="mt-0.5 shrink-0 text-teal">
              <path
                d="M10 2 3.5 4.5v5c0 4 2.8 7.2 6.5 8.5 3.7-1.3 6.5-4.5 6.5-8.5v-5L10 2Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              <path d="m7 10 2.2 2.2L13.5 8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p>
              A .pkpass is only a signed file that proves you hold a ticket. Using it here doesn&rsquo;t change your
              ticket, and we don&rsquo;t store or share it.
            </p>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              onClick={close}
              className="flex-1 rounded-full border-2 border-line px-5 py-3 font-semibold text-ink hover:border-ink-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !file}
              className="flex-1 rounded-full bg-ink px-5 py-3 font-semibold text-white transition-colors hover:bg-violet-deep disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-ink"
            >
              {busy ? "Checking…" : "Verify ticket"}
            </button>
          </div>
        </form>
      </dialog>
    </Badge>
  );
}

function TicketIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <path
        d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5V8a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V12a2 2 0 0 0 0-4V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12 4.5v11" stroke="currentColor" strokeWidth="1.7" strokeDasharray="1.6 2" />
    </svg>
  );
}
