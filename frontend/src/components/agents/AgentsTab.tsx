import { Plus } from "lucide-react";
import type { AgentRow } from "@/lib/agent";
import { AgentListRow } from "./AgentListRow";
import type { Quota } from "./useAgentList";

/**
 * The agents tab: the account's own agents, the next page, the create tile (kept here
 * so an account with no agents still sees it) and the business-account tile.
 */
export function AgentsTab({
  agents,
  email,
  hasFleets,
  cursor,
  loadingMore,
  quota,
  onLoadMore,
  onMeta,
  onDelete,
  onCreate,
  onAskBusiness,
}: {
  agents: AgentRow[];
  email: string;
  /** Fleets sit to the right, so the list slides in from the left only when they exist. */
  hasFleets: boolean;
  cursor: string;
  loadingMore: boolean;
  quota: Quota | null;
  onLoadMore: () => void;
  onMeta: (agent: AgentRow) => void;
  onDelete: (agent: AgentRow) => void;
  onCreate: () => void;
  onAskBusiness: () => void;
}) {
  return (
    <div
      className={`${hasFleets ? "panel-from-left" : ""} mt-2 space-y-2`}
    >
      {agents.map((agent) => (
        <AgentListRow
          key={agent.id}
          agent={agent}
          email={email}
          onMeta={onMeta}
          onDelete={onDelete}
        />
      ))}

      {cursor && (
        <button
          onClick={onLoadMore}
          disabled={loadingMore}
          className="text-muted hover:text-ink w-full px-5 py-3 text-left text-sm transition disabled:opacity-40"
        >
          {loadingMore ? "Loading…" : "Show more agents"}
        </button>
      )}

      {quota && (
        <button
          disabled={Boolean(quota.owned >= quota.limit)}
          onClick={onCreate}
          className="disabled:opacity-30 disabled:cursor-not-allowed min-h-17 w-full bg-canvas-soft hover:bg-canvas-soft/60 group flex cursor-pointer items-center gap-3 rounded-2xl px-5 py-4 transition"
        >
          <Plus size={18} strokeWidth={2} />
          Create a new Agent
        </button>
      )}

      <div
        onClick={onAskBusiness}
        // Tinted: the one row that opens a commercial decision, in the accent the
        // screen behind it opens with.
        className="min-h-17 from-accent/12 group flex cursor-pointer items-center gap-3 rounded-2xl bg-linear-to-r to-transparent px-5 py-4 transition hover:to-accent/5"
      >
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold leading-[1.38]">
            Need more agents?
          </span>
          <span className="text-muted block text-xs leading-[1.33]">
            You can create and manage hundreds of agents for your friends and
            customers. <br />
            Click here to learn more.
          </span>
        </span>
      </div>
    </div>
  );
}
