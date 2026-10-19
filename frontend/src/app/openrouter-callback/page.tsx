"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@/components/wallet/useWallet";
import { finishConnect } from "@/lib/openrouter-connect";

/**
 * Where OpenRouter drops the browser back off after "Connect OpenRouter": trade the
 * code for a key, put it in the wallet, and go back to the page the user left.
 */
export default function Page() {
  const router = useRouter();
  const { add } = useWallet();
  const [error, setError] = useState<string | null>(null);
  /** The code can be traded once; this keeps a second effect run from trying again. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const code = new URLSearchParams(window.location.search).get("code");
      if (!code) {
        setError("OpenRouter didn't send a code back. Start again from your wallet.");
        return;
      }
      const result = await finishConnect(code);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const failed = await add(result.key);
      if (failed) setError(failed);
      else router.replace(result.back);
    })();
  }, [add, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-5 text-center">
      <p className="text-muted text-sm leading-[1.43]">
        {error ?? "Adding your new OpenRouter key…"}
      </p>
      {error && (
        <Link
          href="/"
          className="border-hairline text-ink hover:bg-canvas-soft rounded-full border px-5 py-2 text-sm font-semibold transition"
        >
          Back to Salts
        </Link>
      )}
    </div>
  );
}
