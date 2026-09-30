import {
  completeSettings,
  type DeploymentSettings,
  missingSettings,
  parseStoredSettings,
  SettingsError,
  type StoredSettings,
  validateSettingsPatch,
} from "../settings";

export function directorySettings(storage: DurableObjectStorage): DeploymentSettings {
  return completeSettings(storedSettings(storage));
}

export function storedSettings(storage: DurableObjectStorage): StoredSettings {
  const row = storage.sql.exec(`SELECT json FROM deployment_settings WHERE id = 1`).toArray()[0] as
    { json: string } | undefined;
  return parseStoredSettings(String(row?.json ?? ""));
}

export function setSettings(
  storage: DurableObjectStorage,
  patch: unknown
): { settings: StoredSettings; missing: string[] } | { error: string } {
  let next: StoredSettings;
  try {
    next = validateSettingsPatch(patch, storedSettings(storage));
  } catch (err) {
    if (err instanceof SettingsError) return { error: err.message };
    throw err;
  }
  storage.sql.exec(
    `INSERT INTO deployment_settings (id, json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    JSON.stringify(next),
    Date.now()
  );
  return { settings: next, missing: missingSettings(next) };
}

export function clearSettings(storage: DurableObjectStorage): void {
  storage.sql.exec(`DELETE FROM deployment_settings WHERE id = 1`);
}
