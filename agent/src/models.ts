import type { DeploymentSettings } from "./settings";

/** A model the settings page may offer: what it is called, and whether it sees images. */
export type ModelOption = { id: string; label: string; vision: boolean };

/** The models this deployment offers: its `models` setting, copied. */
export function modelCatalog(settings: DeploymentSettings): ModelOption[] {
  return settings.models.map((m) => ({ ...m }));
}
