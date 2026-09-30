import { SETTABLE_CONFIG_KEYS, type SettableConfigKey } from "../settings";
import { type Config, DEFAULT_CONFIG, DEFAULT_META, type MetaSettings } from "./types";

/** The config columns, in the order they are written, excluding the primary key. */
export const CONFIG_COLUMNS = [
  "model",
  ...SETTABLE_CONFIG_KEYS,
  ...Object.keys(DEFAULT_CONFIG),
] as (keyof Config)[];

export function readMeta(storage: DurableObjectStorage): MetaSettings {
  const row = storage.sql.exec(`SELECT json FROM meta WHERE id = 1`).toArray()[0] as
    { json: string } | undefined;
  if (!row?.json) return DEFAULT_META;
  try {
    const stored = JSON.parse(row.json) as Partial<MetaSettings>;
    return {
      ...DEFAULT_META,
      ...stored,
      // Older rows stored bare ids; like an unknown id, assume they accept images.
      models: (stored.models ?? []).map((m) =>
        typeof m === "string" ? { id: m, vision: true } : m
      ),
      mcp: { ...DEFAULT_META.mcp, ...(stored.mcp ?? {}) },
    };
  } catch {
    // A blob we cannot read is one nobody can fix from the dialog either.
    return DEFAULT_META;
  }
}

export function writeMeta(storage: DurableObjectStorage, next: MetaSettings): MetaSettings {
  storage.sql.exec(
    `INSERT INTO meta (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    JSON.stringify(next)
  );
  return readMeta(storage);
}

export function loadConfigRow(
  storage: DurableObjectStorage,
  defaultModel: string,
  seed: Pick<Config, SettableConfigKey>
): Config {
  const row = storage.sql
    .exec(`SELECT ${CONFIG_COLUMNS.join(", ")} FROM config WHERE id = 1`)
    .toArray()[0] as Config | undefined;
  if (row) return row;
  const seeded: Config = { model: defaultModel, ...seed, ...DEFAULT_CONFIG };
  saveConfigRow(storage, seeded);
  return seeded;
}

export function patchConfigRow(
  storage: DurableObjectStorage,
  patch: Partial<Config>,
  defaultModel: string,
  seed: Pick<Config, SettableConfigKey>
): Config {
  const next = { ...loadConfigRow(storage, defaultModel, seed), ...patch };
  saveConfigRow(storage, next);
  return next;
}

export function saveConfigRow(storage: DurableObjectStorage, config: Config) {
  const placeholders = CONFIG_COLUMNS.map(() => "?").join(", ");
  const updates = CONFIG_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  storage.sql.exec(
    `INSERT INTO config (id, ${CONFIG_COLUMNS.join(", ")}) VALUES (1, ${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
    ...CONFIG_COLUMNS.map((c) => config[c])
  );
}
