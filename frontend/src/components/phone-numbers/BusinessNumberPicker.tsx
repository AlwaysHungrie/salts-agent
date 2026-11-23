"use client";

import { useCallback, useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { PhoneNumbersPanel, shownNumber } from "./PhoneNumbersPanel";

/** The number an agent answers on, as `/api/agents/:id/config` shows it. */
export type BusinessNumber = { id: string; number: string } | null;

/** One number in the caller's Business Phone Numbers, with the agent it answers for. */
type WalletNumber = {
  id: string;
  number: string;
  agent_id: string;
  agent_name: string;
};

/** The caller's numbers, or the error the Worker answered with. */
async function readNumbers(): Promise<{
  numbers: WalletNumber[];
  error: string | null;
}> {
  const res = await fetch("/api/phone-numbers", { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as {
    numbers?: WalletNumber[];
    error?: string;
  } | null;
  if (!res.ok)
    return { numbers: [], error: body?.error ?? "Couldn't load your numbers." };
  return { numbers: body?.numbers ?? [], error: null };
}

/** Stands for an agent's number that is in someone else's wallet. */
const ELSEWHERE = "__elsewhere";
/** Stands for the value while the wallet is still loading. */
const LOADING = "__loading";

/**
 * Which of the caller's Business Phone Numbers this agent answers on: a dropdown, laid
 * out like the key picker. A number answers for one agent only, so one already given to
 * another agent is shown but can't be picked.
 */
export function BusinessNumberPicker({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: BusinessNumber;
  onChange: (next: BusinessNumber) => void;
}) {
  const [numbers, setNumbers] = useState<WalletNumber[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    (read: Awaited<ReturnType<typeof readNumbers>>) => {
      setNumbers(read.numbers);
      setError(read.error);
    },
    [],
  );
  const load = useCallback(async () => apply(await readNumbers()), [apply]);

  useEffect(() => {
    void readNumbers().then(apply);
  }, [apply]);

  const pick = async (id: string) => {
    setSaving(true);
    setError(null);
    const res = await fetch(
      `/api/agents/${encodeURIComponent(agentId)}/business-number`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number_id: id }),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      business_number?: BusinessNumber;
      error?: string;
    } | null;
    setSaving(false);
    if (!res.ok) {
      setError(body?.error ?? "Couldn't save the number.");
      return;
    }
    onChange(body?.business_number ?? null);
    await load();
  };

  const loading = numbers === null;
  const list = numbers ?? [];
  const elsewhere = !!value && !list.some((n) => n.id === value.id);
  const selected = loading
    ? LOADING
    : elsewhere
      ? ELSEWHERE
      : (value?.id ?? "");

  return (
    <div>
      <div className="relative">
        <select
          value={selected}
          onChange={(e) => {
            if (e.target.value !== ELSEWHERE) void pick(e.target.value);
          }}
          disabled={loading || saving}
          aria-label="Business number"
          className="bg-field text-ink focus:ring-ink w-full appearance-none rounded-2xl py-3 pr-12 pl-4 text-sm outline-none focus:ring-2"
        >
          {loading && <option value={LOADING}>Loading your numbers…</option>}
          {!loading && (
            <option value="">
              {list.length ? "No number" : "No numbers yet"}
            </option>
          )}
          {!loading && elsewhere && value && (
            <option value={ELSEWHERE}>
              {shownNumber(value.number)} (someone else&apos;s)
            </option>
          )}
          {list.map((n) => {
            const taken = !!n.agent_id && n.agent_id !== agentId;
            return (
              <option key={n.id} value={n.id} disabled={taken}>
                {shownNumber(n.number)}
                {taken ? ` (used by ${n.agent_name || "another agent"})` : ""}
              </option>
            );
          })}
        </select>
        <button
          onClick={() => setOpen(true)}
          title="Open Business Phone Numbers"
          aria-label="Open Business Phone Numbers"
          className="text-muted hover:text-ink absolute top-1/2 right-4 -translate-y-1/2 transition"
        >
          <Phone size={16} />
        </button>
      </div>
      {!loading && !list.length && !elsewhere && (
        <p className="text-muted mt-2 text-xs font-light leading-[1.33]">
          Add or buy a number in{" "}
          <button
            onClick={() => setOpen(true)}
            className="text-ink font-normal underline underline-offset-2"
          >
            Business Phone Numbers
          </button>{" "}
          first.
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs leading-[1.33]">{error}</p>
      )}
      {open && (
        <PhoneNumbersPanel
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
