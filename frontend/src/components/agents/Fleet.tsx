import type { AgentPage, AgentRow, FleetRow } from "@/lib/agent";
import { apiFetch } from "@/lib/identity";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { AgentListRow } from "./AgentListRow";

/**
 * One fleet: name and count, with its agents fetched a page at a time only once opened.
 * Fleets are listed apart so a thousand identical rows do not bury everyday agents.
 */
export function Fleet({
  fleet,
  email,
  removed,
  onMeta,
  onDelete,
  onDeleteFleet,
  onFleetSettings,
  onAddAgents,
}: {
  fleet: FleetRow;
  email: string;
  /** Agents deleted since this fleet was fetched, dropped from its pages without a re-read. */
  removed: string[];
  onMeta: (agent: AgentRow) => void;
  onDelete: (agent: AgentRow) => void;
  onDeleteFleet: (fleet: FleetRow) => void;
  onFleetSettings: (fleet: FleetRow) => void;
  onAddAgents: (fleet: FleetRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [cursor, setCursor] = useState("");
  const [busy, setBusy] = useState(false);

  /** One page of this fleet. `after` empty means the first, which replaces the rest. */
  const page = useCallback(
    async (after: string) => {
      setBusy(true);
      const res = await apiFetch(
        `/api/agents?fleet=${encodeURIComponent(fleet.fleet_id)}` +
          (after ? `&cursor=${encodeURIComponent(after)}` : ""),
        { cache: "no-store" },
      );
      const payload = (await res.json().catch(() => null)) as AgentPage | null;
      setBusy(false);
      if (!res.ok || !payload?.agents) return;
      setAgents((current) =>
        after ? [...(current ?? []), ...payload.agents] : payload.agents,
      );
      setCursor(payload.has_more ? payload.cursor : "");
    },
    [fleet.fleet_id],
  );

  // The first page loads on open, not on page load, and is kept across reopening.
  const toggle = () => {
    setOpen((was) => {
      if (!was && agents === null) void page("");
      return !was;
    });
  };

  const shown = agents?.filter((a) => !removed.includes(a.id)) ?? null;

  return (
    <div>
      {/* Deletes the whole fleet, so it asks by name in a dialog. */}
      <div className="from-accent/12 to-transparent hover:to-accent/5 bg-linear-to-r group flex items-center gap-3 rounded-2xl pr-5 transition">
        <button
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4 text-left"
        >
          <span className="text-muted shrink-0">
            {open ? (
              <ChevronDown size={16} strokeWidth={2} />
            ) : (
              <ChevronRight size={16} strokeWidth={2} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold leading-[1.38]">
              {fleet.fleet_name || "Fleet"}
            </span>
            <span className="text-faint block truncate text-xs leading-[1.33]">
              Manage fleet ({fleet.agents} agent{fleet.agents === 1 ? "" : "s"})
            </span>
          </span>
        </button>
        {/* The fleet's settings and adding agents belong to the fleet, not to any one agent. */}
        <button
          onClick={() => onFleetSettings(fleet)}
          className="text-muted hover:text-ink shrink-0 text-sm transition"
        >
          Fleet Settings
        </button>

        <button
          onClick={() => onAddAgents(fleet)}
          aria-label={`Add agent to fleet ${fleet.fleet_name || "Fleet"}`}
          className="text-muted hover:bg-canvas hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition"
        >
          +
        </button>

        <button
          onClick={() => onDeleteFleet(fleet)}
          aria-label={`Delete the fleet ${fleet.fleet_name || "Fleet"}`}
          className="text-muted hover:bg-canvas hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
        >
          ×
        </button>
      </div>

      {open && (
        /* Indented and ruled, so a long fleet still reads as something you are
           inside of rather than as the page's own list continuing. */
        <div className="border-hairline-soft ml-5 border-l pl-3 pt-3">
          {agents === null && busy && (
            <p className="text-muted px-5 py-3 text-sm leading-[1.43]">
              Loading…
            </p>
          )}
          {shown?.map((agent) => (
            <AgentListRow
              key={agent.id}
              agent={agent}
              email={email}
              onMeta={onMeta}
              onDelete={onDelete}
              showMeta={true}
            />
          ))}
          {shown && (
            <div className="flex items-center justify-center gap-3 px-5 py-3">
              {cursor && (
                <button
                  onClick={() => void page(cursor)}
                  disabled={busy}
                  className="text-muted hover:text-ink text-sm transition disabled:opacity-40"
                >
                  {busy ? "Loading…" : "Show more"}
                </button>
              )}
              <span className="text-faint text-xs leading-[1.33]">
                (Showing {shown.length} of {fleet.agents})
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
