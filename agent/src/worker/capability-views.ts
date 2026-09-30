import type { ModelOption } from "../models";
import { CAPABILITIES, type Capability } from "../capabilities";
import type { MetaSettings, ModelChoice } from "../registry";
import type { DeploymentSettings } from "../settings";

/**
 * What the settings page may offer as models.
 *
 * The agent's own list wins where it has one, and the deployment's catalogue is what
 * an empty list means. A chosen model keeps its catalogue label when it has one, and
 * is shown as the id it is otherwise — but the vision flag is always the one chosen
 * beside it, because that is the answer somebody actually gave for this agent.
 */
export function modelOptions(chosen: ModelChoice[], catalog: ModelOption[]): ModelOption[] {
  if (!chosen.length) return catalog;
  return chosen.map(({ id, vision }) => ({
    id,
    label: catalog.find((m) => m.id === id)?.label ?? id,
    vision,
  }));
}

/**
 * The capability list with the deployment's own upload ceilings written into the note
 * the page shows.
 *
 * The note quotes two numbers, and a deployment that has raised either of them would
 * otherwise tell every user the shipped figure — which is the one kind of wrong
 * documentation nobody can correct, because it is generated.
 */
export function notedCapabilities(list: Capability[], settings: DeploymentSettings): Capability[] {
  const mb = (n: number) => `${Number((n / 1_000_000).toFixed(1))} MB`;
  return list.map((capability) =>
    capability.id === "file_ingest"
      ? {
          ...capability,
          note:
            `Markdown, CSV, JSON and code up to ${mb(settings.max_upload_bytes.text)}; ` +
            `PDFs up to ${mb(settings.max_upload_bytes.pdf)}.`,
        }
      : capability
  );
}

/**
 * The capability list with the fixed-choice model menus filled in.
 *
 * The menu is the deployment's `field_options` — the code ships none. This agent's own
 * meta document may answer a column with its own list of ids, which wins outright: an
 * agent's administrator is closer to the agent than the deployment's owner is. An id
 * the deployment names keeps its name there; one it does not is shown as the id.
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
