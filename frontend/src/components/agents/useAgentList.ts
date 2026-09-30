import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/identity";
import { cached, keys, remember } from "@/lib/cache";
import type { AgentPage, AgentRow, FleetRow, MetaSettings } from "@/lib/agent";

/** What is kept of the list between visits. */
type HeldAgents = {
  agents: AgentRow[];
  cursor: string;
  fleets: FleetRow[];
  quota: { limit: number; owned: number } | null;
};

export type Quota = { limit: number; owned: number };

/**
 * The home page's list: agents outside this account's fleets (paged), its fleets, and its
 * agent ceiling. Starts from the last visit's copy.
 */
export function useAgentList(signedIn: boolean) {
  const held = signedIn ? cached<HeldAgents>(keys.agents) : undefined;
  const [agents, setAgents] = useState<AgentRow[] | null>(held?.agents ?? null);
  /** Where the list stopped. "" means exhausted. */
  const [cursor, setCursor] = useState(held?.cursor ?? "");
  const [fleets, setFleets] = useState<FleetRow[]>(held?.fleets ?? []);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * Agents deleted since the page loaded. An open fleet holds its own pages, so this
   * takes a deleted agent off them without re-reading the fleet.
   */
  const [removed, setRemoved] = useState<string[]>([]);
  /** Both numbers: the business-account screen quotes them back. */
  const [quota, setQuota] = useState<Quota | null>(held?.quota ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The first page of the list, and the fleets above it. Replaces what is on screen. */
  const load = useCallback(async () => {
    // Agents another app made for itself carry an `app` tag and are that app's to show.
    const res = await apiFetch(`/api/agents?without=app`, {
      cache: "no-store",
    });
    const payload = (await res.json().catch(() => null)) as
      | (AgentPage & {
          fleets?: FleetRow[];
          agent_limit?: number;
          agents_owned?: number;
          error?: string;
        })
      | null;
    if (!res.ok || !payload?.agents) {
      setError(
        payload?.error ?? "Couldn't load your agents. Refresh to try again.",
      );
      setAgents([]);
      return;
    }
    setAgents(payload.agents);
    setCursor(payload.has_more ? payload.cursor : "");
    setFleets(payload.fleets ?? []);
    setQuota(
      typeof payload.agent_limit === "number" &&
        typeof payload.agents_owned === "number"
        ? { limit: payload.agent_limit, owned: payload.agents_owned }
        : null,
    );
    setError(null);
  }, []);

  /** The page after the one on screen, appended. */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const res = await apiFetch(
      `/api/agents?without=app&cursor=${encodeURIComponent(cursor)}`,
      { cache: "no-store" },
    );
    const payload = (await res.json().catch(() => null)) as AgentPage | null;
    setLoadingMore(false);
    if (!res.ok || !payload?.agents) return;
    setAgents((current) => [...(current ?? []), ...payload.agents]);
    setCursor(payload.has_more ? payload.cursor : "");
  }, [cursor, loadingMore]);

  // Only signed-in visitors have agents to load.
  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      await load();
    })();
  }, [load, signedIn]);

  // Kept current as the list changes, so the next visit starts from here.
  useEffect(() => {
    if (!agents) return;
    remember<HeldAgents>(keys.agents, { agents, cursor, fleets, quota });
  }, [agents, cursor, fleets, quota]);

  /**
   * Create an agent or fleet and stay on this page. Returns the error to show, or null;
   * `onMade` runs before the reload.
   */
  const create = async (
    name: string,
    emails: string,
    meta: MetaSettings,
    fleetName: string,
    onMade?: () => void,
  ): Promise<string | null> => {
    setBusy(true);
    const res = await apiFetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `fleet_name` non-empty makes one agent per address; `meta` carries everything
      // the agents are created holding, OpenRouter key and default MCP servers included.
      body: JSON.stringify({ name, allowed_emails: emails, fleet_name: fleetName, meta }),
    });
    setBusy(false);
    // One agent comes back as itself; a fleet comes back as the list it made.
    const payload = (await res.json().catch(() => null)) as
      | (Partial<AgentRow> & { agents?: AgentRow[]; error?: string })
      | null;
    const made = payload?.agents ? payload.agents.length > 0 : !!payload?.id;
    if (!res.ok || !made) {
      return payload?.error ?? "Couldn't create that agent. Try again.";
    }
    onMade?.();
    await load();
    return null;
  };

  /**
   * Gone from every list the moment it is confirmed; the list is read back behind it
   * for the new count. A refused delete returns the row with the reason.
   */
  const remove = async (id: string) => {
    setRemoved((current) => [...current, id]);
    setAgents((current) => current?.filter((a) => a.id !== id) ?? current);
    const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await load();
      return;
    }
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    setRemoved((current) => current.filter((r) => r !== id));
    await load();
    setError(payload?.error ?? "Couldn't delete that agent. Try again.");
  };

  return {
    agents,
    cursor,
    fleets,
    loadingMore,
    removed,
    quota,
    error,
    busy,
    load,
    loadMore,
    create,
    remove,
  };
}
