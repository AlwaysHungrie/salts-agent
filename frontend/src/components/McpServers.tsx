"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import {
  SECRET_MASK,
  type McpAuth,
  type McpCatalogEntry,
  type McpServer,
} from "@/lib/agent";
import { Toggle } from "@/components/CapabilitySection";
import { McpPresetStrip, type McpPreset } from "@/components/McpPresets";
import { apiFetch } from "@/lib/identity";

const AUTH_MODES: { id: McpAuth; label: string; hint?: string }[] = [
  {
    id: "none",
    label: "None",
  },
  {
    id: "headers",
    label: "API key",
    hint: "Configure authentication headers that will be sent with every request.",
  },
  {
    id: "oauth",
    label: "OAuth",
    hint: "You will be redirected to the external provider and asked to authenticate via your account.",
  },
];

/** A header pair while it is being edited. Stored as a JSON object server-side. */
type HeaderPair = { key: string; value: string };

const pairsFrom = (names: string[]): HeaderPair[] =>
  names.length > 0
    ? names.map((key) => ({ key, value: SECRET_MASK }))
    : [{ key: "", value: "" }];

const objectFrom = (pairs: HeaderPair[]): Record<string, string> =>
  Object.fromEntries(
    pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]),
  );

const input =
  "bg-canvas border-hairline placeholder:text-faint text-ink w-full min-w-0 rounded-2xl border px-4 py-3 text-sm outline-none";
const button =
  "bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-2xl border px-4 py-2.5 text-[13px] font-semibold transition disabled:opacity-40";
const actionButton =
  "bg-canvas border-hairline text-ink hover:bg-canvas-soft shrink-0 rounded-xl border px-2 py-1 text-[13px] font-semibold transition disabled:opacity-40";

