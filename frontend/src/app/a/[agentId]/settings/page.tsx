"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import {
  CapabilitySection,
  ChipList,
  Field,
} from "@/components/CapabilitySection";
import type {
  AgentRow,
  Capability,
  CapabilityField,
  Config,
  ModelOption,
  ReasoningEffort,
  SpendState,
} from "@/lib/agent";
import { formatUsdShort } from "@/lib/format";
import { apiFetch, useIdentity } from "@/lib/identity";
import { cached, keys, remember, revise } from "@/lib/cache";

/**
 * The OpenRouter key is not a capability's credential — it is what every model call
 * is billed to, so the agent has one of its own and one agent's spend never lands on
 * another's. Described here in the shape `Field` already knows how to draw, so a
 * pasted key behaves exactly like every other secret on the capabilities page.
 */
const OPENROUTER_KEY: CapabilityField = {
  key: "openrouter_api_key",
  secret: true,
  required: true,
  placeholder: "sk-or-v1-…",
};

const REASONING: { id: ReasoningEffort; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Answers right away. Cheapest." },
  { id: "low", label: "Low", hint: "Thinks briefly before answering." },
  { id: "medium", label: "Medium", hint: "Good for multi-step questions." },
  { id: "high", label: "High", hint: "Thinks hardest. Slowest and priciest." },
];

/**
 * How much of the month's ceiling is left, as a whole number from 0 to 100.
 *
 * Whole numbers because a percentage with decimals in it invites reading it as an
 * exact figure; the dollars underneath are the exact figure. Rounded down, so a
 * nearly-spent agent never reads as having 1% left when it has 0.4%.
 */
function remainingPercent(spend: SpendState): number {
  if (spend.limit <= 0) return 100;
  const left = Math.max(0, spend.limit - spend.usd);
  return Math.max(0, Math.min(100, Math.floor((left / spend.limit) * 100)));
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-hairline-soft border-t py-7">
      <h2 className="text-base font-semibold leading-[1.38]">{title}</h2>
      <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
        {hint}
      </p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="bg-field inline-flex rounded-full p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
            value === o.id
              ? "bg-canvas text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-ink h-1 flex-1 cursor-pointer"
      />
      <span className="tnum text-muted w-24 shrink-0 text-right text-sm">
        {format(value)}
      </span>
    </div>
  );
}

/** What `/api/agents/:id/config` answers with. */
type ConfigPayload = {
  agent: AgentRow;
  config: Config;
  models: ModelOption[];
  capabilities: Capability[];
  locked?: string[];
  spend?: SpendState;
  member_limit?: number;
  error?: string;
};

