import type { DeploymentSettings } from "./settings";

/** A model the settings page may offer: what it is called, and whether it sees images. */
export type ModelOption = { id: string; label: string; vision: boolean };

/** The models this deployment offers: its `models` setting, copied. */
export function modelCatalog(settings: DeploymentSettings): ModelOption[] {
  return settings.models.map((m) => ({ ...m }));
}

/**
 * A model's nicknames: whatever its label holds in brackets, so "DeepSeek V4.1 Flash (ds)"
 * answers to `!model ds`. A label without brackets has none.
 */
export function modelNicknames(label: string): string[] {
  return [...label.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
}
