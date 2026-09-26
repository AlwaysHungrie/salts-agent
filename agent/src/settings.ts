import type { Config, McpCatalogEntry } from "./registry";
import type { Env, ModelOption } from "./agent";

/**
 * The deployment's own knobs: every ceiling this Worker enforces, and every value an
 * agent starts out holding, in one document the owner can change without a deploy.
 *
 * Why a document and not constants. A ceiling is a decision about a deployment, not
 * about the code — the same Worker runs a demo where 20 sessions is generous and a
 * business account where 256 is tight.
 *
 * Why there is no fallback. This Worker ships with no values of its own: every field
 * has to be in the stored document, and a deployment missing any of them refuses to
 * serve (see `SettingsIncompleteError`) until the owner sets it. The values a fresh
 * deployment starts from ship with the admin CLI (`admin-cli/defaults.json`), which
 * writes them here — so the number in force is always one somebody wrote down for
 * this deployment, never one the code decided on its behalf.
 *
 * Why `0` is not "absent". Several of these are legitimately zero (`max_tokens: 0` is
 * "no cap"), so absence has to be key-not-present rather than a sentinel.
 *
 * Secrets are deliberately not here. An OpenRouter key, a bot token and a Meta app
 * secret belong to one agent and are billed to it; a deployment-wide default for one
 * would be a deployment-wide key, which is the thing `openrouter_api_key` exists to
 * prevent. `config_defaults` is restricted to `SETTABLE_CONFIG_KEYS` for that reason.
 */

/** The attachment kinds a ceiling is set for. */
export const UPLOAD_KINDS = ["text", "pdf", "image", "audio"] as const;

/** Attachment ceilings, per kind. */
export type UploadLimits = Record<(typeof UPLOAD_KINDS)[number], number>;

/**
 * The config columns a deployment may pick a starting value for.
 *
 * Tuning and capability switches only. Every column left out is either a secret, or
 * per-agent by nature (`agent_name`, the whitelists, the WhatsApp number), or the
 * model — which has its own field because it is also validated against the catalogue.
 */
export const SETTABLE_CONFIG_KEYS = [
  "temperature",
  "max_tokens",
  "reasoning_effort",
  "context_messages",
  "image_model",
  "transcription_model",
  "voice_model",
  "cap_web_search",
  "cap_url_fetch",
  "cap_file_ingest",
  "cap_vision",
  "cap_image_generation",
  "cap_audio_input",
  "cap_voice_output",
  "cap_scheduled_tasks",
  "cap_memory",
  "cap_telegram",
  "cap_whatsapp",
  "cap_mcp",
] as const;

export type SettableConfigKey = (typeof SETTABLE_CONFIG_KEYS)[number];

/**
 * The config columns whose *list of choices* the deployment sets.
 *
 * These three are the fixed-choice fields on the capabilities page: the page offers a
 * menu rather than a text box, because most OpenRouter ids would fail outright for the
 * modality the capability needs. Which ids are on that menu is a question about the
 * deployment, so it is answered here and nowhere in the code — `MetaSettings.field_options`
 * narrows it one agent at a time, and wins where it has an answer.
 *
 * Named here rather than read off `CAPABILITIES` so this module does not import
 * `capabilities.ts`, which imports this one.
 */
export const CHOICE_FIELD_KEYS = ["image_model", "transcription_model", "voice_model"] as const;

/** One entry on a fixed-choice menu: an OpenRouter id, and the name it is shown under. */
export type ChoiceOption = { id: string; label: string };