export default function Settings({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  /** The signed-in address. It is on the list whatever the box says, so it is shown apart from it. */
  const { email: ownEmail } = useIdentity();
  // Drawn from the last read of this agent at once; the read below refreshes it.
  const held = cached<ConfigPayload>(keys.config(agentId));
  const [agent, setAgent] = useState<AgentRow | null>(held?.agent ?? null);
  const [name, setName] = useState(held?.agent?.name ?? "");
  /** The stored access list, one address per line, the signed-in address included. */
  const [emails, setEmails] = useState(held?.agent?.allowed_emails ?? "");
  const [models, setModels] = useState<ModelOption[]>(held?.models ?? []);
  const [config, setConfig] = useState<Config | null>(held?.config ?? null);
  /**
   * Settings this agent may not change for itself: config columns and capability
   * ids, locked in the meta dialog on the home page. A locked setting is not drawn
   * here at all — the Worker drops it from a PATCH, so an editor for it would be an
   * edit that silently does nothing.
   */
  const [locked, setLocked] = useState<Set<string>>(
    () => new Set(held?.locked ?? []),
  );
  /**
   * What the agent has spent this month, and the ceiling its administrator set.
   * Shown, never edited: this page is the agent's user's, and the ceiling is the
   * one thing on it that belongs to whoever provides the agent.
   */
  const [spend, setSpend] = useState<SpendState | null>(held?.spend ?? null);
  /**
   * How many addresses this agent's access list may hold, or 0 for no ceiling.
   * Set by whoever administers the agent; shown here so a list that is about to be
   * refused says so before it is saved rather than after.
   */
  const [memberLimit, setMemberLimit] = useState(held?.member_limit ?? 0);
  /** Connecting the bot is setup rather than a tool, so it is shown here, first. */
  const [telegram, setTelegram] = useState<Capability | null>(
    held?.capabilities.find((c) => c.id === "telegram") ?? null,
  );
  /** Same reasoning as Telegram: connecting a number is setup, not a tool. */
  const [whatsapp, setWhatsapp] = useState<Capability | null>(
    held?.capabilities.find((c) => c.id === "whatsapp") ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** What OpenRouter said about the key that was last pasted. Cleared on the next save. */
  const [keyCheck, setKeyCheck] = useState<{
    ok: boolean;
    error?: string;
    label?: string;
  } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentId)}/config`,
      );
      const payload = (await res.json().catch(() => null)) as ConfigPayload | null;
      if (!res.ok || !payload) {
        setError(
          payload?.error ??
            "Couldn't load your settings. Refresh the page to try again.",
        );
        return;
      }
      remember(keys.config(agentId), payload);
      setModels(payload.models);
      // What was drawn from the cache is replaced only where it has not been edited
      // since: a late read must not undo a change already made on this page.
      setConfig((current) => (current === (held?.config ?? null) ? payload.config : current));
      setLocked(new Set(payload.locked ?? []));
      setSpend(payload.spend ?? null);
      setMemberLimit(payload.member_limit ?? 0);
      setAgent(payload.agent ?? null);
      setName((current) =>
        current === (held?.agent?.name ?? "") ? (payload.agent?.name ?? "") : current,
      );
      setEmails((current) =>
        current === (held?.agent?.allowed_emails ?? "")
          ? (payload.agent?.allowed_emails ?? "")
          : current,
      );
      setTelegram(
        payload.capabilities.find((c) => c.id === "telegram") ?? null,
      );
      setWhatsapp(
        payload.capabilities.find((c) => c.id === "whatsapp") ?? null,
      );
    })();
    // Only the first render's cache matters here; later ones are this page's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // What is saved here is what the other pages of this agent open with next.
  useEffect(() => {
    if (!agent || !config) return;
    revise<ConfigPayload>(keys.config(agentId), (payload) => ({
      ...payload,
      agent,
      config,
    }));
  }, [agentId, agent, config]);

  /** The agent's name. It is the agent itself, not one of its settings. */
  const rename = async (next: string) => {
    const cleaned = next.trim();
    if (!cleaned || cleaned === agent?.name) {
      setName(agent?.name ?? "");
      return;
    }
    setSaving(true);
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: cleaned }),
    });
    setSaving(false);
    if (!res.ok) {
      setError("Couldn't rename this agent.");
      setName(agent?.name ?? "");
      return;
    }
    setAgent((a) => (a ? { ...a, name: cleaned } : a));
    setError(null);
  };

  /**
   * Who may open this agent. Your own address is added back by the Worker whatever
   * is sent: an agent you edited yourself out of would be one you could not edit
   * back, and an empty list would strand it for everyone.
   */
  const saveEmails = async (next: string) => {
    setSaving(true);
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_emails: next }),
    });
    setSaving(false);
    const payload = (await res.json().catch(() => null)) as
      | (AgentRow & { error?: string })
      | null;
    if (!res.ok || !payload?.id) {
      setError(payload?.error ?? "Couldn't save who can open this agent.");
      setEmails(agent?.allowed_emails ?? "");
      return;
    }
    setAgent(payload);
    // Take the stored list back: it is lowercased, de-duplicated and shorn of
    // anything that was not an address, so the chips show what is actually saved.
    setEmails(payload.allowed_emails);
    setError(null);
  };

  const save = async (patch: Partial<Config>) => {
    setSaving(true);
    const res = await apiFetch(
      `/api/agents/${encodeURIComponent(agentId)}/config`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    setSaving(false);
    const payload = (await res.json().catch(() => null)) as {
      config: Config;
      openrouter?: { ok: boolean; error?: string; label?: string };
      /** The WhatsApp account subscription the Worker makes on every save. */
      whatsapp?: { ok: boolean; error?: string };
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      setError(
        payload?.error ??
          "Couldn't save. The agent isn't responding. Change the setting again to retry.",
      );
      return;
    }
    // Take the server's row back: it clamps values the UI could send out of range.
    setConfig(payload.config);
    // Only a save that carried a new key gets a verdict; the rest leave it alone.
    if (payload.openrouter) setKeyCheck(payload.openrouter);
    // The settings saved either way, but without the subscription no message is ever
    // delivered — so a refusal is said here rather than discovered as silence.
    if (payload.whatsapp && !payload.whatsapp.ok) {
      setError(
        `Saved, but WhatsApp would not subscribe this account: ${
          payload.whatsapp.error ?? "Meta refused the request."
        } Check the business account ID and the access token.`,
      );
      return;
    }
    setError(null);
  };

  /**
   * The list as the editor shows it: everyone but you. Your own address is a fixed
   * chip instead, so it cannot be deleted by accident — the Worker puts it back
   * whatever is sent, and a list you had edited yourself out of would be one you
   * could not edit back.
   */
  const others = emails
    .split("\n")
    .map((e) => e.trim())
    .filter((e) => e !== "" && e.toLowerCase() !== ownEmail)
    .join("\n");

  /** Everyone on the list, your own address included — what the ceiling counts. */
  const memberCount = emails
    .split("\n")
    .map((e) => e.trim())
    .filter(Boolean).length;

  const set = (patch: Partial<Config>, wait = 0) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    if (debounce.current) clearTimeout(debounce.current);
    if (wait === 0) {
      void save(patch);
      return;
    }
    debounce.current = setTimeout(() => void save(patch), wait);
  };

  return (
    <div className="bg-canvas text-ink min-h-screen">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
        <Link
          href={`/a/${encodeURIComponent(agentId)}`}
          className="text-muted hover:text-ink mb-10 inline-flex items-center gap-2 text-sm transition"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
          Sessions
        </Link>

        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[32px] font-[650] leading-[1.2]">Settings.</h1>
          <span className="text-faint text-xs leading-[1.33]">
            {saving ? "Saving…" : "Saved"}
          </span>
        </div>
        <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
          Configure how this agent replies to messages. To manage its
          capabilities and give it additional tools, go to{" "}
          <Link
            href={`/a/${encodeURIComponent(agentId)}/capabilities`}
            className="text-ink underline"
          >
            Capabilities
          </Link>
          .
        </p>

        {error && (
          <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
            {error}
          </div>
        )}

        {!config && !error && (
          <p className="text-muted py-16 text-sm leading-[1.43]">
            Loading settings…
          </p>
        )}

        {config && (
          <div className="mt-8">
            {/* Only a fleet agent, and only one that was given a ceiling. An agent
                somebody made for themselves is spending their own money against no
                limit, and a row that always reads "100% remaining" is furniture. */}
            {spend && agent?.fleet_id && (
              <Row
                title={
                  spend.limit > 0 ? "Monthly spend limit" : "This month's usage"
                }
                hint="Set by agent admin. Resets every calendar month."
              >
                <div className="bg-canvas-soft rounded-2xl px-5 py-4">
                  <div className="tnum text-xl font-[650] leading-[1.3]">
                    {spend.limit > 0 ? (
                      <>
                        {remainingPercent(spend)}% remaining{" "}
                        <span className="text-muted text-xs font-light">
                          {formatUsdShort(spend.usd)} of{" "}
                          {formatUsdShort(spend.limit)} spent
                        </span>
                      </>
                    ) : (
                      <>
                        {formatUsdShort(spend.usd)}{" "}
                        <span className="text-muted text-sm font-light">
                          spent this month (limit not set)
                        </span>
                      </>
                    )}
                  </div>
                  {spend.limit > 0 && (
                    <>
                      {/* The bar is the same number again, for the glance that does
                          not stop to read it. */}
                      <div className="bg-canvas mt-3 h-1.5 overflow-hidden rounded-full">
                        <div
                          className="bg-ink h-full rounded-full"
                          style={{ width: `${100 - remainingPercent(spend)}%` }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </Row>
            )}

            {telegram && !locked.has("telegram") && (
              <CapabilitySection
                capability={telegram}
                agentId={agentId}
                config={config}
                set={set}
                tint="#229ED9"
              />
            )}

            {whatsapp && !locked.has("whatsapp") && (
              <CapabilitySection
                capability={whatsapp}
                agentId={agentId}
                config={config}
                set={set}
                tint="#25D366"
              />
            )}

            {!locked.has("model") && (
              <Row title="Model" hint="Choose which model answers you.">
                <div className="space-y-2">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => set({ model: m.id })}
                      className={`flex w-full items-center gap-3 rounded-2xl px-5 py-4 text-left transition ${
                        config.model === m.id
                          ? "bg-canvas-soft"
                          : "hover:bg-canvas-soft/60"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-semibold leading-[1.38]">
                          {m.label}
                        </span>
                        <span className="text-faint block truncate text-xs leading-[1.33]">
                          {m.id}
                          {!m.vision ? " · (no image)" : ""}
                        </span>
                      </span>
                      {config.model === m.id && (
                        <Check size={18} strokeWidth={2} className="shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </Row>
            )}

            {!locked.has("system_prompt") && (
              <Row
                title="Custom instructions"
                hint="Tell the agent how to reply, every time."
              >
                <textarea
                  value={config.system_prompt}
                  onChange={(e) => set({ system_prompt: e.target.value }, 600)}
                  rows={4}
                  maxLength={4000}
                  placeholder="Answer in short paragraphs. Show code before explaining it."
                  className="bg-field placeholder:text-faint w-full resize-y rounded-2xl px-5 py-4 text-sm leading-[1.43] outline-none"
                />
                <p className="text-faint mt-2 text-xs leading-[1.33]">
                  {config.system_prompt.length} / 4000 &middot; The agent is
                  always told its name first, whatever this says.
                </p>
              </Row>
            )}

            {!locked.has("reasoning_effort") && (
              <Row
                title="Extended reasoning"
                hint="Choose how long the agent thinks before it answers."
              >
                <Segmented
                  options={REASONING.map((r) => ({ id: r.id, label: r.label }))}
                  value={config.reasoning_effort}
                  onChange={(v) => set({ reasoning_effort: v })}
                />
                <p className="text-faint mt-3 text-xs leading-[1.33]">
                  {
                    REASONING.find((r) => r.id === config.reasoning_effort)
                      ?.hint
                  }
                </p>
              </Row>
            )}

            {!locked.has("temperature") && (
              <Row
                title="Creativity"
                hint="Low keeps answers literal. High makes them varied."
              >
                <Slider
                  value={config.temperature}
                  min={0}
                  max={2}
                  step={0.1}
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => set({ temperature: v })}
                />
              </Row>
            )}

            {!locked.has("max_tokens") && (
              <Row
                title="Reply length cap"
                hint="Set how long a single reply can run."
              >
                <Slider
                  value={config.max_tokens}
                  min={0}
                  max={8000}
                  step={250}
                  format={(v) => (v === 0 ? "No cap" : `${v} tokens`)}
                  onChange={(v) => set({ max_tokens: v })}
                />
              </Row>
            )}

            {!locked.has("context_messages") && (
              <Row
                title="Context window"
                hint="Choose how much of the chat the agent sees each turn."
              >
                <Slider
                  value={config.context_messages}
                  min={0}
                  max={100}
                  step={2}
                  format={(v) => (v === 0 ? "Full history" : `Last ${v}`)}
                  onChange={(v) => set({ context_messages: v })}
                />
              </Row>
            )}

            {!locked.has("openrouter_api_key") && (
              <Row
                title="OpenRouter"
                hint="Your agent cannot function without this."
              >
                <Field
                  field={OPENROUTER_KEY}
                  value={config.openrouter_api_key}
                  onChange={(v) => {
                    setKeyCheck(null);
                    set({ openrouter_api_key: v });
                  }}
                />
                {keyCheck && (
                  <p
                    className={`mt-2 text-xs leading-[1.33] ${
                      keyCheck.ok ? "text-muted" : "text-ink"
                    }`}
                  >
                    {keyCheck.ok
                      ? `This key${keyCheck.label ? ` (${keyCheck.label})` : ""} is valid.`
                      : "Invalid key"}
                  </p>
                )}
                {!config.openrouter_api_key && !keyCheck && (
                  <p className="text-faint mt-2 text-xs leading-[1.33]">
                    A valid Openrouter API key is required.
                  </p>
                )}
              </Row>
            )}

            <Row title="Name" hint="What this agent is called, everywhere">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void rename(name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setName(agent?.name ?? "");
                    e.currentTarget.blur();
                  }
                }}
                maxLength={60}
                placeholder="New agent"
                className="bg-field placeholder:text-faint w-full rounded-2xl px-5 py-4 text-sm leading-[1.43] outline-none"
              />
            </Row>

            <Row
              title="Manage access"
              hint="Users who have complete access to manage, chat and read all messages of this agent."
            >
              <ChipList
                value={others}
                onChange={(v) => void saveEmails(v)}
                placeholder="teammate@example.com"
                locked={ownEmail ? [ownEmail] : []}
              />
              {/* Only when there is one. A ceiling of "none" is not a fact worth a
                  line of its own, and every agent outside a fleet has none. */}
              {memberLimit > 0 && (
                <p className="text-faint tnum mt-2 text-xs leading-[1.33]">
                  {memberLimit - memberCount} member
                  {memberLimit === 1 ? "" : "s"} remaining (set by agent admin)
                </p>
              )}
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}
