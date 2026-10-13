"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Signs the user out, so a different ticket can be used. */
export function SwitchBadge() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    const res = await fetch("/api/badge", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      router.replace("/");
      router.refresh();
    } else setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="min-h-10 shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap font-medium text-ink-2 hover:bg-card hover:text-ink disabled:opacity-60"
    >
      Switch badge
    </button>
  );
}