export type DeploymentSettings = {
  /* ---- hard limits ---- */

  /** How many sessions one agent may hold at once. */
  max_sessions: number;
  /** How many bytes of uploaded and generated files one agent may hold, across every session. */
  max_agent_bytes: number;
  /** How many addresses one agent's access list may grow to. */
  max_members: number;
  /** How many agents an account with no `account_limits` row may administer. */
  default_agent_limit: number;
  /** Attachment ceilings, per kind. */
  max_upload_bytes: UploadLimits;
  /** Past this, a first-page render is not a thumbnail. */
  max_thumbnail_bytes: number;
  /** How many times one turn may call tools before it must answer. */
  max_tool_rounds: number;
  /** Messages per transcript page when the caller does not ask for a size. */
  message_page: number;
  /** The largest transcript page any caller may ask for. */
  max_message_page: number;
  /** Sessions per page when the caller does not ask for a size. */
  session_page: number;
  /** Agents per page when the caller does not ask for a size. */
  agent_page: number;
  /** The largest agent page any caller may ask for. */
  max_agent_page: number;
  /** How much text one voice note may carry. */
  voice_note_limit: number;
  /**
   * How many attachments one message may carry.
   *
   * Enforced in the composer rather than in the Worker — it is about how much a single
   * turn should be asked to read, not about what the deployment can hold — so it is
   * served to the page alongside the upload ceilings it sits next to.
   */
  max_files_per_message: number;
  /** The largest session page any caller may ask for. */
  max_session_page: number;
  /** The largest SVG icon an MCP template may carry, in bytes. */
  max_icon_bytes: number;
  /**
   * Past this many prompt tokens in one model call, the session's older messages are
   * summarised before its next turn. `0` never compacts on its own; `!compact` still
   * works. See `maybeCompact` in agent.ts.
   */
  compact_after_tokens: number;

  /* ---- soft defaults ---- */

  /** The models the settings page offers. At least one. */
  models: ModelOption[];
  /** The model every new agent is seeded with. */
  default_model: string;
  /** What every agent is told before its own `system_prompt`. Blank says nothing. */
  system_prompt: string;
  /** Starting values for the tuning and capability columns — every one of them. */
  config_defaults: Pick<Config, SettableConfigKey>;
  /**
   * MCP providers offered as templates on the capabilities page. The frontend ships
   * none of its own, so empty offers none.
   */
  mcp_catalog: McpCatalogEntry[];
  /**
   * The menu for each fixed-choice model field, by config column — every one of
   * `CHOICE_FIELD_KEYS`, at least one entry each. The Worker ships no menu of its own.
   */
  field_options: Record<(typeof CHOICE_FIELD_KEYS)[number], ChoiceOption[]>;
};

/**
 * The document as stored. Partial, because a deployment is set up one field at a time
 * and a Worker upgraded to a version with a new field has not been told it yet — but
 * never served partial: see `completeSettings`.
 */
export type StoredSettings = Partial<DeploymentSettings>;

/**
 * One field, as the admin CLI needs to draw and check it.
 *
 * Served over `/api/admin/settings` rather than duplicated in the CLI, so a field
 * added here shows up in the dialog without a second edit — and so the range the CLI
 * refuses is the same range the Worker refuses.
 */
export type SettingsField = {
  key: keyof DeploymentSettings;
  kind: "int" | "number" | "string" | "json";
  /** Inclusive, for the numeric kinds. */
  min?: number;
  max?: number;
  /** What the field decides, in one line. */
  doc: string;
  /** Which admin CLI tab it sits on: a hard limit, or a soft default. */
  group: "limit" | "default";
};

