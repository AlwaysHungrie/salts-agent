"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveProfile } from "@/lib/profile";

/** Signs the user out, so a different ticket can be used. */
export function SwitchBadge({ className }: { className: string }) {
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
      className={className}
    >
      SIGN OUT
    </button>
  );
}
