"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { AuthModal } from "@/components/auth/AuthModal";
import { FrontDoor } from "@/components/agents/FrontDoor";
import { useIdentity } from "@/lib/identity";
import type { AgentRow } from "@/lib/agent";

type Pairing = { name: string; approved: boolean };

/** Every agent the caller can open, page after page. */
async function allAgents(): Promise<AgentRow[]> {
  const out: AgentRow[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`/api/agents?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!res.ok) break;
    const page = (await res.json()) as { agents: AgentRow[]; has_more: boolean; cursor: string };
    out.push(...page.agents);
    if (!page.has_more || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/**
 * Where `npx salts-tools` sends the browser: the computer's code, and the agents it
 * should serve. Approving hands the computer its credential; nothing is copied by hand.
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
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!ready || !signedIn || !code) return;
    void (async () => {
      setError("");
      const res = await fetch(`/api/salts/pair/${encodeURIComponent(code)}`);
      const body = (await res.json().catch(() => ({}))) as Pairing & { error?: string };
      if (!res.ok) {
        setPairing(null);
        setError(body.error ?? "This code was not found.");
        return;
      }
      setPairing(body);
      const list = await allAgents();
      setAgents(list);
      // One agent: nothing to choose.
      if (list.length === 1) setChosen(new Set([list[0].id]));
    })();
  }, [ready, signedIn, code]);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const connect = async () => {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/salts/pair/${encodeURIComponent(code)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_ids: [...chosen] }),
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
        <h1 className="mt-4 text-[32px] font-[650] leading-[1.2]">Connect a computer.</h1>
        <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
          salts-tools runs web search, the matchmaker and the spreadsheet analyst on
          your own computer. Choose which of your agents this computer serves.
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
          <div className="mt-8 space-y-4">
            <div className="bg-canvas-soft rounded-2xl px-5 py-4 text-sm leading-[1.43]">
              <span className="font-semibold">{pairing?.name}</span> is connected. Your
              terminal will carry on by itself. Next, switch on the tools you want for
              each agent.
            </div>
            <Link
              href="/salts-tools"
              className="bg-ink text-on-primary inline-flex h-10 items-center rounded-full px-5 text-sm font-semibold"
            >
              Choose tools
            </Link>
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
                  connect, with the code <span className="font-semibold">{code}</span>.
                  Check it matches your terminal.
                </p>
                {agents === null && <p className="text-muted py-4 text-sm">Loading your agents…</p>}
                {agents && agents.length === 0 && (
                  <p className="text-muted py-4 text-sm">
                    You have no agents yet. <Link href="/" className="underline">Create one</Link> first.
                  </p>
                )}
                {agents && agents.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {agents.map((agent) => {
                      const on = chosen.has(agent.id);
                      return (
                        <li key={agent.id}>
                          <button
                            onClick={() => toggle(agent.id)}
                            aria-pressed={on}
                            className="bg-canvas-soft hover:bg-canvas-soft/60 flex w-full items-center gap-3 rounded-2xl px-5 py-4 text-left text-sm transition"
                          >
                            <span
                              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                                on ? "bg-ink border-ink text-on-primary" : "border-hairline"
                              }`}
                            >
                              {on && <Check size={14} strokeWidth={3} />}
                            </span>
                            {agent.name}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button
                  onClick={() => void connect()}
                  disabled={busy || chosen.size === 0}
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
