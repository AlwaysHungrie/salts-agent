"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  CapabilitySection,
  visionBlockedNote,
} from "@/components/CapabilitySection";
import { McpServers } from "@/components/McpServers";
import type { Capability, Config, ModelOption } from "@/lib/agent";
import { apiFetch } from "@/lib/identity";
import { cached, keys, remember, revise } from "@/lib/cache";

/** The MCP section's wash. */
const EMBER = "#FF6A1A";

type ConfigPayload = {
  config: Config;
  capabilities: Capability[];
  models: ModelOption[];
  /** Capability ids and columns the meta dialog keeps to itself. */
  locked?: string[];
  error?: string;
};

/**
 * The capabilities this page draws, in its order. Telegram and WhatsApp are
 * connection setup, not tools the agent calls: both live in Settings. MCP goes
 * first: it is the one capability the user builds out themselves, so it is what they
 * come back to this page for. A locked capability is decided in meta settings and
 * nowhere else, so it is not drawn here at all — a switch this page cannot save is
 * worse than none.
 */
function shownCapabilities(payload: ConfigPayload | undefined): Capability[] {
  if (!payload) return [];
  const locked = new Set(payload.locked ?? []);
  return payload.capabilities
    .filter((c) => c.id !== "telegram" && c.id !== "whatsapp" && !locked.has(c.id))
    .sort((a, b) => Number(b.id === "mcp") - Number(a.id === "mcp"));
}

export default function Capabilities({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  // Drawn from the last read of this agent at once; the read below refreshes it.
  const held = cached<ConfigPayload>(keys.config(agentId));
  const [capabilities, setCapabilities] = useState<Capability[]>(() =>
    shownCapabilities(held),
  );
  const [models, setModels] = useState<ModelOption[]>(held?.models ?? []);
  const [config, setConfig] = useState<Config | null>(held?.config ?? null);
  /** Set by the first change made here, after which a late read must not undo it. */
  const touched = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Credentials save on a timer so a PATCH does not fire on every keystroke.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/config`);
      const payload = (await res.json().catch(() => null)) as ConfigPayload | null;
      if (!res.ok || !payload) {
        setError(payload?.error ?? "Couldn't load your capabilities. Refresh the page to try again.");
        return;
      }
      remember(keys.config(agentId), payload);
      if (!touched.current) setConfig(payload.config);
      setCapabilities(shownCapabilities(payload));
      setModels(payload.models);
    })();
  }, [agentId]);

  const save = async (patch: Partial<Config>) => {
    setSaving(true);
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    const payload = (await res.json().catch(() => null)) as {
      config: Config;
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      setError(
        payload?.error ??
          "Couldn't save. The agent isn't responding. Try the switch again.",
      );
      return;
    }
    setConfig(payload.config);
    revise<ConfigPayload>(keys.config(agentId), (held) => ({
      ...held,
      config: payload.config,
    }));
    setError(null);
  };

  /** Apply locally right away, then persist — immediately, or debounced for text. */
  const set = (patch: Partial<Config>, wait = 0) => {
    touched.current = true;
    setConfig((c) => (c ? { ...c, ...patch } : c));
    if (debounce.current) clearTimeout(debounce.current);
    if (wait === 0) {
      void save(patch);
      return;
    }
    debounce.current = setTimeout(() => void save(patch), wait);
  };

  const model = models.find((m) => m.id === config?.model) ?? null;

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
          <h1 className="text-[32px] font-[650] leading-[1.2]">
            Capabilities.
          </h1>
          <span className="text-faint text-xs leading-[1.33]">
            {saving ? "Saving…" : "Saved"}
          </span>
        </div>
        <p className="text-muted mt-1 text-sm font-light leading-[1.43]">
          Choose what this agent can do besides write. Applies to every one of
          its sessions, and to nothing another agent does.
        </p>

        {error && (
          <div className="bg-canvas-soft border-hairline-soft mt-8 rounded-2xl border px-5 py-4 text-sm leading-[1.43]">
            {error}
          </div>
        )}

        {!config && !error && (
          <p className="text-muted py-16 text-sm leading-[1.43]">
            Loading your capabilities…
          </p>
        )}

        {config && (
          <div className="mt-8">
            {capabilities.map((capability) => (
              <CapabilitySection
                key={capability.id}
                capability={capability}
                agentId={agentId}
                config={config}
                set={set}
                // Images only reach a model that can see them, so the switch is dead
                // until the chosen model is one of those.
                blocked={capability.id === "vision" && !model?.vision}
                blockedNote={visionBlockedNote(
                  model?.label ?? "This model",
                  agentId,
                )}
                // MCP is the one section the user builds out themselves, so it is
                // marked the way the Telegram section is, in ember.
                tint={capability.id === "mcp" ? EMBER : undefined}
              >
                {/* MCP is configured by the servers themselves, not by fields. */}
                {capability.id === "mcp" && <McpServers agentId={agentId} />}
              </CapabilitySection>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
