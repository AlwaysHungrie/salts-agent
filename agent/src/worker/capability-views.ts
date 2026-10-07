import type { ModelOption } from "../models";
import { CAPABILITIES, type Capability } from "../capabilities";
import type { MetaSettings, ModelChoice } from "../registry";
import type { DeploymentSettings } from "../settings";

/**
 * Models the settings page may offer: the agent's list (with its vision flags), else the
 * deployment catalogue.
 */
export function modelOptions(chosen: ModelChoice[], catalog: ModelOption[]): ModelOption[] {
  if (!chosen.length) return catalog;
  return chosen.map(({ id, vision }) => ({
    id,
    label: catalog.find((m) => m.id === id)?.label ?? id,
    vision,
  }));
}

/** Capabilities with the deployment's actual upload limits written into the file note. */
export function notedCapabilities(list: Capability[], settings: DeploymentSettings): Capability[] {
  const mb = (n: number) => `${Number((n / 1_000_000).toFixed(1))} MB`;
  return list.map((capability) =>
    capability.id === "file_ingest"
      ? {
          ...capability,
          note:
            `Markdown, CSV, JSON and code up to ${mb(settings.max_upload_bytes.text)}; ` +
            `PDFs up to ${mb(settings.max_upload_bytes.pdf)}; Excel workbooks up to ` +
            `${mb(settings.max_upload_bytes.sheet)} for an MCP server that reads them.`,
        }
      : capability
  );
}

/**
 * Capabilities with the fixed-choice menus filled in from the deployment's `field_options`,
 * or the agent's own list, which wins.
 */
export function capabilitiesFor(meta: MetaSettings, settings: DeploymentSettings): Capability[] {
  const menus = settings.field_options as Record<string, { id: string; label: string }[]>;
  return CAPABILITIES.map((capability) => {
    if (!capability.fields.some((f) => f.options)) return capability;
    return {
      ...capability,
      fields: capability.fields.map((field) => {
        if (!field.options) return field;
        const menu = menus[String(field.key)] ?? [];
        const own = meta.field_options[String(field.key)] ?? [];
        return {
          ...field,
          options: own.length
            ? own.map((id) => ({ value: id, label: menu.find((o) => o.id === id)?.label ?? id }))
            : menu.map((o) => ({ value: o.id, label: o.label })),
        };
      }),
    };
  });
}
