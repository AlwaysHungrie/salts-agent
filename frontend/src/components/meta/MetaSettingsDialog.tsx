import { type AgentRow, type Capability, type Config, EMPTY_META, type McpCatalogEntry, type MetaSettings, type ModelOption, type SpendState } from "@/lib/agent";
import { apiFetch } from "@/lib/identity";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { MetaSettingsForm } from "./MetaSettingsForm";

export function MetaSettingsDialog({
  agent,
  onClose,
}: {
  agent: AgentRow;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<MetaSettings | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  /** Only the settings changed since opening, so untouched secrets are not sent back. */
  const [changed, setChanged] = useState<Partial<Config>>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  /** What the agent has spent this month, shown beside the ceiling it is set against. */
  const [spend, setSpend] = useState<SpendState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const id = encodeURIComponent(agent.id);
  const base = `/api/agents/${id}/meta`;

  useEffect(() => {
    void (async () => {
      // One request: the settings come with the meta document, since `/config` refuses an admin
      // who is not a member.
      const metaRes = await apiFetch(base, { cache: "no-store" });
      const payload = (await metaRes.json().catch(() => null)) as {
        meta: MetaSettings;
        config: Config;
        models: ModelOption[];
        mcp_catalog?: McpCatalogEntry[];
        capabilities: Capability[];
        spend?: SpendState;
        error?: string;
      } | null;
      if (!metaRes.ok || !payload?.config) {
        setError(payload?.error ?? "Couldn't load meta settings.");
        return;
      }
      setMeta({ ...EMPTY_META, ...payload.meta });
      setConfig(payload.config);
      setModels(payload.models);
      setMcpCatalog(payload.mcp_catalog ?? []);
      setCapabilities(payload.capabilities);
      setSpend(payload.spend ?? null);
    })();
  }, [base]);

  /** Show the change straight away, and remember it for the save. */
  const editConfig = (patch: Partial<Config>) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    setChanged((c) => ({ ...c, ...patch }));
  };

  /**
   * Save meta and settings in one request; the Worker writes meta first, so a newly listed
   * model can be selected in the same save.
   */
  const save = async () => {
    if (!meta) return;
    setBusy(true);
    const res = await apiFetch(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...meta, config: changed }),
    });
    setBusy(false);
    const payload = (await res.json().catch(() => null)) as {
      meta?: MetaSettings;
      config?: Config;
      error?: string;
    } | null;
    if (!res.ok || !payload?.meta) {
      setError(payload?.error ?? "Couldn't save meta settings.");
      return;
    }
    setMeta(payload.meta);
    if (payload.config) setConfig(payload.config);
    setChanged({});
    setError(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
      onClick={onClose}
    >
      <div
        className="bg-canvas text-ink w-full max-w-lg rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold leading-[1.38]">
              Meta settings
            </p>
            <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
              Default settings for {agent.name}, can be changed later. A locked
              setting will not be shown to the owner and can only be changed
              from Admin Settings.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink shrink-0 transition"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {error && (
          <p className="bg-canvas-soft border-hairline-soft mt-4 rounded-2xl border px-4 py-3 text-[13px] leading-[1.33]">
            {error}
          </p>
        )}

        {!meta && !error && (
          <p className="text-muted py-10 text-sm leading-[1.43]">
            Loading meta settings…
          </p>
        )}

        {meta && config && (
          <div className="mt-4">
            <MetaSettingsForm
              meta={meta}
              onChange={setMeta}
              models={models}
              mcpCatalog={mcpCatalog}
              capabilities={capabilities}
              config={config}
              onConfigChange={editConfig}
              agentId={agent.id}
              spend={spend}
            />

            <div className="border-hairline-soft flex items-center justify-between gap-3 border-t pt-5">
              <span />
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void save()}
                  disabled={busy}
                  className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
