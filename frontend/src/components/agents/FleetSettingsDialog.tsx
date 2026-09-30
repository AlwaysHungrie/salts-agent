import { MetaSettingsForm } from "@/components/MetaSettings";
import { type Capability, EMPTY_META, type FleetRow, type McpCatalogEntry, type MetaSettings, type ModelOption } from "@/lib/agent";
import { useEffect, useState } from "react";

/**
 * A fleet's own settings. Saving overwrites every agent in the fleet (their meta and
 * settings), so it asks for confirmation. Applied in batches; a partial run is
 * finished by saving again.
 */
export function FleetSettingsDialog({
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
      const res = await fetch(base, { cache: "no-store" });
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
      const res = await fetch(base, {
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
