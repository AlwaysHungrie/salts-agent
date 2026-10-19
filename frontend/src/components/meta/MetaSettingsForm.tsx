import { WalletKeyPicker } from "@/components/wallet/WalletKeyPicker";
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
import { Section } from "./pieces";
import { LimitsSection, ModelOptionSections } from "./PolicySections";
import { TuningSections } from "./TuningSections";

/**
 * Meta settings: every agent setting with a lock beside it (locked ones vanish from the
 * agent's pages), plus model lists, choice widening and MCP templates. Used for new
 * agents' defaults and live agents alike; see `metaEditor`.
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
  // Keys are picked from the wallet by nickname; the Worker copies the key itself in.
  const keyId = editor.valueOf("openrouter_key_id") ?? "";
  const hasKey = !!editor.valueOf("openrouter_api_key");
  const setKeyId = (id: string) => editor.setValue("openrouter_key_id", id);

  if (onlyOpenrouter)
    return (
      // Bare: the dialog around it is already titled with what this box is for.
      <WalletKeyPicker value={keyId} hasKey={hasKey} onChange={setKeyId} />
    );

  return (
    <div>
      <Section
        title="OpenRouter"
        hint="The key every model call is billed to."
        {...editor.lock("openrouter_api_key")}
      >
        <WalletKeyPicker value={keyId} hasKey={hasKey} onChange={setKeyId} />
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
