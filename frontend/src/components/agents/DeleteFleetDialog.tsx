import type { FleetRow } from "@/lib/agent";
import { apiFetch } from "@/lib/identity";
import { useEffect, useRef, useState } from "react";

/**
 * Delete a fleet, and every agent inside it.
 *
 * The teardown is batched — a few agents per request, asked for over and over until
 * the Worker says none are left — because deleting one agent is several round trips
 * and a fleet can hold thousands. That is why this is a screen with a count on it
 * rather than a button that spins: it can take minutes, and what has already gone is
 * gone whether or not the tab stays open. The count says exactly that, so closing
 * early is an informed choice rather than a lost one.
 */
export function DeleteFleetDialog({
  fleet,
  onClose,
  onDone,
}: {
  fleet: FleetRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const name = fleet.fleet_name || "Fleet";
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  /** How many are still standing, once the first batch has answered. */
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const matches = typed === name;

  useEffect(() => {
    field.current?.focus();
  }, []);

  const run = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    // Batch after batch, each one complete in itself. A failure stops the loop
    // where it is: the agents already deleted stay deleted, and the count on screen
    // is what is left to do if it is tried again.
    for (;;) {
      const res = await apiFetch(
        `/api/agents?fleet=${encodeURIComponent(fleet.fleet_id)}&limit=10`,
        { method: "DELETE" },
      );
      const payload = (await res.json().catch(() => null)) as {
        deleted?: number;
        remaining?: number;
        done?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !payload || typeof payload.remaining !== "number") {
        setBusy(false);
        setError(payload?.error ?? "Couldn't finish deleting this fleet.");
        return;
      }
      setRemaining(payload.remaining);
      if (payload.done) break;
      // A batch that deleted nothing but says it is not done would spin forever.
      if (!payload.deleted) {
        setBusy(false);
        setError("Couldn't finish deleting this fleet.");
        return;
      }
    }
    setBusy(false);
    onDone();
  };

  const gone = remaining === null ? 0 : fleet.agents - remaining;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5">
      <div className="bg-canvas w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl">
        <p className="text-base font-semibold leading-[1.38]">Delete {name}?</p>
        <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
          You are about to delete {fleet.agents} agent
          {fleet.agents === 1 ? "" : "s"}. This will delete all chats, files,
          memories, settings, MCP connections and Telegram bots will stop
          answering.
          <br />
          <br />
          This action cannot be undone. Proceed with caution.
        </p>
        <label className="mt-4 block">
          <span className="text-muted block text-xs leading-[1.33]">
            Type <span className="text-ink font-semibold">{name}</span> to
            confirm
          </span>
          <input
            ref={field}
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "Escape" && !busy) onClose();
            }}
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none disabled:opacity-60"
          />
        </label>

        {(busy || remaining !== null) && (
          <p className="text-muted mt-3 text-xs leading-[1.33]">
            Deleted {gone} of {fleet.agents}
            {busy ? "…" : "."} {busy && "Do not leave this page."}
          </p>
        )}

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
            onClick={() => void run()}
            disabled={!matches || busy}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete fleet"}
          </button>
        </div>
      </div>
    </div>
  );
}
