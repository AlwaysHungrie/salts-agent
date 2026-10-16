import { Toggle } from "@/components/CapabilitySection";
import { toPreset } from "@/components/McpPresets";
import { McpServers } from "@/components/McpServers";
import type { McpCatalogEntry } from "@/lib/agent";
import { McpDefaults } from "./McpDefaults";
import type { MetaEditor } from "./metaEditor";
import { Section } from "./pieces";

/** Which MCP templates the agent's owner is offered. None selected offers them all. */
export function McpTemplatesSection({
  editor,
  mcpCatalog,
}: {
  editor: MetaEditor;
  /** The deployment's templates, replaced by the agent's own catalogue when it has one. */
  mcpCatalog: McpCatalogEntry[];
}) {
  const { meta, patch } = editor;
  const catalog = meta.mcp.catalog.length ? meta.mcp.catalog : mcpCatalog;
  return (
    <Section
      title="MCP templates"
      hint="MCP templates provide easier way to the user to add an MCP server. If none are selected, all of them are presented to the user."
    >
      <div className="flex flex-wrap gap-2">
        {catalog.map(toPreset).map((preset) => {
          const on = meta.mcp.templates.includes(preset.id);
          return (
            <button
              key={preset.id}
              onClick={() =>
                patch({
                  mcp: {
                    ...meta.mcp,
                    templates: on
                      ? meta.mcp.templates.filter((id) => id !== preset.id)
                      : [...meta.mcp.templates, preset.id],
                  },
                })
              }
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-semibold transition ${
                on ? "border-ink bg-canvas-soft" : "border-hairline hover:border-ink"
              }`}
            >
              {preset.logo}
              {preset.name}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * The agent's MCP servers and whether its owner may add more: the live editor once the
 * agent exists, else the list to create.
 */
export function McpServersSection({
  editor,
  agentId,
}: {
  editor: MetaEditor;
  agentId?: string;
}) {
  const { meta, patch, live } = editor;
  return (
    <Section
      title="MCP servers"
      hint={
        live
          ? "External capabilities this agent can call."
          : "External capabilities the agent is created with."
      }
    >
      {/* Off is for an agent handed to somebody else: they can still switch a server
          off, choose its tools and approve its OAuth, but not change the list. */}
      <div className="bg-canvas-soft mb-3 flex items-center justify-between gap-3 rounded-2xl px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-[1.43]">
            Allow adding more MCP servers
          </span>
        </span>
        <Toggle
          on={meta.mcp.user_servers}
          onChange={(v) => patch({ mcp: { ...meta.mcp, user_servers: v } })}
        />
      </div>

      {live && agentId ? (
        <McpServers agentId={agentId} meta />
      ) : (
        <McpDefaults
          servers={meta.mcp.servers}
          onChange={(servers) => patch({ mcp: { ...meta.mcp, servers } })}
        />
      )}
    </Section>
  );
}