function AuthPicker({
  value,
  onChange,
}: {
  value: McpAuth;
  onChange: (v: McpAuth) => void;
}) {
  return (
    <div>
      <div className="bg-canvas border-hairline inline-flex rounded-full border p-1">
        {AUTH_MODES.map((mode) => (
          <button
            key={mode.id}
            onClick={() => onChange(mode.id)}
            className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition ${
              value === mode.id
                ? "bg-ink text-canvas"
                : "text-muted hover:text-ink"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <p className="text-muted mt-2 text-xs leading-[1.33]">
        {AUTH_MODES.find((m) => m.id === value)?.hint}
      </p>
    </div>
  );
}

/**
 * The header editor: a name and a value per row. A value already saved reads back as
 * the mask and is left alone unless it is typed over, so editing one header never
 * wipes the key in another.
 */
function HeaderEditor({
  pairs,
  onChange,
}: {
  pairs: HeaderPair[];
  onChange: (pairs: HeaderPair[]) => void;
}) {
  const set = (i: number, patch: Partial<HeaderPair>) =>
    onChange(pairs.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <span className="block text-[13px] font-semibold leading-[1.43]">
        Headers
      </span>
      {pairs.map((pair, i) => (
        <div key={i} className="flex gap-2">
          <input
            value={pair.key}
            placeholder="Authorization"
            onChange={(e) => set(i, { key: e.target.value })}
            aria-label="Header name"
            className={`${input} flex-[2]`}
          />
          <input
            type={pair.value === SECRET_MASK ? "text" : "password"}
            value={pair.value}
            placeholder="Bearer sk-…"
            onFocus={() => pair.value === SECRET_MASK && set(i, { value: "" })}
            onChange={(e) => set(i, { value: e.target.value })}
            aria-label="Header value"
            className={`${input} flex-[3]`}
          />
          <button
            onClick={() => onChange(pairs.filter((_, n) => n !== i))}
            aria-label="Remove header"
            className="text-muted hover:text-ink shrink-0 px-2"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
        className="text-muted hover:text-ink text-[13px] font-semibold"
      >
        + Add header
      </button>
    </div>
  );
}

/** One saved server: what it offers, and everything that can be changed about it. */
function ServerCard({
  server,
  onPatch,
  onToolsChange,
  onRecommend,
  recommending,
  onAction,
  onRemove,
  busy,
  manage,
}: {
  server: McpServer;
  onPatch: (patch: Record<string, unknown>) => void;
  /** Switching a tool on or off, applied locally before the Worker answers. */
  onToolsChange: (disabled: string[]) => void;
  /** Hand the choice to the model. Answers by replacing the row, chips and all. */
  onRecommend: () => void;
  /** Whether that choice is in flight for this card. */
  recommending: boolean;
  onAction: (action: "connect" | "disconnect" | "refresh") => void;
  onRemove: () => void;
  busy: boolean;
  /**
   * Whether what the server *is* may be changed here — its name, where it points,
   * how it authenticates, and whether it stays at all. False leaves what it is *for*:
   * the switch, its tools, and its OAuth. The Worker refuses the difference, so an
   * editor shown here would be one that cannot save.
   */
  manage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(server.name);
  const [url, setUrl] = useState(server.url);
  const [pairs, setPairs] = useState<HeaderPair[]>(
    pairsFrom(server.header_names),
  );

  const off = new Set(server.disabled_tools);
  const live = server.tools.filter((t) => !off.has(t.name)).length;
  const status = !server.enabled
    ? "Off"
    : server.last_error
      ? "Last failed tool call"
      : !server.connected
        ? "Not connected"
        : live === server.tools.length
          ? `${live} tool${live === 1 ? "" : "s"}`
          : `${live} of ${server.tools.length} tools`;

  return (
    <div className="bg-canvas border-hairline rounded-[20px] border p-4">
      <div className="flex items-start justify-between gap-4">
        <button
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[15px] font-semibold leading-[1.4]">
            {server.name}
          </span>
          <span className="text-muted block truncate text-xs font-light leading-[1.33]">
            {server.url}
          </span>
          <span
            className={`mt-3 inline-block text-xs leading-[1.33] ${
              server.last_error ? "text-ink font-semibold" : "text-faint"
            }`}
          >
            {status}
          </span>
        </button>
        <Toggle
          on={!!server.enabled}
          onChange={(v) => onPatch({ enabled: v })}
        />
      </div>

      {server.last_error && (
        <p className="bg-canvas-soft mt-1 rounded-[14px] px-4 py-3 text-xs leading-[1.33]">
          {server.last_error}
        </p>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        {/*
          First of the actions, and ahead of Disconnect, because it is the one worth
          reaching for: every tool left on is re-sent to the model on every message,
          so a forty-tool server is a standing bill rather than a one-off. Reading
          forty descriptions to trim it is the part nobody does. Hidden until the
          server has listed something, since there is nothing to choose between.
        */}
        {server.tools.length > 0 && (
          <button
            onClick={onRecommend}
            disabled={recommending}
            title="Let the model keep the tools this agent actually needs"
            className={actionButton}
          >
            <span className="inline-flex items-center gap-2">
              {recommending ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <Sparkles size={14} strokeWidth={2} />
              )}
              {recommending ? "Choosing\u2026" : "Select recommended"}
            </span>
          </button>
        )}
        {server.auth === "oauth" &&
          (server.connected ? (
            <button
              onClick={() => onAction("disconnect")}
              disabled={busy}
              className={actionButton}
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => onAction("connect")}
              disabled={busy}
              className={`bg-ink text-canvas shrink-0 rounded-xl border px-2 py-1 text-[13px] font-semibold transition disabled:opacity-40`}
            >
              <span className="inline-flex items-center gap-2">Connect</span>
            </button>
          ))}
        <button
          onClick={() => onAction("refresh")}
          disabled={busy}
          className={actionButton}
        >
          <span className="inline-flex items-center gap-2">Refresh tools</span>
        </button>
        {manage && (
          <button onClick={onRemove} disabled={busy} className={actionButton}>
            <span className="inline-flex items-center gap-2">
              <Trash2 size={14} strokeWidth={2} />
              Remove
            </span>
          </button>
        )}
      </div>

      {open && (
        <div className="mt-5 space-y-4">
          {manage && (
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() =>
                  name.trim() && name !== server.name && onPatch({ name })
                }
                aria-label="Server name"
                className={`${input} flex-1`}
              />
            </div>
          )}

          {manage && !server.connected && (
            <>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() =>
                  url.trim() && url !== server.url && onPatch({ url })
                }
                aria-label="Server URL"
                className={input}
              />
              <AuthPicker
                value={server.auth}
                onChange={(auth) => onPatch({ auth })}
              />

              {server.auth === "headers" && (
                <div className="space-y-3">
                  <HeaderEditor pairs={pairs} onChange={setPairs} />
                  <button
                    onClick={() => onPatch({ headers: objectFrom(pairs) })}
                    disabled={busy}
                    className={button}
                  >
                    Save headers
                  </button>
                </div>
              )}
            </>
          )}

          {server.tools.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted text-xs leading-[1.33]">
                  Tools available. Switch one off to keep it from the agent.
                </span>
                <button
                  onClick={() =>
                    onToolsChange(
                      live === 0 ? [] : server.tools.map((t) => t.name),
                    )
                  }
                  className="text-muted hover:text-ink shrink-0 text-xs font-semibold"
                >
                  {live === 0 ? "Enable all" : "Disable all"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {server.tools.map((tool) => {
                  const on = !off.has(tool.name);
                  return (
                    <button
                      key={tool.name}
                      title={tool.description}
                      aria-pressed={on}
                      onClick={() =>
                        onToolsChange(
                          on
                            ? [...server.disabled_tools, tool.name]
                            : server.disabled_tools.filter(
                                (n) => n !== tool.name,
                              ),
                        )
                      }
                      // A tool that is off is struck out rather than recoloured: the
                      // badge stays readable, and the squiggle says "not this one"
                      // without the row turning into a block of solid pills.
                      className={`bg-canvas rounded-full border px-3 py-1.5 text-xs leading-[1.35] transition ${
                        on
                          ? "border-hairline text-ink hover:border-ink"
                          : "border-hairline text-faint"
                      }`}
                    >
                      {tool.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The add form, collapsed to a single button until it is wanted. */
function AddServer({
  onAdd,
  busy,
  preset,
}: {
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  /**
   * What a provider picked from the strip expects. The form is remounted when one
   * arrives, so the preset is simply where its fields start.
   */
  preset: McpPreset | null;
}) {
  const [open, setOpen] = useState(!!preset);
  const [name, setName] = useState(preset?.name ?? "");
  const [url, setUrl] = useState(preset?.url ?? "");
  const [auth, setAuth] = useState<McpAuth>(preset?.auth ?? "oauth");
  const [pairs, setPairs] = useState<HeaderPair[]>([{ key: "", value: "" }]);

  const reset = () => {
    setName("");
    setUrl("");
    setAuth("oauth");
    setPairs([{ key: "", value: "" }]);
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="border-ink-soft/20 text-ink hover:bg-canvas w-full rounded-[20px] border border-dashed py-4 text-sm font-semibold transition"
      >
        <span className="inline-flex items-center gap-2">
          <Plus size={16} strokeWidth={2} />
          Add an MCP server
        </span>
      </button>
    );
  }

  return (
    <div className="bg-canvas border-hairline space-y-4 rounded-[20px] border p-4">
      <input
        value={name}
        placeholder="Notion"
        onChange={(e) => setName(e.target.value)}
        aria-label="Server name"
        className={input}
      />
      <input
        value={url}
        placeholder="https://mcp.notion.com/mcp"
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Server URL"
        className={input}
      />
      <AuthPicker value={auth} onChange={setAuth} />
      {auth === "headers" && <HeaderEditor pairs={pairs} onChange={setPairs} />}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            const added = await onAdd({
              name,
              url,
              auth,
              ...(auth === "headers" ? { headers: objectFrom(pairs) } : {}),
            });
            if (added) reset();
          }}
          disabled={busy || !name.trim() || !url.trim()}
          className="bg-ink text-canvas rounded-2xl px-5 py-2.5 text-[13px] font-semibold transition disabled:opacity-40"
        >
          Add
        </button>
        <button onClick={reset} className={button}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What the provider's redirect left in the query string, if anything. */
function oauthResult(): { connected: string | null; failed: string | null } {
  if (typeof window === "undefined") return { connected: null, failed: null };
  const params = new URLSearchParams(window.location.search);
  return {
    connected: params.get("mcp_connected"),
    failed: params.get("mcp_error"),
  };
}

/**
 * The MCP capability's editor: the servers themselves, since a server is a row rather
 * than a setting and so cannot be described by the capability's `fields`.
 *
 * An OAuth connection leaves the app — the provider's consent screen is the point —
 * and comes back to this page with the result in the query string.
 */
export function McpServers({
  agentId,
  meta = false,
}: {
  agentId: string;
  /**
   * True for the copy inside the meta settings dialog, which owns the server list
   * however the setting below is left. Anywhere else the list may be the agent's to
   * build out or not, and `user_servers` is what says which.
   */
  meta?: boolean;
}) {
  // Servers belong to one agent. Every call below hangs off this, so there is no
  // path in here that could reach another agent's.
  const base = `/api/agents/${encodeURIComponent(agentId)}/mcp`;
  /** The flag that tells the Worker this is the dialog that owns the list. */
  const asOwner = meta ? "?meta=1" : "";
  const [servers, setServers] = useState<McpServer[]>([]);
  const [redirectUri, setRedirectUri] = useState("");
  // A picked provider, and a counter that remounts the form so it takes the values.
  const [preset, setPreset] = useState<McpPreset | null>(null);
  const [picks, setPicks] = useState(0);
  // The OAuth callback lands back here with its result in the query string. It is
  // read as the initial state rather than in an effect: it is already there on the
  // first render, and there is nothing to synchronize with afterwards.
  const [error, setError] = useState<string | null>(() => oauthResult().failed);
  const [busy, setBusy] = useState(false);
  /** Which server, if any, is having its tools chosen for it right now. */
  const [recommending, setRecommending] = useState<string | null>(null);
  /** Preset ids this agent's meta settings offer. Empty means every preset. */
  const [templates, setTemplates] = useState<string[]>([]);
  /** Templates provisioned for this agent, which replace the built-in strip. */
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  /** Whether the list itself may be changed from here. */
  const [manage, setManage] = useState(meta);

  // Which templates the strip offers, and whether the list may be changed here, are
  // admin settings — but they arrive with the list itself rather than from `/meta`,
  // which only the agent's admin may read.
  const load = useCallback(async () => {
    const res = await apiFetch(base, { cache: "no-store" });
    const payload = (await res.json().catch(() => null)) as {
      servers: McpServer[];
      redirect_uri: string;
      templates?: string[];
      catalog?: McpCatalogEntry[];
      user_servers?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      setError(payload?.error ?? "Couldn't load your MCP servers.");
      return;
    }
    setServers(payload.servers);
    setRedirectUri(payload.redirect_uri);
    setTemplates(payload.templates ?? []);
    setCatalog(payload.catalog ?? []);
    // The dialog manages the list whatever the setting says; everywhere else the
    // setting decides. An agent with no meta document has never been narrowed.
    if (!meta) setManage(payload.user_servers ?? true);
    setError(null);
  }, [base, meta]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Tidy the URL once the result has been shown, so a refresh does not replay it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("mcp_connected") && !params.has("mcp_error")) return;
    params.delete("mcp_connected");
    params.delete("mcp_error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  /** Every write goes through here: one server back, or a readable error. */
  const call = async (
    path: string,
    init: RequestInit,
  ): Promise<McpServer | null> => {
    setBusy(true);
    const res = await apiFetch(path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    setBusy(false);
    const payload = (await res.json().catch(() => null)) as {
      server?: McpServer;
      authorize_url?: string;
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      setError(payload?.error ?? "The agent isn't responding. Try again.");
      return null;
    }
    setError(null);
    // A connect hands back the provider's consent screen rather than a server.
    if (payload.authorize_url) {
      window.location.href = payload.authorize_url;
      return null;
    }
    if (payload.server) {
      setServers((all) =>
        all.some((s) => s.id === payload.server!.id)
          ? all.map((s) => (s.id === payload.server!.id ? payload.server! : s))
          : [...all, payload.server!],
      );
    }
    return payload.server ?? null;
  };

  /**
   * A write the UI shows straight away: the row is patched locally, the request goes
   * out behind it, and the row is put back the way it was if the Worker refuses.
   *
   * Switching a tool off is the case that needs this. Waiting for the round trip
   * before flipping the chip makes a switch feel broken, and the shared `busy` flag
   * would dim every other chip on the card while it was in flight.
   */
  const patchAhead = async (
    id: string,
    patch: Partial<McpServer>,
    body: unknown,
  ) => {
    const previous = servers.find((s) => s.id === id);
    setServers((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const res = await apiFetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as {
      server?: McpServer;
      error?: string;
    } | null;
    if (!res.ok || !payload?.server) {
      if (previous)
        setServers((all) => all.map((s) => (s.id === id ? previous : s)));
      setError(payload?.error ?? "Couldn't save that. Try again.");
      return;
    }
    setServers((all) => all.map((s) => (s.id === id ? payload.server! : s)));
    setError(null);
  };

  const add = async (body: Record<string, unknown>) =>
    (await call(`${base}${asOwner}`, {
      method: "POST",
      body: JSON.stringify(body),
    })) !== null;

  const remove = async (id: string) => {
    setBusy(true);
    await apiFetch(`${base}/${id}${asOwner}`, { method: "DELETE" });
    setBusy(false);
    setServers((all) => all.filter((s) => s.id !== id));
  };

  /**
   * Hand one server's tool choice to the model. Tracked per server rather than on the
   * shared `busy` flag: this is a model call, so it takes seconds, and dimming every
   * other card while it runs would read as the whole page having stalled.
   */
  const recommend = async (id: string) => {
    setRecommending(id);
    const res = await apiFetch(`${base}/${id}/recommend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setRecommending(null);
    const payload = (await res.json().catch(() => null)) as {
      server?: McpServer;
      error?: string;
    } | null;
    if (!res.ok || !payload?.server) {
      setError(
        payload?.error ?? "Couldn't choose tools for that server. Try again.",
      );
      return;
    }
    setServers((all) => all.map((s) => (s.id === id ? payload.server! : s)));
    setError(null);
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="bg-canvas border-hairline rounded-2xl border px-4 py-3 text-[13px] leading-[1.33]">
          {error}
        </p>
      )}

      {manage && (
        <McpPresetStrip
          // Meta settings decide which templates this agent is offered.
          only={templates}
          catalog={catalog}
          onPick={(picked) => {
            setPreset(picked);
            setPicks((n) => n + 1);
          }}
        />
      )}

      {servers.map((server) => (
        <ServerCard
          key={`${server.id}:${server.name}:${server.url}:${server.header_names.join(",")}`}
          server={server}
          busy={busy}
          manage={manage}
          onPatch={(patch) =>
            void call(`${base}/${server.id}${asOwner}`, {
              method: "PATCH",
              body: JSON.stringify(patch),
            })
          }
          onToolsChange={(disabled) =>
            void patchAhead(
              server.id,
              { disabled_tools: disabled },
              {
                disabled_tools: disabled,
              },
            )
          }
          onRecommend={() => void recommend(server.id)}
          recommending={recommending === server.id}
          onAction={(action) =>
            void call(`${base}/${server.id}/${action}`, {
              method: "POST",
              body: JSON.stringify({ return_to: window.location.href }),
            })
          }
          onRemove={() => void remove(server.id)}
        />
      ))}

      {manage ? (
        <AddServer key={picks} onAdd={add} busy={busy} preset={preset} />
      ) : (
        servers.length === 0 && (
          <p className="text-faint text-xs leading-[1.33]">
            This agent&rsquo;s MCP servers are managed for you.
          </p>
        )
      )}

      {redirectUri && (
        <p className="text-faint text-xs leading-[1.33]">
          Expect external providers to redirect to the following URL to complete
          OAuth flow: <span className="break-all font-bold">{redirectUri}</span>
        </p>
      )}
    </div>
  );
}
