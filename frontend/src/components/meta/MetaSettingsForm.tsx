import { Field } from "@/components/CapabilitySection";
import type {
  Capability,
  Config,
  McpCatalogEntry,
  MetaSettings,
  ModelOption,
  SpendState,
} from "@/lib/agent";
import { CapabilitiesSection } from "./CapabilitiesSection";
import { McpServersSection, McpTemplatesSection } from "./McpSections";
import { metaEditor } from "./metaEditor";
import { OPENROUTER_KEY, Section } from "./pieces";
import { LimitsSection, ModelOptionSections } from "./PolicySections";
import { TuningSections } from "./TuningSections";

/**
 * Meta settings: the settings page, plus the decisions the agent's owner does not get
 * to make.
 *
 * Every setting the agent's own pages offer is here with a lock beside it; a locked
 * setting disappears from those pages. Around them sit the choices those pages have no
 * editor for: which models may be offered, what a fixed choice may be widened to,
 * which MCP templates are shown.
 *
 * Reached from the create dialog's second step (collecting defaults, no agent yet) and
 * from a dialog on the home page (editing a live agent) — see `metaEditor` for how one
 * form serves both.
 */
export function MetaSettingsForm({
  meta,
  onChange,
  models,
  capabilities,
  config,
  onConfigChange,
  agentId,
  onlyOpenrouter = false,
  spend,
  mcpCatalog = [],
}: {
  meta: MetaSettings;
  onChange: (next: MetaSettings) => void;
  models: ModelOption[];
  /** The deployment's MCP templates, which this agent's own catalogue replaces when it has one. */
  mcpCatalog?: McpCatalogEntry[];
  capabilities: Capability[];
  /** The agent's own settings, once there is an agent. Null in the create dialog. */
  config?: Config | null;
  /** Stage a change to those settings. Ignored while there is no agent. */
  onConfigChange?: (patch: Partial<Config>) => void;
  agentId?: string;
  /**
   * Show the OpenRouter key and nothing else: a lone agent's maker is its only user,
   * so every lock and default would be a decision about themselves.
   */
  onlyOpenrouter?: boolean;
  /** What the agent has spent this month, once there is an agent to have spent it. */
  spend?: SpendState | null;
}) {
  const editor = metaEditor({
    meta,
    onChange,
    config,
    onConfigChange,
    models,
    capabilities,
  });
  const key = editor.valueOf("openrouter_api_key") ?? "";
  const setKey = (v: string) => editor.setValue("openrouter_api_key", v);

  if (onlyOpenrouter)
    return (
      // Bare: the dialog around it is already titled with what this box is for.
      <Field
        field={{ ...OPENROUTER_KEY, label: undefined, hint: undefined }}
        value={key}
        onChange={setKey}
      />
    );

  return (
    <div>
      <Section
        title="OpenRouter"
        hint="The key every model call is billed to."
        {...editor.lock("openrouter_api_key")}
      >
        <Field field={OPENROUTER_KEY} value={key} onChange={setKey} />
      </Section>
      <LimitsSection editor={editor} spend={spend} />
      <ModelOptionSections editor={editor} catalog={models} />
      <TuningSections editor={editor} />
      <CapabilitiesSection editor={editor} capabilities={capabilities} />
      <McpTemplatesSection editor={editor} mcpCatalog={mcpCatalog} />
      <McpServersSection editor={editor} agentId={agentId} />
    </div>
  );
}
