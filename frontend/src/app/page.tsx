"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Plus, Settings } from "lucide-react";
import { AuthModal } from "@/components/auth/AuthModal";
import { apiFetch, useIdentity } from "@/lib/identity";
import { UserMenu } from "@/components/auth/UserMenu";
import {
  MetaSettingsDialog,
  MetaSettingsForm,
} from "@/components/MetaSettings";
import {
  EMPTY_META,
  type AgentPage,
  type AgentRow,
  type Capability,
  type FleetRow,
  type MetaSettings,
  type McpCatalogEntry,
  type ModelOption,
} from "@/lib/agent";

/**
 * Every agent in this deployment.
 *
 * Agents are separate all the way down — their own bot, their own OpenRouter key,
 * their own MCP servers, their own memory, their own sessions. So this page is a
 * list of doors and nothing more: there is no switcher, because there is nothing
 * shared to switch between. Opening one goes to its own page and stays there.
 */
export default function Agents() {
  /**
   * Whoever this browser is acting as — a Clerk session, or an address typed into the
   * back door. The rest of this page does not care which: an address is an address,
   * and it is what decides admin from user on every row.
   */
  const { ready: isLoaded, signedIn: isSignedIn, email } = useIdentity();
  /**
   * The agents on this page that are not inside a fleet this account administers —
   * one's own agents, and the one agent somebody else's fleet made for them. Loaded
   * a page at a time, and appended to as the list is read down.
   */
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  /** Where that list stopped, and whether there is more of it. "" means exhausted. */
  const [cursor, setCursor] = useState("");
  /**
   * The fleets this account administers: a name and a count each, never the agents.
   * They get their own tab — see `Fleet` for why the two lists are kept apart
   * rather than merged and sorted together.
   */
  const [fleets, setFleets] = useState<FleetRow[]>([]);
  /** Whether another page of the list below is being fetched. */
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * Agents deleted since the page was loaded. An open fleet holds its own pages, so
   * this is what takes a deleted agent off them without re-reading the fleet.
   */
  const [removed, setRemoved] = useState<string[]>([]);
  /**
   * The ceiling on this account and how much of it is used, from the last load.
   * Both numbers, not just "is it full": the business-account screen quotes them
   * back, so the ask is made against what the account actually has today.
   */
  const [quota, setQuota] = useState<{ limit: number; owned: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The agent the delete dialog is asking about, if it is open. */
  const [confirming, setConfirming] = useState<AgentRow | null>(null);
  /** The fleet the fleet-delete dialog is asking about, if it is open. */
  const [confirmingFleet, setConfirmingFleet] = useState<FleetRow | null>(null);
  /** The fleet whose own settings — the ones every agent in it is written from — are open. */
  const [settingsFleet, setSettingsFleet] = useState<FleetRow | null>(null);
  /** The fleet that agents are being added to, if that dialog is open. */
  const [addingTo, setAddingTo] = useState<FleetRow | null>(null);
  /** Whether the new-agent dialog is up. */
  const [creating, setCreating] = useState(false);
  /** The agent whose meta settings — the defaults behind its settings — are open. */
  const [metaFor, setMetaFor] = useState<AgentRow | null>(null);
  /** Whether the sign-in dialog is up. */
  const [authing, setAuthing] = useState(false);
  /** Whether the "want more agents" dialog is up. */
  const [businessAsking, setBusinessAsking] = useState(false);
  /** Which tab is showing. The fleets tab exists only while there is a fleet. */
  const [tab, setTab] = useState<"agents" | "fleets">("agents");
  const shownTab = fleets.length > 0 ? tab : "agents";

  /** The first page of the list, and the fleets above it. Replaces what is on screen. */
  const load = useCallback(async () => {
    const res = await apiFetch(`/api/agents`, {
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
      `/api/agents?cursor=${encodeURIComponent(cursor)}`,
      { cache: "no-store" },
    );
    const payload = (await res.json().catch(() => null)) as AgentPage | null;
    setLoadingMore(false);
    if (!res.ok || !payload?.agents) return;
    setAgents((current) => [...(current ?? []), ...payload.agents]);
    setCursor(payload.has_more ? payload.cursor : "");
  }, [cursor, loadingMore]);

  // Only signed-in visitors have agents to load — and the route that lists them
  // answers nobody else. A signed-out visitor sees the front door instead.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void (async () => {
      await load();
    })();
  }, [load, isLoaded, isSignedIn]);

  /**
   * Make the agent and stay here.
   *
   * It used to open the new agent's chats on the way out. That is one agent's page
   * chosen for you off the back of an unrelated action, and it is wrong whenever the
   * next thing you meant to do was make another one or look at the list you were
   * already on. The row appears where the others are; opening it is a click.
   *
   * A rejected key never gets this far: the Worker checks it before it creates
   * anything, and the dialog stays open with the reason.
   */
  const create = async (
    name: string,
    emails: string,
    meta: MetaSettings,
    fleetName: string,
  ): Promise<string | null> => {
    setBusy(true);
    const res = await apiFetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        allowed_emails: emails,
        // Non-empty when this is a fleet: one agent per address above, each one
        // holding only its own, all of them made from the settings below.
        fleet_name: fleetName,
        // The second step: everything the agent is created holding, the OpenRouter
        // key included. Creation is the only time the default MCP servers can be
        // chosen, so they travel with this call too.
        meta,
      }),
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
    setCreating(false);
    await load();
    return null;
  };

  const remove = async (id: string) => {
    setBusy(true);
    setRemoved((current) => [...current, id]);
    await apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    setBusy(false);
    await load();
  };

  return (
    <div className="bg-canvas text-ink min-h-screen">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <div className="border-b border-canvas-soft pb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[32px] font-[650] leading-[1.2]">Salts.</h1>
            <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
              Personal, Always Accessible AI Agents
            </p>
          </div>
          {isLoaded && isSignedIn && (
            <div className="flex shrink-0 items-center gap-3">
              <UserMenu />
            </div>
          )}
        </div>

        {/* Nothing is drawn until the identity has resolved — otherwise the
            prerendered page would flash the front door at someone already signed in,
            and localStorage cannot be read on the server at all. */}
        {!isLoaded && (
          <p className="text-muted py-4 text-sm leading-[1.43]">Loading…</p>
        )}

        {isLoaded && !isSignedIn && (
          <div className="mt-4 space-y-2 w-full">
            <button
              onClick={() => setAuthing(true)}
              className="w-full min-h-17 bg-canvas-soft hover:bg-canvas-soft/60 group flex cursor-pointer items-center gap-3 rounded-2xl px-5 py-4 transition"
            >
              <Plus size={18} strokeWidth={2} />
              Connect your Account
            </button>
            <p className="text-faint mt-2 ml-2 text-xs leading-[1.33]">
              By signing up and using this platform you agree to our{" "}
              <a href="/tos" className="text-primary hover:underline">
                terms of service
              </a>{" "}
              and{" "}
              <a href="/privacy" className="text-primary hover:underline">
                privacy policy
              </a>
              .
              <br />
            </p>
          </div>
        )}

        {isLoaded && isSignedIn && (
          <>
            {error && (
              <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
                {error}
              </div>
            )}

            {agents === null && (
              <p className="text-muted py-4 text-sm leading-[1.43]">
                Loading your agents…
              </p>
            )}

            {/* The create tile lives inside this block, not under a non-empty
                list: an account with no agents is exactly the one that needs it. */}
            {agents && fleets.length > 0 ? (
              // A segmented control: one white thumb that slides under whichever
              // label is chosen, on a soft track. With no fleets there is nothing to
              // choose between: one segment names the list, drawn unselected.
              <div
                role="tablist"
                className={`bg-canvas-soft relative mt-4 grid rounded-full p-1 w-60 grid-cols-2`}
              >
                <span
                  aria-hidden
                  className="bg-canvas absolute inset-y-1 left-1 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.06)] transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]"
                  style={{
                    width: "calc(50% - 4px)",
                    transform:
                      shownTab === "fleets"
                        ? "translateX(100%)"
                        : "translateX(0)",
                  }}
                />

                {(["agents", "fleets"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={shownTab === t}
                    onClick={() => setTab(t)}
                    className={`relative h-9 rounded-full text-sm font-semibold transition-colors duration-300 ${
                      shownTab === t ? "text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {t === "fleets" ? "Fleets" : "Agents"}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-4" />
            )}

            {agents && shownTab === "fleets" && (
              <div key="fleets" className="panel-from-right mt-2 space-y-2">
                {fleets.map((fleet) => (
                  <Fleet
                    // The count is part of the key on purpose: a fleet that grew or
                    // shrank has pages on screen that no longer describe it, and
                    // starting it over is cheaper than reconciling them.
                    key={`${fleet.fleet_id}:${fleet.agents}`}
                    fleet={fleet}
                    email={email}
                    removed={removed}
                    onMeta={setMetaFor}
                    onDelete={setConfirming}
                    onDeleteFleet={setConfirmingFleet}
                    onFleetSettings={setSettingsFleet}
                    onAddAgents={setAddingTo}
                  />
                ))}
              </div>
            )}

            {agents && shownTab === "agents" && (
              <div
                key="agents"
                // Fleets sit to the right of agents, so each list arrives from its
                // own side — but only once there is a second side to come from.
                className={`${fleets.length > 0 ? "panel-from-left" : ""} mt-2 space-y-2`}
              >
                {agents.map((agent) => (
                  <AgentListRow
                    key={agent.id}
                    agent={agent}
                    email={email}
                    onMeta={setMetaFor}
                    onDelete={setConfirming}
                  />
                ))}

                {cursor && (
                  <button
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    className="text-muted hover:text-ink w-full px-5 py-3 text-left text-sm transition disabled:opacity-40"
                  >
                    {loadingMore ? "Loading…" : "Show more agents"}
                  </button>
                )}

                {quota && (
                  <button
                    disabled={Boolean(quota.owned >= quota.limit)}
                    onClick={() => setCreating(true)}
                    className="disabled:opacity-30 disabled:cursor-not-allowed min-h-17 w-full bg-canvas-soft hover:bg-canvas-soft/60 group flex cursor-pointer items-center gap-3 rounded-2xl px-5 py-4 transition"
                  >
                    <Plus size={18} strokeWidth={2} />
                    Create a new Agent
                  </button>
                )}

                <div
                  onClick={() => setBusinessAsking(true)}
                  // Tinted rather than grey: this is the one row on the list that
                  // opens a commercial decision, and the wash is the same accent
                  // the screen behind it opens with.
                  className="min-h-17 from-accent/12 group flex cursor-pointer items-center gap-3 rounded-2xl bg-linear-to-r to-transparent px-5 py-4 transition hover:to-accent/5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold leading-[1.38]">
                      Need more agents?
                    </span>
                    <span className="text-muted block text-xs leading-[1.33]">
                      You can create and manage hundreds of agents for your
                      friends and customers. <br />
                      Click here to learn more.
                    </span>
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {authing && (
        <AuthModal mode="sign-in" onClose={() => setAuthing(false)} />
      )}

      {metaFor && (
        <MetaSettingsDialog agent={metaFor} onClose={() => setMetaFor(null)} />
      )}

      {businessAsking && (
        <BusinessRequestDialog
          email={email}
          quota={quota}
          onClose={() => setBusinessAsking(false)}
        />
      )}

      {creating && (
        <NewAgent
          busy={busy}
          onCancel={() => setCreating(false)}
          onCreate={create}
        />
      )}

      {settingsFleet && (
        <FleetSettingsDialog
          fleet={settingsFleet}
          onClose={() => setSettingsFleet(null)}
        />
      )}

      {addingTo && (
        <AddFleetAgentsDialog
          fleet={addingTo}
          onClose={() => setAddingTo(null)}
          onAdded={() => {
            setAddingTo(null);
            void load();
          }}
        />
      )}

      {confirmingFleet && (
        <DeleteFleetDialog
          fleet={confirmingFleet}
          onClose={() => setConfirmingFleet(null)}
          onDone={() => {
            setConfirmingFleet(null);
            void load();
          }}
        />
      )}

      {confirming && (
        <DeleteAgentDialog
          agent={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const id = confirming.id;
            setConfirming(null);
            void remove(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * One fleet: a name, a count, and its agents only once it is opened.
 *
 * Fleets sit above the rest of the list rather than among it, and they are closed
 * until asked for. Both of those are because of what a fleet is: one create call
 * that can have made a thousand agents, all with the same name, told apart only by
 * the address on each. Merged into the list in creation order they would bury the
 * handful of agents somebody actually opens day to day; drawn open they would be a
 * thousand rows nobody reads. So the fleet is the row, and its size is the thing
 * worth reading about it.
 *
 * Opening one fetches a page, and each page is asked for as the one before it runs
 * out — the list below this one is paged the same way, and the two never share a
 * cursor, because they are two separate reads of two separate things.
 */
function Fleet({
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
  /**
   * Agents deleted since this fleet was fetched. The pages already fetched are
   * this component's own, and a deletion happens on the page outside it — so
   * rather than re-reading the fleet to lose one row, the row is simply dropped.
   */
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

  // The first page is fetched when the fleet is opened, not when the page loads:
  // an account with twenty fleets would otherwise make twenty reads nobody asked
  // for. Once fetched it is kept, so closing and reopening costs nothing.
  const toggle = () => {
    setOpen((was) => {
      if (!was && agents === null) void page("");
      return !was;
    });
  };

  const shown = agents?.filter((a) => !removed.includes(a.id)) ?? null;

  return (
    <div>
      {/* The row is the fleet, so its delete sits on the row — and it is the whole
          fleet it deletes, which is why it is asked for by name in a dialog rather
          than taken on this click. */}
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
        {/* The fleet's own settings, and the way to grow it. Both belong on the
            fleet rather than on any agent in it: one is the document every agent is
            written from, and the other makes more agents from that document. */}
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

/**
 * One agent on the list, wherever it is drawn: on the page itself, or inside an
 * open fleet.
 *
 * Two different things put a row here, and they decide what the row offers. A user
 * opens the agent; an admin administers it. An admin who is not also on the access
 * list gets no door: the name is text, not a link, because the page behind it
 * answers them the same way it answers a stranger.
 */
function AgentListRow({
  agent,
  email,
  onMeta,
  onDelete,
  showMeta,
}: {
  agent: AgentRow;
  email: string;
  onMeta: (agent: AgentRow) => void;
  onDelete: (agent: AgentRow) => void;
  showMeta?: boolean;
}) {
  const isAdmin = agent.admin_email === email;
  const isUser = agent.allowed_emails
    .split("\n")
    .map((e) => e.trim().toLowerCase())
    .includes(email);
  const members = agent.allowed_emails
    .split("\n")
    .map((e) => e.trim())
    .filter(Boolean);
  /**
   * The line under the name, and it answers a different question depending on who
   * is reading it.
   *
   * To a member, their own address is not information — they know it — so the line
   * says what the agent *is* instead: the fleet it belongs to, or that it is their
   * own. Anyone else on it is still named, because that is the part they do not
   * already know.
   *
   * To an administrator looking down a fleet, the addresses are the whole point:
   * every agent in a fleet has the same name, and the member is the only thing that
   * tells one from the next.
   */
  const others = members.filter((e) => e.toLowerCase() !== email);
  const subtitle = isUser
    ? [
        agent.fleet_name || "Personal agent",
        others.length ? `shared with ${others.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : members.join(", ") || "No members";
  const title = (
    <>
      <span className="block truncate text-base font-semibold leading-[1.38]">
        {agent.name}
      </span>
      <span className="text-faint block truncate text-xs leading-[1.33]">
        {subtitle}
      </span>
    </>
  );

  return (
    <div className="bg-canvas-soft hover:bg-canvas-soft/60 group flex items-center gap-3 rounded-2xl px-5 py-4 transition">
      {isUser ? (
        <Link
          href={`/a/${encodeURIComponent(agent.id)}`}
          className="min-w-0 flex-1"
        >
          {title}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}
      {/* Admin settings are the defaults behind the agent's own settings, so they
          are reachable only from here — never from the agent's pages, where they
          would read as one more setting. */}
      {showMeta && isAdmin && (
        <button
          onClick={() => onMeta(agent)}
          className="text-muted hover:text-ink shrink-0 text-sm transition"
        >
          <Settings size={16} />
        </button>
      )}
      {isAdmin && (
        <button
          onClick={() => onDelete(agent)}
          aria-label={`Delete ${agent.name}`}
          className="text-muted hover:bg-canvas hover:text-ink flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base leading-none opacity-100 transition md:opacity-0 md:group-hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Who the agent is, then what it is: name first, its settings second.
 *
 * An agent made on its own belongs to whoever is making it and to nobody else —
 * there is no access list to fill in, because the answer is always the address
 * already signed in. Ticking the fleet box is what turns this into a list: a fleet
 * name, a column of addresses, and one agent made for each of them.
 *
 * The second step is meta settings, which is the whole of a fleet's configuration —
 * every agent in the fleet is created holding it. A lone agent has nobody to hold
 * settings *for*, so it is asked only for the OpenRouter key that makes it able to
 * answer at all.
 */
function NewAgent({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  /** Resolves to an error to show in the dialog, or null once the agents exist. */
  onCreate: (
    name: string,
    emails: string,
    meta: MetaSettings,
    fleetName: string,
  ) => Promise<string | null>;
}) {
  const { email: ownEmail } = useIdentity();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  /** Whether this call is making a fleet rather than one agent. */
  const [fleet, setFleet] = useState(false);
  const [fleetName, setFleetName] = useState("");
  /**
   * The fleet's addresses as typed: space-, comma- or newline-separated. One agent
   * is made per address, and that address is its only member.
   */
  const [fleetEmails, setFleetEmails] = useState("");
  const [meta, setMeta] = useState<MetaSettings>(EMPTY_META);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  // The catalogues the second step picks from. There is no agent to hang them off
  // yet, so they come from the deployment rather than from one agent's config.
  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/agents/catalog", { cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as {
        models?: ModelOption[];
        mcp_catalog?: McpCatalogEntry[];
        capabilities?: Capability[];
      } | null;
      setModels(payload?.models ?? []);
      setMcpCatalog(payload?.mcp_catalog ?? []);
      setCapabilities(payload?.capabilities ?? []);
    })();
  }, []);

  /**
   * The addresses the fleet box holds, in the order they were typed — and what was
   * typed that is not one.
   *
   * Split apart here because the Worker drops anything that is not an address
   * without a word, so a fleet made from a box with a typo in it would quietly come
   * back one agent short. The count below is the number of agents that will exist,
   * and the rejected words are named so the typo can be found.
   */
  const typed = fleetEmails
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // The same shape check the Worker's `normalizeEmails` applies, so the two agree on
  // what counts. Repeats are kept: the same address twice is two agents for that
  // person, which the Worker makes as asked.
  const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const members = typed.filter(isEmail);
  const rejected = typed.filter((e) => !isEmail(e));

  /**
   * Who the agents being created are for. A fleet is the list that was typed; a lone
   * agent is whoever is making it, which is the only answer available.
   */
  const emails = fleet ? members.join("\n") : ownEmail;

  const ready =
    name.trim() !== "" &&
    (fleet ? fleetName.trim() !== "" && members.length > 0 : !!ownEmail);

  const submit = async () => {
    const cleaned = name.trim();
    if (!cleaned || busy) return;
    setError(
      await onCreate(cleaned, emails, meta, fleet ? fleetName.trim() : ""),
    );
  };

  if (step === 2) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
        onClick={onCancel}
      >
        <div
          className={`bg-canvas text-ink my-auto w-full rounded-[20px] px-6 py-6 shadow-xl ${fleet ? "max-w-lg" : "max-w-sm"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-faint text-xs leading-[1.33]">Step 2 of 2</p>
          <p className="text-lg font-semibold leading-[1.38]">
            {fleet ? "Meta settings" : "OpenRouter key"}
          </p>
          <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
            {fleet
              ? `Set the defaults for every agent in ${fleetName.trim() || "this fleet"}, and choose what its owner can change. A locked setting will not be shown to the owner for configuration.`
              : "Every model call this agent makes is billed to this key. You can add it now or even change it later in settings."}
          </p>

          <div className="mt-4">
            <MetaSettingsForm
              meta={meta}
              onChange={setMeta}
              models={models}
              mcpCatalog={mcpCatalog}
              capabilities={capabilities}
              onlyOpenrouter={!fleet}
            />
          </div>

          {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}

          <div className="border-hairline-soft mt-2 flex justify-end gap-2 border-t pt-5">
            <button
              onClick={() => setStep(1)}
              className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
            >
              Back
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
      onClick={onCancel}
    >
      <div
        className="bg-canvas my-auto w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-faint text-xs leading-[1.33]">Step 1 of 2</p>
        <p className="text-lg font-semibold leading-[1.38]">
          Create a new agent
        </p>
        <label className="mt-5 block">
          <span className="block text-sm font-semibold leading-[1.43]">
            Name
          </span>
          <input
            ref={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) setStep(2);
              if (e.key === "Escape") onCancel();
            }}
            maxLength={60}
            placeholder="Research assistant"
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>

        <label className="mt-4 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={fleet}
            onChange={(e) => setFleet(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-[1.43]">
              Create a fleet of agents
            </span>
            <span className="text-muted block text-xs font-light leading-[1.33]">
              Deploy multiple agents, 1 per user that can share an OpenRouter
              key and can be managed by you.
            </span>
          </span>
        </label>

        {fleet && (
          <>
            <label className="mt-4 block">
              <span className="block text-sm font-semibold leading-[1.43]">
                Fleet name
              </span>
              <input
                value={fleetName}
                onChange={(e) => setFleetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onCancel();
                }}
                maxLength={60}
                placeholder="Sales team"
                className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
              />
            </label>

            <label className="mt-4 block">
              <span className="block text-sm font-semibold leading-[1.43]">
                User Emails
              </span>
              <span className="text-muted block text-xs font-light leading-[1.33]">
                Space separated. You can manage agents individually or as a
                fleet but only a user will have access to their agent.
              </span>
              <textarea
                value={fleetEmails}
                onChange={(e) => setFleetEmails(e.target.value)}
                rows={3}
                placeholder="ana@example.com ben@example.com"
                className="bg-field placeholder:text-faint mt-2 w-full resize-none rounded-2xl px-4 py-3 text-sm outline-none"
              />
              <span className="text-faint text-xs leading-[1.33]">
                {members.length === 0
                  ? "Add at least one address."
                  : `Creating ${members.length} agent${members.length === 1 ? "" : "s"}.`}
              </span>{" "}
              {rejected.length > 0 && (
                <span className="text-faint text-xs leading-[1.33]">
                  (Found {rejected.length} invalid address)
                </span>
              )}
            </label>
          </>
        )}

        {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={() => setStep(2)}
            disabled={busy || !ready}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A fleet's own settings: the document every agent in it is written from.
 *
 * Saving does not only change what the next agent is created holding. It is written
 * over every agent already in the fleet — their meta documents replaced, the
 * defaults applied over their own settings, including settings their users chose for
 * themselves. That is the point of a fleet setting and it is also the damage it can
 * do, so it is asked for twice: once as a save, once as a sentence saying how many
 * agents it lands on.
 *
 * The write is batched, a few agents per call, for the same reason deleting a fleet
 * is. The settings themselves are stored on the first call, so a run that stops
 * halfway has already changed what the fleet means — the agents behind the cursor
 * are the ones still holding the old document, and saving again finishes the job.
 */
function FleetSettingsDialog({
  fleet,
  onClose,
}: {
  fleet: FleetRow;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<MetaSettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Whether the "this overwrites N agents" question is up. */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /** How many agents the run has written to so far. Null before it starts. */
  const [applied, setApplied] = useState<number | null>(null);

  const base = `/api/fleets/${encodeURIComponent(fleet.fleet_id)}`;

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(base, { cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as {
        meta?: MetaSettings;
        models?: ModelOption[];
        mcp_catalog?: McpCatalogEntry[];
        capabilities?: Capability[];
        error?: string;
      } | null;
      if (!res.ok || !payload?.meta) {
        setError(payload?.error ?? "Couldn't load this fleet's settings.");
        return;
      }
      setMeta({ ...EMPTY_META, ...payload.meta });
      setModels(payload.models ?? []);
      setMcpCatalog(payload.mcp_catalog ?? []);
      setCapabilities(payload.capabilities ?? []);
    })();
  }, [base]);

  const save = async () => {
    if (!meta || busy) return;
    setBusy(true);
    setError(null);
    setApplied(0);
    let done = 0;
    // The first call saves the document and takes the first batch; the ones after it
    // carry the cursor and take the rest.
    for (let cursor = "", more = true; more; ) {
      const res = await apiFetch(base, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          cursor ? { cursor, limit: 10 } : { ...meta, limit: 10 },
        ),
      });
      const payload = (await res.json().catch(() => null)) as {
        applied?: number;
        cursor?: string;
        done?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !payload || payload.done === undefined) {
        setBusy(false);
        setError(
          payload?.error ?? "Couldn't apply these settings to the fleet.",
        );
        return;
      }
      done += payload.applied ?? 0;
      setApplied(done);
      cursor = payload.cursor ?? "";
      more = !payload.done && !!cursor;
    }
    setBusy(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-canvas text-ink my-auto w-full max-w-lg rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg font-semibold leading-[1.38]">
          {fleet.fleet_name || "Fleet"} settings
        </p>
        <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
          The settings every agent in this fleet is created with. Saving writes
          them over all {fleet.agents} of them, including settings their users
          changed.
        </p>

        {error && (
          <p className="bg-canvas-soft border-hairline-soft mt-4 rounded-2xl border px-4 py-3 text-[13px] leading-[1.33]">
            {error}
          </p>
        )}

        {!meta && !error && (
          <p className="text-muted py-10 text-sm leading-[1.43]">
            Loading fleet settings…
          </p>
        )}

        {meta && (
          <div className="mt-4">
            <MetaSettingsForm
              meta={meta}
              onChange={setMeta}
              models={models}
              mcpCatalog={mcpCatalog}
              capabilities={capabilities}
            />

            {busy && (
              <p className="text-muted pb-4 text-xs leading-[1.33]">
                Applying to {applied ?? 0} of {fleet.agents}…
              </p>
            )}

            <div className="border-hairline-soft flex justify-end gap-2 border-t pt-5">
              <button
                onClick={onClose}
                disabled={busy}
                className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => setConfirming(true)}
                disabled={busy}
                className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
              >
                {busy ? "Applying…" : "Save and apply"}
              </button>
            </div>
          </div>
        )}
      </div>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-canvas w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl">
            <p className="text-base font-semibold leading-[1.38]">
              Apply to all {fleet.agents} agent
              {fleet.agents === 1 ? "" : "s"}?
            </p>
            <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
              You are about to change the entire fleet settings of{" "}
              {fleet.fleet_name || "this fleet"}. This will overwrite all the
              settings that could have been set by individual agent users.
              <br />
              <br />
              It can create confusion as well as prevent some agents from
              working as expected. Proceed with caution.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirming(false);
                  void save();
                }}
                className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85"
              >
                Apply to all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Grow a fleet: addresses in, one agent each, created holding the fleet's own
 * settings rather than anything typed here. That is the whole point of it being a
 * fleet — an agent added in a year's time is the same agent as the first one.
 */
function AddFleetAgentsDialog({
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
function DeleteFleetDialog({
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

/**
 * Typing the name out is the only guard between a click and something
 * unrecoverable: chats, files, memories, settings, MCP connections, a Telegram
 * bot that stops answering. Matched exactly, case included, so it takes reading
 * the name rather than pattern-matching a few letters.
 */
function DeleteAgentDialog({
  agent,
  onCancel,
  onConfirm,
}: {
  agent: AgentRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const matches = typed === agent.name;

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-5">
      <div className="bg-canvas w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl">
        <p className="text-base font-semibold leading-[1.38]">
          Delete {agent.name}?
        </p>
        <p className="text-muted mt-2 text-sm font-light leading-[1.43]">
          All chats, files, memories, settings and MCP connections will also be
          deleted and the Telegram bot will stop answering.
          <br />
          <br />
          This action cannot be undone. Proceed with caution.
        </p>
        <label className="mt-4 block">
          <span className="text-muted block text-xs leading-[1.33]">
            Type <span className="text-ink font-semibold">{agent.name}</span> to
            confirm
          </span>
          <input
            ref={field}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches) onConfirm();
              if (e.key === "Escape") onCancel();
            }}
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!matches}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The ask for a higher agent limit, as a screen rather than a dialog.
 *
 * A raised limit is one row the owner writes by hand once they have heard the ask,
 * and this screen is the only way to make it. So it gets the whole viewport: the
 * page underneath is a list the account has already filled, and nothing on it is
 * worth glancing back at mid-decision.
 *
 * It grants nothing itself. It files a request for a number, which the owner reviews
 * from the admin CLI — so what reaches the account is always a number they chose.
 * The copy says that plainly; a form that looks like a checkout and behaves like a
 * queue is the one thing this screen must not be.
 */
function BusinessRequestDialog({
  email,
  quota,
  onClose,
}: {
  email: string;
  quota: { limit: number; owned: number } | null;
  onClose: () => void;
}) {
  const [increase, setIncrease] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  // Escape closes, and the list underneath is frozen while this is up. Without the
  // lock the page behind keeps its own scroll position — and a fixed overlay that
  // scrolls its parent is exactly what makes this read as part of the page instead
  // of on top of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const parsed = Number(increase);
  const valid = Number.isInteger(parsed) && parsed > 1 && parsed <= 1000;

  const submit = async () => {
    if (!valid) {
      setError("Cannot be more than 1000");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/business-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ increase: parsed }),
    });
    setBusy(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(
        payload?.error ??
          "That didn't send. Check your connection and try again.",
      );
      return;
    }
    setSent(parsed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Need more agents"
      className="bg-canvas fixed inset-0 z-50 overflow-y-auto overscroll-contain"
    >
      {/* The one place the accent blue is allowed: a commercial decision, washed down
          from the top the way a tinted capability card washes down its section. */}
      <div className="from-accent/12 pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-linear-to-b to-transparent" />

      <div className="relative mx-auto w-full max-w-2xl px-5 pt-8 pb-20 sm:px-8 sm:pt-12">
        <div className="flex justify-end">
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:bg-white hover:text-ink flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none transition"
          >
            ×
          </button>
        </div>

        {sent !== null ? (
          <div className="pt-6 sm:pt-10">
            <span className="bg-white text-muted inline-flex items-center rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-[1.33]">
              Request sent
            </span>
            <h1 className="mt-5 text-[clamp(30px,4.5vw,44px)] leading-[1.08] tracking-[-0.025em]">
              We&apos;ve received your request.
            </h1>
            <p className="text-muted mt-4 max-w-lg text-base font-light leading-[1.4] sm:text-xl">
              You asked for {sent} more {sent === 1 ? "agent" : "agents"} on{" "}
              <span className="text-ink font-medium">{email}</span>. We will get
              back to you shortly.
            </p>

            <div className="ring-hairline-soft mt-10 rounded-[24px] p-7 ring-1">
              <h2 className="text-xl font-semibold tracking-[-0.01em]">
                Once approved
              </h2>
              <p className="text-muted mt-2 text-sm leading-relaxed">
                You will be able to launch agents for multiple users as a fleet.
                Manage each agent on its own, or all of them from one place. Set
                one shared OpenRouter API key, with per-agent usage limits, to
                get every agent to work out of the box.
              </p>
            </div>

            <div className="mt-10">
              <button
                onClick={onClose}
                className="bg-ink text-on-primary h-12 rounded-full px-6 text-sm font-semibold transition hover:opacity-85"
              >
                Back to my agents
              </button>
            </div>
          </div>
        ) : (
          <div className="pt-6 sm:pt-10">
            <span className="bg-white text-muted inline-flex items-center rounded-[10px] px-3 py-1.5 text-xs font-semibold leading-[1.33]">
              Business Account
            </span>
            <h1 className="mt-5 text-[clamp(30px,4.5vw,44px)] leading-[1.08] tracking-[-0.025em]">
              Sponsor agents for everyone you work with.
            </h1>
            <p className="text-muted mt-4 max-w-lg text-base font-light leading-[1.4] sm:text-xl">
              Deploy and co-manage agents for your friends and customers, one
              for each user. Agents you manage can share your OpenRouter API key
              and have individual usage limits.
            </p>

            {/* Three plain statements, not a feature grid. What is being asked for is
                a bigger number; dressing it up as anything else would be a lie. */}
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              {[
                [
                  "Agents stay apart",
                  "Every agent still keeps its own chats, memories, keys and bot. All agents run in isolation.",
                ],
                [
                  "You are in control",
                  "You and the user that has access to the agent can still customize the agent and make it their own.",
                ],
                [
                  "Manage your fleet",
                  "Gain additional settings to get control over how much your agents can be customized.",
                ],
              ].map(([title, body]) => (
                <div key={title} className="rounded-[24px] py-6">
                  <h2 className="text-base font-semibold tracking-[-0.01em]">
                    {title}
                  </h2>
                  <p className="text-muted mt-2 text-sm leading-relaxed">
                    {body}
                  </p>
                </div>
              ))}
            </div>

            <div className="bg-canvas-soft mt-8 rounded-[24px] px-6 py-7 sm:px-8">
              <h2 className="text-xl font-semibold tracking-[-0.01em]">
                Request Access.
              </h2>
              <p className="text-muted mt-2 text-sm leading-relaxed">
                For a limited time period we are allowing free upgrades to
                business accounts. All requests are approved on a case to case
                basis.
              </p>

              <div className="mt-6 space-y-5">
                <label className="block">
                  <span className="text-muted block text-xs leading-[1.33]">
                    Your email
                  </span>
                  <div className="bg-canvas ring-hairline-soft mt-2 flex h-12 w-full items-center rounded-2xl px-4 text-sm ring-1">
                    <span className="truncate">{email}</span>
                  </div>
                </label>

                <label className="block">
                  <span className="text-muted block text-xs leading-[1.33]">
                    Request agents
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={increase}
                    onChange={(e) => setIncrease(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submit();
                    }}
                    className="bg-canvas ring-hairline-soft placeholder:text-faint mt-2 h-12 w-full rounded-2xl px-4 text-sm ring-1 outline-none"
                  />
                  {quota && (
                    <span className="text-faint mt-2 block text-xs leading-[1.33]">
                      <span className="text-ink/50">
                        {quota.limit - quota.owned}
                      </span>{" "}
                      agents remaining (Current limit: {quota.limit})
                    </span>
                  )}
                </label>
              </div>

              {error && <p className="mt-4 text-xs leading-[1.33]">{error}</p>}

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void submit()}
                  disabled={busy}
                  className="bg-ink text-on-primary h-12 rounded-full px-6 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
                >
                  {busy ? "Sending…" : "Send request"}
                </button>
                <button
                  onClick={onClose}
                  className="text-muted hover:text-ink h-12 rounded-full px-4 text-sm font-semibold transition"
                >
                  Not now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
