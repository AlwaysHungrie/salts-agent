import type { McpAuth, MetaMcpServer } from "@/lib/agent";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { inputClass } from "./pieces";

/** The default-server list: name, URL, how it authenticates, and its headers. */
export function McpDefaults({
  servers,
  onChange,
}: {
  servers: MetaMcpServer[];
  onChange: (servers: MetaMcpServer[]) => void;
}) {
  const edit = (i: number, patch: Partial<MetaMcpServer>) =>
    onChange(servers.map((s, n) => (n === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-3">
      {servers.map((server, i) => (
        <div key={i} className="bg-canvas-soft space-y-3 rounded-2xl px-4 py-4">
          <div className="flex items-center gap-2">
            <input
              value={server.name}
              placeholder="Notion"
              aria-label="Server name"
              onChange={(e) => edit(i, { name: e.target.value })}
              className={inputClass}
            />
            <button
              onClick={() => onChange(servers.filter((_, n) => n !== i))}
              aria-label={`Remove ${server.name || "server"}`}
              className="text-muted hover:text-ink shrink-0 transition"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
          <input
            value={server.url}
            placeholder="https://mcp.notion.com/mcp"
            aria-label="Server URL"
            onChange={(e) => edit(i, { url: e.target.value })}
            className={inputClass}
          />
          <select
            value={server.auth}
            onChange={(e) => edit(i, { auth: e.target.value as McpAuth })}
            aria-label="Authentication"
            className={`${inputClass} appearance-none`}
          >
            <option value="none">No auth</option>
            <option value="headers">Headers</option>
            <option value="oauth">OAuth</option>
          </select>
          <HeaderRows
            headers={server.headers}
            onChange={(headers) => edit(i, { headers })}
          />
        </div>
      ))}

      <button
        onClick={() =>
          onChange([
            ...servers,
            { name: "", url: "", auth: "oauth", headers: {} },
          ])
        }
        className="border-ink-soft/20 text-ink hover:bg-canvas-soft w-full rounded-2xl border border-dashed py-3 text-[13px] font-semibold transition"
      >
        <span className="inline-flex items-center gap-2">
          <Plus size={14} strokeWidth={2} />
          Add a server
        </span>
      </button>
    </div>
  );
}

/** Default headers edited as rows (local state), so a half-typed pair survives until named. */
export function HeaderRows({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => {
    const pairs = Object.entries(headers) as [string, string][];
    return pairs.length > 0 ? pairs : [["", ""]];
  });

  const write = (next: [string, string][]) => {
    setRows(next);
    onChange(
      Object.fromEntries(next.filter(([k]) => k.trim() !== "")) as Record<
        string,
        string
      >,
    );
  };

  return (
    <div className="space-y-2">
      {rows.map(([key, value], i) => (
        <div key={i} className="flex gap-2">
          <input
            value={key}
            placeholder="Authorization"
            aria-label="Header name"
            onChange={(e) => {
              const next = [...rows];
              next[i] = [e.target.value, value];
              write(next);
            }}
            className={inputClass}
          />
          <input
            value={value}
            placeholder="Bearer …"
            aria-label="Header value"
            onChange={(e) => {
              const next = [...rows];
              next[i] = [key, e.target.value];
              write(next);
            }}
            className={inputClass}
          />
        </div>
      ))}
      <button
        onClick={() => setRows([...rows, ["", ""]])}
        className="text-muted hover:text-ink text-xs font-semibold transition"
      >
        + Add header
      </button>
    </div>
  );
}
