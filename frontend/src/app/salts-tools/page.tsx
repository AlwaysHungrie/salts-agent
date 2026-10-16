"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthModal } from "@/components/auth/AuthModal";
import { FrontDoor } from "@/components/agents/FrontDoor";
import { Toggle } from "@/components/CapabilitySection";
import { SaltsToolsInfo } from "@/components/SaltsToolsInfo";
import { formatDate } from "@/lib/format";
import { useIdentity } from "@/lib/identity";
import type { AgentRow } from "@/lib/agent";
import { SALTS_COMMAND, type SaltsComputer, type SaltsTodo, type SaltsTool } from "@/lib/salts";

/** How often the page asks again, so a computer coming online shows up by itself. */
const REFRESH_MS = 10_000;

/** A tool's state as one short phrase. */
function toolState(tool: SaltsTool): { text: string; good: boolean } {
  if (tool.state === "ready") return { text: "ready", good: true };
  if (tool.state === "starting") return { text: "starting…", good: true };
  if (tool.state === "off") return { text: "not running", good: true };
  return { text: tool.detail || tool.state, good: false };
}

/**
 * Every computer the user connected with `npx salts-tools`: whether it is online, what
 * it can run, and for each agent it serves, which tools are on there and what is left
 * to do before they work.
 */
export default function SaltsTools() {
  const { ready, signedIn } = useIdentity();
  const [authing, setAuthing] = useState(false);
  const [computers, setComputers] = useState<SaltsComputer[] | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/salts/computers");
    const body = (await res.json().catch(() => ({}))) as { computers?: SaltsComputer[]; error?: string };
    if (!res.ok) return setError(body.error ?? "Couldn't load your computers. Refresh to try again.");
    setError("");
    setComputers(body.computers ?? []);
  }, []);

  useEffect(() => {
    if (!ready || !signedIn) return;
    void (async () => {
      await load();
      const res = await fetch("/api/agents?limit=100");
      if (res.ok) setAgents(((await res.json()) as { agents: AgentRow[] }).agents);
    })();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [ready, signedIn, load]);

  /** Send one change, then draw the computer the Worker answers with. */
  const change = async (computerId: string, path: string, init: RequestInit) => {
    const res = await fetch(`/api/salts/computers/${encodeURIComponent(computerId)}${path}`, {
      ...init,
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as SaltsComputer & { error?: string };
    if (!res.ok) return setError(body.error ?? "That didn't save. Try again.");
    setError("");
    if (body.id) setComputers((list) => list?.map((c) => (c.id === body.id ? body : c)) ?? null);
    else void load();
  };

  const setTools = (c: SaltsComputer, agentId: string, tools: string[]) =>
    change(c.id, `/agents/${encodeURIComponent(agentId)}`, {
      method: "PUT",
      body: JSON.stringify({ tools }),
    });

  const disconnect = async (c: SaltsComputer) => {
    if (!confirm(`Disconnect ${c.name}? Its tools are removed from every agent it serves.`)) return;
    await change(c.id, "", { method: "DELETE" });
    void load();
  };

  const turnOn = async (agentId: string, flag: string) => {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [flag]: 1 }),
    });
    if (!res.ok) setError("Couldn't switch that on. Try it on the agent's Capabilities page.");
    void load();
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
        <h1 className="mt-4 text-[32px] font-[650] leading-[1.2]">salts-tools.</h1>
        <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
          Free web search, the matchmaker and the spreadsheet analyst, running on your
          own computer. To connect a computer, run{" "}
          <code className="text-ink">{SALTS_COMMAND}</code> in its terminal.
          <SaltsToolsInfo />
        </p>

        {!ready && <p className="text-muted py-4 text-sm">Loading…</p>}
        {ready && !signedIn && <FrontDoor onConnect={() => setAuthing(true)} />}

        {error && (
          <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
            {error}
          </div>
        )}

        {signedIn && computers === null && !error && (
          <p className="text-muted py-4 text-sm">Loading your computers…</p>
        )}

        {computers && computers.length === 0 && (
          <div className="bg-canvas-soft mt-8 rounded-2xl px-5 py-4 text-sm leading-[1.43]">
            No computers yet. Run <code className="font-semibold">{SALTS_COMMAND}</code> in a
            terminal on the computer you want to use. It opens this site to connect.
          </div>
        )}

        {computers?.map((c) => (
          <Computer
            key={c.id}
            computer={c}
            agents={agents}
            onTools={(agentId, tools) => void setTools(c, agentId, tools)}
            onUnlink={(agentId) =>
              void change(c.id, `/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })
            }
            onDisconnect={() => void disconnect(c)}
            onTurnOn={(agentId, flag) => void turnOn(agentId, flag)}
          />
        ))}
      </div>
      {authing && <AuthModal mode="sign-in" onClose={() => setAuthing(false)} />}
    </div>
  );
}

function Computer({
  computer: c,
  agents,
  onTools,
  onUnlink,
  onDisconnect,
  onTurnOn,
}: {
  computer: SaltsComputer;
  agents: AgentRow[];
  onTools: (agentId: string, tools: string[]) => void;
  onUnlink: (agentId: string) => void;
  onDisconnect: () => void;
  onTurnOn: (agentId: string, flag: string) => void;
}) {
  const tools = Object.entries(c.tools);
  const linked = new Set(c.agents.map((a) => a.id));
  const unlinked = agents.filter((a) => !linked.has(a.id));

  return (
    <section className="border-hairline-soft mt-8 rounded-[20px] border px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-semibold leading-[1.38]">{c.name}</p>
          <p className="text-muted mt-0.5 text-xs leading-[1.33]">
            <span className={c.online ? "text-ink" : ""}>
              {c.online ? "● Online" : "○ Offline"}
            </span>
            {!c.online && c.last_seen > 0 && <> · last seen {formatDate(c.last_seen)}</>}
            {!c.last_seen && <> · not reported yet</>}
            {c.version && <> · salts-tools {c.version}</>}
          </p>
        </div>
        <button
          onClick={onDisconnect}
          className="text-muted hover:text-ink shrink-0 text-xs font-semibold transition-colors"
        >
          Disconnect
        </button>
      </div>

      {!c.online && (
        <p className="text-muted mt-3 text-sm font-light leading-[1.43]">
          Its tools work only while this computer is on and running salts-tools. Run{" "}
          <code className="text-ink">{SALTS_COMMAND}</code> on it to start it again.
        </p>
      )}

      {tools.length > 0 && (
        <div className="mt-4">
          <p className="text-faint text-xs uppercase tracking-wide">On this computer</p>
          <ul className="mt-2 space-y-1">
            {tools.map(([name, tool]) => {
              const state = toolState(tool);
              return (
                <li key={name} className="flex justify-between gap-4 text-sm">
                  <span>{tool.label}</span>
                  <span className={state.good ? "text-muted" : "text-ink font-semibold"}>
                    {state.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-5 space-y-3">
        {c.agents.map((agent) => (
          <div key={agent.id} className="bg-canvas-soft rounded-2xl px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <Link
                href={`/a/${encodeURIComponent(agent.id)}/capabilities`}
                className="text-sm font-semibold hover:underline"
              >
                {agent.name}
              </Link>
              <button
                onClick={() => onUnlink(agent.id)}
                className="text-muted hover:text-ink text-xs font-semibold transition-colors"
              >
                Remove
              </button>
            </div>
            {tools.length === 0 && (
              <p className="text-muted mt-2 text-sm font-light">
                The tools appear here once the computer reports in.
              </p>
            )}
            <ul className="mt-3 space-y-3">
              {tools.map(([name, tool]) => {
                const on = agent.tools.includes(name);
                return (
                  <li key={name} className="flex items-center justify-between gap-4 text-sm">
                    <span>{tool.label}</span>
                    <Toggle
                      on={on}
                      onChange={(next) =>
                        onTools(
                          agent.id,
                          next ? [...agent.tools, name] : agent.tools.filter((t) => t !== name),
                        )
                      }
                    />
                  </li>
                );
              })}
            </ul>
            {agent.todos.length > 0 && (
              <ul className="mt-4 space-y-2">
                {agent.todos.map((todo, i) => (
                  <Todo
                    key={i}
                    todo={todo}
                    agentId={agent.id}
                    label={c.tools[todo.tool]?.label ?? todo.tool}
                    onTurnOn={(flag) => onTurnOn(agent.id, flag)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {unlinked.length > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && onTools(e.target.value, [])}
          className="bg-field mt-4 w-full rounded-2xl px-4 py-3 text-sm outline-none"
        >
          <option value="">Use this computer for another agent…</option>
          {unlinked.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}

/** One thing left to do on an agent, with the way to do it. */
function Todo({
  todo,
  agentId,
  label,
  onTurnOn,
}: {
  todo: SaltsTodo;
  agentId: string;
  label: string;
  onTurnOn: (flag: string) => void;
}) {
  const capabilities = `/a/${encodeURIComponent(agentId)}/capabilities`;
  const go = (text: string) => (
    <Link href={capabilities} className="text-ink shrink-0 font-semibold underline">
      {text}
    </Link>
  );
  let text: string;
  let action: React.ReactNode = null;
  switch (todo.kind) {
    case "capability":
      text = `${label} needs ${todo.label} switched on for this agent.`;
      action = (
        <button
          onClick={() => onTurnOn(todo.flag)}
          className="bg-ink text-on-primary h-8 shrink-0 rounded-full px-4 text-xs font-semibold"
        >
          Turn on
        </button>
      );
      break;
    case "headers":
      text = `${label} needs ${todo.headers.join(" and ")} filled in on its MCP server.`;
      action = go("Fill in");
      break;
    case "disabled":
      text = `The ${label} MCP server is switched off on this agent.`;
      action = go("Open");
      break;
    case "brave":
      text = "This agent has a Brave key, so it searches with Brave instead. Remove the key to use this computer.";
      action = go("Open");
      break;
    case "name_taken":
      text = `This agent already has a different MCP server called ${todo.tool}. Remove it and this computer's is added.`;
      action = go("Open");
      break;
    case "managed":
      text = `This agent's MCP servers are set by its admin, so ${label} can't be added.`;
      break;
  }
  return (
    <li className="bg-canvas flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs leading-[1.4]">
      <span>{text}</span>
      {action}
    </li>
  );
}
