"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthModal } from "@/components/auth/AuthModal";
import { FrontDoor } from "@/components/agents/FrontDoor";
import { useIdentity } from "@/lib/identity";

type Pairing = { name: string; approved: boolean };

/**
 * Where `npx salts-tools` sends the browser: the one step done here. The signed-in user
 * checks the computer's code and connects it to their account; agents and tools are
 * chosen back in the terminal.
 */
export default function Pair({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code: given = "" } = use(searchParams);
  const { ready, signedIn } = useIdentity();
  const [authing, setAuthing] = useState(false);
  const [code, setCode] = useState(given.toUpperCase());
  const [typed, setTyped] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!ready || !signedIn || !code) return;
    void (async () => {
      const res = await fetch(`/api/salts/pair/${encodeURIComponent(code)}`);
      const body = (await res.json().catch(() => ({}))) as Pairing & { error?: string };
      if (!res.ok) {
        setPairing(null);
        setError(body.error ?? "This code was not found.");
        return;
      }
      setError("");
      setPairing(body);
    })();
  }, [ready, signedIn, code]);

  const connect = async () => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/salts/pair/${encodeURIComponent(code)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "Could not connect. Try again.");
    setDone(true);
  };

  return (
    <div className="bg-canvas text-ink min-h-screen">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <Link
          href="/"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm transition-colors"
        >
          <ArrowLeft size={14} /> Agents
        </Link>
        <h1 className="mt-4 text-[32px] font-[650] leading-[1.2]">Pair Salts tools</h1>
        <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
          Salts tools are a collection of local MCP servers (web search, the matchmaker and
          the spreadsheet analyst) that run on your computer. Pairing links this computer
          to your Salts account so your agents can use them.
        </p>

        {!ready && <p className="text-muted py-4 text-sm">Loading…</p>}
        {ready && !signedIn && <FrontDoor onConnect={() => setAuthing(true)} />}

        {ready && signedIn && !code && (
          <form
            className="mt-8 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setCode(typed.trim().toUpperCase());
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Code shown in your terminal, e.g. ABCD-EFGH"
              className="bg-field placeholder:text-faint w-full rounded-2xl px-4 py-3 text-sm outline-none"
            />
            <button className="bg-ink text-on-primary h-11 shrink-0 rounded-full px-5 text-sm font-semibold">
              Continue
            </button>
          </form>
        )}

        {error && (
          <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
            {error}
          </div>
        )}

        {done && (
          <div className="bg-canvas-soft mt-8 rounded-2xl px-5 py-4 text-sm leading-[1.43]">
            <span className="font-semibold">{pairing?.name}</span> is paired. You can close
            this page and use the salts-tools CLI to connect agents and turn on local MCP
            tools.
          </div>
        )}

        {!done && pairing && (
          <div className="mt-8">
            {pairing.approved ? (
              <p className="text-sm">This computer is already connected.</p>
            ) : (
              <>
                <p className="text-sm leading-[1.43]">
                  <span className="font-semibold">{pairing.name}</span> is asking to
                  connect to your account with the code{" "}
                  <span className="font-semibold">{code}</span>. Check it matches your
                  terminal.
                </p>
                <button
                  onClick={() => void connect()}
                  disabled={busy}
                  className="bg-ink text-on-primary mt-6 h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
                >
                  {busy ? "Connecting…" : "Connect"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {authing && <AuthModal mode="sign-in" onClose={() => setAuthing(false)} />}
    </div>
  );
}
