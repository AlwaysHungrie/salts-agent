"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge } from "./Badge";

/** The user picks up their badge by proving they hold a Devcon ticket with its .pkpass. */
export function UserIdForm() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function open() {
    setError("");
    dialog.current?.showModal();
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
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-[22px] bg-card p-6 text-ink shadow-badge backdrop:bg-ink/40"
      >
        <form onSubmit={submit} noValidate>
          <h2 id="badge-dialog-title" className="font-display text-2xl font-semibold tracking-tight">
            Add your Devcon ticket
          </h2>
          <p className="mt-3 text-sm text-ink-2">
            Add the <strong>.pkpass</strong> file that came with your ticket.
          </p>
          <p className="mt-3 text-sm text-ink-2">
            A .pkpass is only a digitally signed file. It proves you hold a Devcon ticket. Using it here does not change
            anything or affect your original ticket. We will not store it or share it with anyone.
          </p>
          <input
            type="file"
            accept=".pkpass,application/vnd.apple.pkpass"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError("");
            }}
            aria-describedby="badge-dialog-error"
            aria-invalid={!!error}
            className="mt-5 block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-paper file:px-4 file:py-2 file:font-semibold file:text-ink hover:file:bg-line"
          />
          <p id="badge-dialog-error" role="alert" className="mt-3 min-h-5 text-sm text-raspberry">
            {error}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="flex-1 rounded-full px-5 py-3 font-semibold text-ink-2 hover:bg-paper"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-full bg-ink px-5 py-3 font-semibold text-white transition-colors hover:bg-violet-deep disabled:opacity-60"
            >
              {busy ? "Checking…" : "Verify ticket"}
            </button>
          </div>
        </form>
      </dialog>
    </Badge>
  );
}
