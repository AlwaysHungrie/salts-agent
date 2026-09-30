"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthModal } from "@/components/auth/AuthModal";
import { UserMenu } from "@/components/auth/UserMenu";
import { MetaSettingsDialog } from "@/components/MetaSettings";
import { AddFleetAgentsDialog } from "@/components/agents/AddFleetAgentsDialog";
import { AgentsTab } from "@/components/agents/AgentsTab";
import { BusinessRequestDialog } from "@/components/agents/BusinessRequestDialog";
import { DeleteAgentDialog } from "@/components/agents/DeleteAgentDialog";
import { DeleteFleetDialog } from "@/components/agents/DeleteFleetDialog";
import { Fleet } from "@/components/agents/Fleet";
import { FleetSettingsDialog } from "@/components/agents/FleetSettingsDialog";
import { FrontDoor } from "@/components/agents/FrontDoor";
import { ListTabs } from "@/components/agents/ListTabs";
import { NewAgent } from "@/components/agents/NewAgent";
import { useAgentList } from "@/components/agents/useAgentList";
import { claim } from "@/lib/cache";
import { useIdentity } from "@/lib/identity";
import type { AgentRow, FleetRow, MetaSettings } from "@/lib/agent";

/**
 * Every agent this account may open, and the fleets it administers.
 *
 * Agents share nothing (bot, key, MCP servers, memory, sessions), so this page is a
 * list of doors: there is no switcher, and opening one goes to its own page.
 */
export default function Agents() {
  // A Clerk session or an address typed into the back door: either way an address,
  // which is what decides admin from user on every row.
  const { ready: isLoaded, signedIn: isSignedIn, email } = useIdentity();
  const signedIn = isLoaded && isSignedIn;
  if (signedIn) claim(email);
  const list = useAgentList(signedIn);
  const { agents, fleets, quota } = list;

  /** The agent the delete dialog is asking about, if it is open. */
  const [confirming, setConfirming] = useState<AgentRow | null>(null);
  const [confirmingFleet, setConfirmingFleet] = useState<FleetRow | null>(null);
  /** The fleet whose own settings — the ones its agents are written from — are open. */
  const [settingsFleet, setSettingsFleet] = useState<FleetRow | null>(null);
  const [addingTo, setAddingTo] = useState<FleetRow | null>(null);
  const [creating, setCreating] = useState(false);
  /** The agent whose meta settings — the defaults behind its settings — are open. */
  const [metaFor, setMetaFor] = useState<AgentRow | null>(null);
  const [authing, setAuthing] = useState(false);
  const [businessAsking, setBusinessAsking] = useState(false);
  /** The fleets tab exists only while there is a fleet. */
  const [tab, setTab] = useState<"agents" | "fleets">("agents");
  const shownTab = fleets.length > 0 ? tab : "agents";

  const create = (name: string, emails: string, meta: MetaSettings, fleetName: string) =>
    list.create(name, emails, meta, fleetName, () => setCreating(false));

  return (
    <div className="bg-canvas text-ink relative min-h-screen">
      <Link
        href="/guide"
        className="text-muted hover:text-ink absolute top-4 right-5 text-sm font-semibold transition-colors md:right-8"
      >
        User guide
      </Link>
      <div className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <div className="border-b border-canvas-soft pb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[32px] font-[650] leading-[1.2]">Salts.</h1>
            <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
              Personal, Always Accessible AI Agents
            </p>
          </div>
          {signedIn && (
            <div className="flex shrink-0 items-center gap-3">
              <UserMenu />
            </div>
          )}
        </div>

        {/* Nothing is drawn until the identity resolves: the prerendered page would
            otherwise flash the front door at someone already signed in. */}
        {!isLoaded && (
          <p className="text-muted py-4 text-sm leading-[1.43]">Loading…</p>
        )}

        {isLoaded && !isSignedIn && <FrontDoor onConnect={() => setAuthing(true)} />}

        {signedIn && (
          <>
            {list.error && (
              <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
                {list.error}
              </div>
            )}

            {agents === null && (
              <p className="text-muted py-4 text-sm leading-[1.43]">
                Loading your agents…
              </p>
            )}

            {agents && fleets.length > 0 ? (
              <ListTabs shown={shownTab} onChange={setTab} />
            ) : (
              <div className="mt-4" />
            )}

            {agents && shownTab === "fleets" && (
              <div key="fleets" className="panel-from-right mt-2 space-y-2">
                {fleets.map((fleet) => (
                  <Fleet
                    // The count is in the key: a fleet that changed size restarts
                    // rather than reconciling pages that no longer describe it.
                    key={`${fleet.fleet_id}:${fleet.agents}`}
                    fleet={fleet}
                    email={email}
                    removed={list.removed}
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
              <AgentsTab
                key="agents"
                agents={agents}
                email={email}
                hasFleets={fleets.length > 0}
                cursor={list.cursor}
                loadingMore={list.loadingMore}
                quota={quota}
                onLoadMore={() => void list.loadMore()}
                onMeta={setMetaFor}
                onDelete={setConfirming}
                onCreate={() => setCreating(true)}
                onAskBusiness={() => setBusinessAsking(true)}
              />
            )}
          </>
        )}
      </div>

      {authing && <AuthModal mode="sign-in" onClose={() => setAuthing(false)} />}

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
          busy={list.busy}
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
            void list.load();
          }}
        />
      )}

      {confirmingFleet && (
        <DeleteFleetDialog
          fleet={confirmingFleet}
          onClose={() => setConfirmingFleet(null)}
          onDone={() => {
            setConfirmingFleet(null);
            void list.load();
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
            void list.remove(id);
          }}
        />
      )}
    </div>
  );
}
