"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveProfile } from "@/lib/profile";

/** Signs the user out, so a different ticket can be used. */
export function SwitchBadge() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    const res = await fetch("/api/badge", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      saveProfile(null);
      router.replace("/");
      router.refresh();
    } else setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="min-h-10 shrink-0 rounded-full py-1.5 text-sm whitespace-nowrap text-white/45 transition-colors hover:text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
    >
      Sign out
    </button>
  );
}