const INT = (
  key: keyof DeploymentSettings,
  min: number,
  max: number,
  doc: string
): SettingsField => ({ key, kind: "int", min, max, doc, group: "limit" });

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  INT("max_sessions", 1, 100_000, "sessions one agent may hold at once"),
  INT("max_agent_bytes", 1, 1_000_000_000_000, "file storage one agent may hold, in bytes"),
  INT("max_members", 1, 100_000, "addresses one agent's access list may hold"),
  INT("default_agent_limit", 1, 100_000, "agents an ordinary account may administer"),
  { key: "max_upload_bytes", kind: "json", doc: "attachment ceiling per kind: text, pdf, image, audio", group: "limit" },
  INT("max_thumbnail_bytes", 1, 100_000_000_000, "largest bytes a PDF thumbnail may take"),
  INT("max_tool_rounds", 1, 100, "tool rounds one turn may take before it must answer"),
  INT("message_page", 1, 1000, "transcript page size when none is asked for"),
  INT("max_message_page", 1, 10_000, "largest transcript page a caller may ask for"),
  INT("session_page", 1, 1000, "session list page size when none is asked for"),
  INT("agent_page", 1, 1000, "agent list page size when none is asked for"),
  INT("max_agent_page", 1, 10_000, "largest agent page a caller may ask for"),
  INT("voice_note_limit", 1, 100_000, "characters one voice note may carry"),
  INT("max_files_per_message", 1, 100, "attachments one message may carry"),
  INT("max_session_page", 1, 10_000, "largest session page a caller may ask for"),
  INT("max_icon_bytes", 1, 1_000_000, "largest SVG icon an MCP template may carry, in bytes"),
  INT("compact_after_tokens", 0, 10_000_000, "prompt tokens past which older messages are summarised; 0 never auto-compacts"),

  { key: "models", kind: "json", doc: "models the settings page offers: [{id,label,vision}], at least one", group: "default" },
  { key: "default_model", kind: "string", doc: "model a new agent is seeded with", group: "default" },
  { key: "system_prompt", kind: "string", doc: "line every agent is told first; blank says nothing", group: "default" },
  { key: "config_defaults", kind: "json", doc: `starting values for every one of: ${SETTABLE_CONFIG_KEYS.join(", ")}`, group: "default" },
  { key: "mcp_catalog", kind: "json", doc: "MCP templates offered: [{id,name,url,auth,icon?,letter?,color?}], icon an SVG; empty offers none", group: "default" },
  {
    key: "field_options",
    kind: "json",
    doc: `models each fixed-choice field offers (${CHOICE_FIELD_KEYS.join(", ")}): [{id,label}], at least one`,
    group: "default",
  },
];

const FIELD_BY_KEY = new Map(SETTINGS_FIELDS.map((f) => [f.key as string, f]));

/**
 * Every field the stored document does not have yet, as dotted paths.
 *
 * Nested ones are named per key (`max_upload_bytes.pdf`, `config_defaults.cap_mcp`)
 * so the refusal says exactly what to set, not just which object is short.
 */
export function missingSettings(stored: StoredSettings): string[] {
  const missing: string[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (stored[field.key] === undefined) missing.push(field.key);
  }
  if (stored.max_upload_bytes) {
    for (const kind of UPLOAD_KINDS) {
      if (stored.max_upload_bytes[kind] === undefined) missing.push(`max_upload_bytes.${kind}`);
    }
  }
  if (stored.config_defaults) {
    for (const key of SETTABLE_CONFIG_KEYS) {
      if (stored.config_defaults[key] === undefined) missing.push(`config_defaults.${key}`);
    }
  }
  if (stored.field_options) {
    // A column still holding bare ids is from before menus carried their names, so it
    // is as good as unset: `init` writes the shipped menu over it.
    for (const key of CHOICE_FIELD_KEYS) {
      const menu = stored.field_options[key] as unknown;
      if (!Array.isArray(menu) || !menu.length || menu.some((o) => !isObject(o))) {
        missing.push(`field_options.${key}`);
      }
    }
  }
  if (stored.models && !stored.models.length) missing.push("models");
  if (stored.default_model !== undefined && !stored.default_model.trim()) {
    missing.push("default_model");
  }
  return missing;
}

/** What a deployment with an incomplete settings document answers with. */
export class SettingsIncompleteError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `This deployment's settings are incomplete: ${missing.join(", ")} not set. ` +
        "Set them with the admin CLI — `npm run init` in admin-cli writes the shipped defaults for every field not yet set."
    );
  }
}

/** The stored document as the full settings, or a refusal naming what is missing. */
export function completeSettings(stored: StoredSettings): DeploymentSettings {
  const missing = missingSettings(stored);
  if (missing.length) throw new SettingsIncompleteError(missing);
  return structuredClone(stored) as DeploymentSettings;
}

