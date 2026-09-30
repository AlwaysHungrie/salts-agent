import type { AgentRow, FleetRow } from "@/lib/agent";
import { apiFetch } from "@/lib/identity";
import { useState } from "react";

/**
 * Grow a fleet: addresses in, one agent each, created holding the fleet's own
 * settings rather than anything typed here. That is the whole point of it being a
 * fleet — an agent added in a year's time is the same agent as the first one.
 */
export function AddFleetAgentsDialog({
  fleet,
  onClose,
  onAdded,
}: {
  fleet: FleetRow;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same shape check the Worker applies, and repeats kept for the same reason:
  // the same address twice is two agents for that person.
  const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const typed = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const members = typed.filter(isEmail);
  const rejected = typed.filter((e) => !isEmail(e));

  const submit = async () => {
    if (!members.length || busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(
      `/api/fleets/${encodeURIComponent(fleet.fleet_id)}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_emails: members.join("\n") }),
      },
    );
    setBusy(false);
    const payload = (await res.json().catch(() => null)) as {
      agents?: AgentRow[];
      error?: string;
    } | null;
    if (!res.ok || !payload?.agents) {
      setError(payload?.error ?? "Couldn't add those agents.");
      return;
    }
    onAdded();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-canvas w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg font-semibold leading-[1.38]">
          Add agents to {fleet.fleet_name || "this fleet"}
        </p>
        <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
          Space separated
        </p>

        <label className="mt-4 block">
          <span className="block text-sm font-semibold leading-[1.43]">
            Email addresses
          </span>
          <textarea
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            rows={3}
            autoFocus
            placeholder="ana@example.com ben@example.com"
            className="bg-field placeholder:text-faint mt-2 w-full resize-none rounded-2xl px-4 py-3 text-sm outline-none"
          />
          <span className="text-faint mt-2 block text-xs leading-[1.33]">
            {members.length === 0
              ? "Add at least one address."
              : `Adding ${members.length} agent${members.length === 1 ? "" : "s"} to this fleet.`}
          </span>
          {rejected.length > 0 && (
            <span className="text-faint mt-1 block text-xs leading-[1.33]">
              Found {rejected.length} invalid email addresses.
            </span>
          )}
        </label>

        {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || members.length === 0}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add agents"}
          </button>
        </div>
      </div>
    </div>
  );
}
