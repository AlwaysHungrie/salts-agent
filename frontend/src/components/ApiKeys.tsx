"use client";

import { useEffect, useState } from "react";
import { CopyField } from "@/components/GuideFields";

type Role = "admin" | "user";
type KeyInfo = { role: Role; hint: string; created_at: number };

const LABEL: Record<Role, { title: string; hint: string }> = {
  admin: {
    title: "Admin key",
    hint: "Does what this agent's admin can: meta settings, both keys, deletion.",
  },
  user: {
    title: "User key",
    hint: "Does what a member can: settings, sessions, messages and files.",
  },
};

const button =
  "border-hairline text-ink hover:bg-canvas-soft h-9 rounded-full border px-4 text-xs font-semibold transition disabled:opacity-40";

/**
 * The agent's API keys for `roles`, for calling the Worker without signing in. A key
 * is shown once, when it is generated; after that only its last four characters.
 */
export function ApiKeys({
  agentId,
  roles,
}: {
  agentId: string;
  roles: Role[];
}) {
  const base = `/api/agents/${encodeURIComponent(agentId)}/api-keys`;
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  /** The key just generated, shown in a dialog until it is dismissed, then never again. */
  const [shown, setShown] = useState<{ role: Role; key: string } | null>(null);
  const [busy, setBusy] = useState<Role | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch(base);
      const body = (await res.json()) as { keys?: KeyInfo[]; error?: string };
      if (!res.ok) setError(body.error ?? "Could not load API keys");
      else setKeys(body.keys ?? []);
    })();
  }, [base]);

  async function generate(role: Role, replacing: boolean) {
    if (
      replacing &&
      !confirm(
        `Replace the ${role} key? The current one stops working at once.`,
      )
    ) {
      return;
    }
    setBusy(role);
    setError("");
    const res = await fetch(`${base}/${role}`, { method: "POST" });
    const body = (await res.json()) as KeyInfo & {
      key?: string;
      error?: string;
    };
    setBusy(null);
    if (!res.ok || !body.key)
      return setError(body.error ?? "Could not generate the key");
    setShown({ role, key: body.key });
    setKeys((k) => [...(k ?? []).filter((x) => x.role !== role), body]);
  }

  async function revoke(role: Role) {
    if (
      !confirm(
        `Revoke the ${role} key? Anything using it stops working at once.`,
      )
    )
      return;
    setBusy(role);
    setError("");
    const res = await fetch(`${base}/${role}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) return setError("Could not revoke the key");
    setKeys((k) => (k ?? []).filter((x) => x.role !== role));
  }

  if (!keys) {
    return error ? <p className="text-muted text-xs">{error}</p> : null;
  }

  return (
    <div className="flex flex-col gap-5">
      {roles.map((role) => {
        const info = keys.find((k) => k.role === role);
        return (
          <div key={role}>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-faint tnum mt-1 text-xs">
                  {info
                    ? `Generated on ${new Date(info.created_at).toLocaleDateString()} (salt_u...${info.hint})`
                    : "No key yet"}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => void generate(role, !!info)}
                  disabled={busy !== null}
                  className={button}
                >
                  {info ? "Regenerate" : "Generate"}
                </button>
                {info && (
                  <button
                    onClick={() => void revoke(role)}
                    disabled={busy !== null}
                    className={button}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {error && <p className="text-muted text-xs">{error}</p>}
      {shown && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/30 px-5">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-canvas text-ink w-full max-w-md rounded-[20px] px-6 py-6 shadow-xl"
          >
            <p className="text-lg font-semibold leading-[1.38]">
              Your new {LABEL[shown.role].title.toLowerCase()}
            </p>
            <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
              This token will not be shown again. Do not share this with anyone.
              It can be used to access this agent as{" "}
              {shown.role === "admin" ? "an admin" : "a member"}.
              <br />
              <br /> To be used as Authorization: Bearer &lt;key&gt;
            </p>
            <CopyField value={shown.key} />
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setShown(null)}
                className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