/** What a rejected patch says. Thrown, so every caller reports it the same way. */
export class SettingsError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function requireInt(key: string, value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SettingsError(`${key} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/**
 * Check an incoming patch and return the part of it that is a setting.
 *
 * Unknown keys are refused rather than ignored: a typo in `max_session` that silently
 * did nothing would look exactly like a limit that does not work, and the owner has
 * no log to find out which. `null` is refused too: every field is required, so there
 * is nothing for "unset" to fall back to.
 */
export function validateSettingsPatch(
  input: unknown,
  current: StoredSettings
): StoredSettings {
  if (!isObject(input)) throw new SettingsError("a settings object is required");
  // A key this Worker no longer has a field for is dropped on the way through, so a
  // setting removed from the code leaves the stored document on its next save.
  const next: StoredSettings = Object.fromEntries(
    Object.entries(current).filter(([key]) => FIELD_BY_KEY.has(key))
  );

  for (const [key, value] of Object.entries(input)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) throw new SettingsError(`unknown setting: ${key}`);

    if (value === null || value === undefined) {
      throw new SettingsError(`${key} cannot be unset: every setting is required`);
    }

    switch (field.key) {
      case "max_upload_bytes": {
        if (!isObject(value)) throw new SettingsError("max_upload_bytes must be an object");
        const merged: Partial<UploadLimits> = { ...next.max_upload_bytes };
        for (const [kind, bytes] of Object.entries(value)) {
          if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) {
            throw new SettingsError(`unknown upload kind: ${kind}`);
          }
          merged[kind as keyof UploadLimits] = requireInt(
            `max_upload_bytes.${kind}`,
            bytes,
            1,
            100_000_000_000
          );
        }
        next.max_upload_bytes = merged as UploadLimits;
        break;
      }
      case "models": {
        if (!Array.isArray(value) || !value.length) {
          throw new SettingsError("models must be an array of at least one model");
        }
        next.models = value.map((m, i) => {
          if (!isObject(m)) throw new SettingsError(`models[${i}] must be an object`);
          const id = String(m.id ?? "").trim();
          if (!id) throw new SettingsError(`models[${i}].id is required`);
          const label = String(m.label ?? id).trim() || id;
          // Absent means yes: only a model that cannot be sent an image has to say so.
          return { id, label, vision: m.vision === undefined ? true : !!m.vision };
        });
        break;
      }
      case "mcp_catalog": {
        if (!Array.isArray(value)) throw new SettingsError("mcp_catalog must be an array");
        next.mcp_catalog = value.map((entry, i) => {
          if (!isObject(entry)) throw new SettingsError(`mcp_catalog[${i}] must be an object`);
          const id = String(entry.id ?? "").trim();
          const name = String(entry.name ?? "").trim();
          const url = String(entry.url ?? "").trim();
          const auth = String(entry.auth ?? "oauth").trim();
          if (!id || !name || !url) {
            throw new SettingsError(`mcp_catalog[${i}] needs an id, a name and a url`);
          }
          if (auth !== "none" && auth !== "headers" && auth !== "oauth") {
            throw new SettingsError(`mcp_catalog[${i}].auth must be none, headers or oauth`);
          }
          const out: McpCatalogEntry = { id, name, url, auth };
          if (entry.icon !== undefined) out.icon = svgIcon(entry.icon, `mcp_catalog[${i}].icon`);
          if (entry.letter !== undefined) out.letter = String(entry.letter).trim().slice(0, 1);
          if (entry.color !== undefined) out.color = String(entry.color).trim();
          return out;
        });
        break;
      }
      case "field_options": {
        if (!isObject(value)) throw new SettingsError("field_options must be an object");
        const merged: Record<string, ChoiceOption[]> = { ...next.field_options };
        for (const [column, menu] of Object.entries(value)) {
          if (!(CHOICE_FIELD_KEYS as readonly string[]).includes(column)) {
            throw new SettingsError(
              `field_options.${column} is not a choice field; one of: ${CHOICE_FIELD_KEYS.join(", ")}`
            );
          }
          if (!Array.isArray(menu) || !menu.length) {
            throw new SettingsError(`field_options.${column} must be a list of at least one model`);
          }
          const seen = new Set<string>();
          merged[column] = menu.flatMap((entry, i) => {
            if (!isObject(entry)) {
              throw new SettingsError(`field_options.${column}[${i}] must be {id, label}`);
            }
            const id = String(entry.id ?? "").trim();
            // Same shape check the meta route applies: a provider id, not prose.
            if (!/^[\w.-]+\/[\w.\-:]+$/.test(id)) {
              throw new SettingsError(`not an OpenRouter model id: ${id}`);
            }
            if (seen.has(id)) return [];
            seen.add(id);
            return [{ id, label: String(entry.label ?? id).trim() || id }];
          });
        }
        next.field_options = merged as DeploymentSettings["field_options"];
        break;
      }
      case "config_defaults": {
        if (!isObject(value)) throw new SettingsError("config_defaults must be an object");
        const merged: Record<string, unknown> = { ...next.config_defaults };
        for (const [column, setting] of Object.entries(value)) {
          if (!(SETTABLE_CONFIG_KEYS as readonly string[]).includes(column)) {
            throw new SettingsError(
              `config_defaults.${column} is not a settable column; one of: ${SETTABLE_CONFIG_KEYS.join(", ")}`
            );
          }
          if (setting === null) {
            throw new SettingsError(`config_defaults.${column} cannot be unset: every setting is required`);
          }
          merged[column] = validateConfigDefault(column as SettableConfigKey, setting);
        }
        next.config_defaults = merged as Pick<Config, SettableConfigKey>;
        break;
      }
      case "default_model": {
        if (typeof value !== "string" || !value.trim()) {
          throw new SettingsError("default_model must be a model id");
        }
        next.default_model = value.trim();
        break;
      }
      case "system_prompt": {
        if (typeof value !== "string") throw new SettingsError(`${key} must be a string`);
        next.system_prompt = value;
        break;
      }
      default: {
        next[field.key] = requireInt(key, value, field.min ?? 1, field.max ?? Number.MAX_SAFE_INTEGER) as never;
      }
    }
  }

  // A page default above its own ceiling would clamp to the ceiling on every read,
  // which reads as the default being ignored. Refuse instead of silently winning.
  // Checked once both halves of a pair are set; until then there is nothing to compare.
  for (const [page, max] of [
    ["message_page", "max_message_page"],
    ["agent_page", "max_agent_page"],
    ["session_page", "max_session_page"],
  ] as const) {
    const size = next[page];
    const ceiling = next[max];
    if (size !== undefined && ceiling !== undefined && size > ceiling) {
      throw new SettingsError(`${page} cannot exceed ${max}`);
    }
  }

  // Checked once the whole patch is in, so a catalogue and a lowered ceiling sent
  // together are held to the new ceiling.
  if (next.max_icon_bytes !== undefined) {
    for (const entry of next.mcp_catalog ?? []) {
      if (entry.icon) checkIconSize(entry.icon, next.max_icon_bytes, `mcp_catalog ${entry.id}`);
    }
  }
  return next;
}

/** One config column's starting value, checked the way the agent's own settings route checks it. */
function validateConfigDefault(column: SettableConfigKey, value: unknown): number | string {
  if (column === "temperature") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      throw new SettingsError("config_defaults.temperature must be between 0 and 2");
    }
    return n;
  }
  if (column === "max_tokens") return requireInt(column, value, 0, 1_000_000);
  if (column === "context_messages") return requireInt(column, value, 0, 10_000);
  if (column === "reasoning_effort") {
    const effort = String(value);
    if (!["off", "low", "medium", "high"].includes(effort)) {
      throw new SettingsError("config_defaults.reasoning_effort must be off, low, medium or high");
    }
    return effort;
  }
  if (column.startsWith("cap_")) {
    // Stored as 0/1: SQLite has no boolean, and the column is an INTEGER.
    if (typeof value === "boolean") return value ? 1 : 0;
    return requireInt(column, value, 0, 1);
  }
  // The three model columns. An id typed in is not checked against a catalogue —
  // same reasoning as `models`: the built-in choices are a starting point, not a limit.
  const id = String(value).trim();
  if (!id) throw new SettingsError(`config_defaults.${column} cannot be blank`);
  return id;
}

/**
 * Read the stored document back, tolerating the row never having been written.
 *
 * A row nobody can parse reads as empty, which `completeSettings` then refuses field
 * by field — the owner sees what to set rather than a parse error.
 */
export function parseStoredSettings(json: string): StoredSettings {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return isObject(parsed) ? (parsed as StoredSettings) : {};
  } catch {
    return {};
  }
}

/**
 * How long a cached copy of the settings may be trusted, in milliseconds.
 *
 * The document is read on paths that run per turn and per upload, and it lives in one
 * Durable Object, so reading it every time would put an RPC hop in front of every
 * message this deployment answers. Ten seconds is short enough that a change made in
 * the admin CLI is in force before the owner has finished reading the confirmation,
 * and long enough that a busy isolate reads it once rather than hundreds of times.
 *
 * The cost of the staleness is bounded and one-directional: for up to ten seconds an
 * object may enforce the old ceiling. Nothing here is a security boundary — the
 * identity gates are elsewhere — so an extra upload against a lowered limit is the
 * worst case, and it corrects itself.
 */
const SETTINGS_TTL = 10_000;

/**
 * Per-isolate cache. One deployment per isolate, so one slot; module scope survives
 * across requests in the same isolate, which is exactly the lifetime wanted here.
 */
let cached: { at: number; value: DeploymentSettings } | null = null;

/** The one directory object, by the name every other caller uses. */
function directoryStub(env: Env) {
  return env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));
}

/**
 * The deployment's settings, cached for `SETTINGS_TTL`.
 *
 * Use this everywhere a ceiling or a default is needed. Throws
 * `SettingsIncompleteError` while any field is unset — an incomplete document is never
 * cached, so the request after the owner fills it in is served. A directory that
 * cannot be reached keeps the last complete copy this isolate read, if it has one;
 * with none, the error goes to the caller, because there is nothing else to serve.
 */
export async function deploymentSettings(env: Env): Promise<DeploymentSettings> {
  const now = Date.now();
  if (cached && now - cached.at < SETTINGS_TTL) return cached.value;
  let stored: StoredSettings;
  try {
    stored = await directoryStub(env).storedSettings();
  } catch (err) {
    if (!cached) throw err;
    cached = { at: now, value: cached.value };
    return cached.value;
  }
  const value = completeSettings(stored);
  cached = { at: now, value };
  return value;
}

/**
 * Drop the cached copy, so the next read goes to the directory.
 *
 * Called by the write route: the owner who just changed a limit is the one caller who
 * should never see the old value, and it costs one read.
 */
export function forgetCachedSettings(): void {
  cached = null;
}

const SVG_DATA_URL = "data:image/svg+xml;base64,";

/**
 * An MCP template's icon, as the one form it is stored and served in: an SVG data URL.
 *
 * Raw `<svg>` markup is taken too and encoded here, so a caller can send the file as
 * it is. Nothing but SVG is accepted. The page draws it with `<img>`, which runs no
 * script an SVG carries — so the markup is never checked for any, only for being SVG.
 */
export function svgIcon(value: unknown, name: string): string {
  if (typeof value !== "string") throw new SettingsError(`${name} must be an SVG`);
  const raw = value.trim();
  let markup: string;
  if (raw.startsWith(SVG_DATA_URL)) {
    try {
      const binary = atob(raw.slice(SVG_DATA_URL.length));
      markup = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    } catch {
      throw new SettingsError(`${name} is not valid base64`);
    }
  } else {
    markup = raw;
  }
  if (!/<svg[\s>]/i.test(markup)) throw new SettingsError(`${name} must be an SVG`);
  const bytes = new TextEncoder().encode(markup);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return SVG_DATA_URL + btoa(binary);
}

/** Refuse an icon past the deployment's `max_icon_bytes`, counted as SVG bytes. */
export function checkIconSize(icon: string, max: number, name: string): void {
  const size = atob(icon.slice(SVG_DATA_URL.length)).length;
  if (size > max) throw new SettingsError(`${name} icon is ${size} bytes; the most is ${max}`);
}
