"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

/** Local storage key holding the admin key; set it by hand in the browser's console. */
const STORAGE_KEY = "HUMANS_ADMIN_KEY";

function storedKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Read once on the client; set the key, then reload the page.
const noSubscribe = () => () => {};

/**
 * Admin mode: shown only when this browser's local storage has HUMANS_ADMIN_KEY. Signs in as
 * any email, no ticket; the server checks the key against its own.
 */
export function AdminSignIn() {
  const router = useRouter();
  const key = useSyncExternalStore(noSubscribe, storedKey, () => null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!key) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-humans-admin-key": key! },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { userId?: string; error?: string };
      if (res.status === 404) throw new Error("Admin key not accepted.");
      if (!res.ok || !data.userId) throw new Error(data.error || "Something went wrong. Try again.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto mt-6 w-full max-w-[420px] rounded-2xl border-2 border-dashed border-line p-4">
      <label htmlFor="admin-email" className="block text-sm font-semibold text-ink">
        Admin: sign in as
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="admin-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@example.com"
          className="min-w-0 flex-1 rounded-full border-2 border-line bg-card px-4 py-2 text-ink focus:border-violet focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="shrink-0 rounded-full bg-ink px-4 py-2 font-semibold text-white hover:bg-violet-deep disabled:opacity-50"
        >
          {busy ? "…" : "Go"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-raspberry">
          {error}
        </p>
      )}
    </form>
  );
}
