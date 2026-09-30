import { CAPABILITIES, CAPABILITY_BY_ID, type CapabilityId, SECRET_MASK } from "../capabilities";
import { parseHeaders } from "../mcp";
import {
  type Config,
  DEFAULT_META,
  type McpCatalogEntry,
  type MetaCapability,
  METADATA_KEY,
  type MetaMcpServer,
  type MetaSettings,
  type MetaTunableKey,
} from "../registry";
import { checkIconSize, type DeploymentSettings, svgIcon } from "../settings";
import { CAPABILITY_FIELDS, CORE_SECRETS, MODEL_ID, validateConfig } from "./config";
import { validateMcpBody } from "./mcp";

/** The tuning settings a meta default may be given for. */
export const META_TUNABLES = [
  "model",
  "system_prompt",
  "temperature",
  "max_tokens",
  "reasoning_effort",
  "context_messages",
  "openrouter_api_key",
] as const satisfies readonly MetaTunableKey[];

/**
 * What a lock may name: a tuning column, or a capability. Locking a capability locks
 * its switch and every field it declares, because half a locked capability — a switch
 * nobody may flip over credentials anybody may rewrite — is not a useful thing.
 */
export const LOCKABLE = new Set<string>([...META_TUNABLES, ...CAPABILITIES.map((c) => c.id)]);

/** The config columns a lock covers. A capability's lock covers its whole section. */
export function lockedColumns(locked: string[]): Set<string> {
  const columns = new Set<string>();
  for (const key of locked) {
    const capability = CAPABILITY_BY_ID.get(key as CapabilityId);
    if (capability) {
      columns.add(String(capability.flag));
      for (const field of capability.fields) columns.add(String(field.key));
    } else {
      columns.add(key);
    }
  }
  return columns;
}

/** Config columns a capability owns: its switch, plus every field it declares. */
export const CAPABILITY_FIELD_KEYS = new Set<string>(CAPABILITY_FIELDS.map((f) => String(f.key)));

/** A spend ceiling in dollars, 0 for none. Refused rather than rounded to 0 by accident. */
function spendLimit(value: unknown): number {
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error("monthly_spend_limit must be a positive number of dollars, or 0 for none");
  }
  return Math.round(usd * 100) / 100;
}

/** A ceiling on the access list, 0 for none, at most the deployment's `max_members`. */
function memberLimit(value: unknown, settings: DeploymentSettings): number {
  const members = Number(value);
  if (!Number.isInteger(members) || members < 0 || members > settings.max_members) {
    throw new Error(`member_limit must be a whole number from 0 to ${settings.max_members}`);
  }
  return members;
}

/**
 * The models the agent may be switched between. Bare ids are still accepted, from
 * before each model carried a vision flag.
 */
function models(value: unknown): MetaSettings["models"] {
  if (!Array.isArray(value)) throw new Error("models must be an array");
  const out: MetaSettings["models"] = [];
  const seen = new Set<string>();
  for (const entry of value as (string | { id?: unknown; vision?: unknown })[]) {
    const id = (typeof entry === "string" ? entry : String(entry?.id ?? "")).trim();
    if (id === "" || seen.has(id)) continue;
    if (!MODEL_ID.test(id)) throw new Error(`not an OpenRouter model id: ${id}`);
    seen.add(id);
    const vision = typeof entry === "string" || entry.vision === undefined ? true : !!entry.vision;
    out.push({ id, vision });
  }
  return out;
}

/** Replacement menus for fixed-choice fields, each a list of model ids. */
function fieldOptions(value: unknown): MetaSettings["field_options"] {
  if (typeof value !== "object" || value === null) {
    throw new Error("field_options must be an object");
  }
  const out: MetaSettings["field_options"] = {};
  for (const [key, values] of Object.entries(value)) {
    const field = CAPABILITY_FIELDS.find((f) => String(f.key) === key);
    if (!field?.options) throw new Error(`not a choice field: ${key}`);
    if (!Array.isArray(values)) throw new Error(`${key} options must be an array`);
    const cleaned = values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    for (const id of cleaned) {
      if (!MODEL_ID.test(id)) throw new Error(`not an OpenRouter model id: ${id}`);
    }
    out[key] = [...new Set(cleaned)];
  }
  return out;
}

/**
 * Tuning defaults, checked by `validateConfig` so a default is never a value the
 * settings page would refuse. The secret mask keeps the stored value.
 */
function defaults(value: unknown, previous: MetaSettings): MetaSettings["defaults"] {
  if (typeof value !== "object" || value === null) throw new Error("defaults must be an object");
  const given = value as Partial<Record<MetaTunableKey, unknown>>;
  const wanted: Partial<Config> = {};
  for (const key of META_TUNABLES) {
    const entry = given[key];
    if (entry === undefined) continue;
    if (entry === SECRET_MASK) {
      const kept = previous.defaults[key];
      if (kept !== undefined) (wanted[key] as unknown) = kept;
      continue;
    }
    (wanted[key] as unknown) = entry;
  }
  return validateConfig(wanted) as MetaSettings["defaults"];
}

/** The tuning columns and capabilities the agent's own pages may not change. */
function locked(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("locked must be an array");
  const keys = value.filter((k): k is string => typeof k === "string");
  for (const key of keys) {
    if (!LOCKABLE.has(key)) throw new Error(`cannot lock: ${key}`);
  }
  return [...new Set(keys)];
}

/** Per-capability seed values: its switch and its fields. The secret mask keeps the stored value. */
function capabilities(value: unknown, previous: MetaSettings): MetaSettings["capabilities"] {
  if (typeof value !== "object" || value === null) {
    throw new Error("capabilities must be an object");
  }
  const out: MetaSettings["capabilities"] = {};
  for (const [id, entry] of Object.entries(value as Record<string, MetaCapability | null>)) {
    if (!CAPABILITY_BY_ID.get(id as CapabilityId)) throw new Error(`unknown capability: ${id}`);
    if (!entry || typeof entry !== "object") continue;
    const kept: MetaCapability = {};
    if (entry.enabled !== undefined) kept.enabled = !!entry.enabled;
    if (entry.fields && typeof entry.fields === "object") {
      const fields: Record<string, string> = {};
      for (const [key, field] of Object.entries(entry.fields)) {
        if (!CAPABILITY_FIELD_KEYS.has(key)) throw new Error(`unknown field: ${key}`);
        if (typeof field !== "string") throw new Error(`${key} must be a string`);
        const declared = CAPABILITY_FIELDS.find((f) => String(f.key) === key);
        if (declared?.secret && field === SECRET_MASK) {
          const stored = previous.capabilities[id]?.fields?.[key];
          if (stored !== undefined) fields[key] = stored;
          continue;
        }
        fields[key] = field.slice(0, 8000);
      }
      kept.fields = fields;
    }
    out[id] = kept;
  }
  return out;
}

/** The MCP part: offered templates, the agent's own catalogue, seed servers, and the switch. */
function mcp(value: unknown, settings: DeploymentSettings): MetaSettings["mcp"] {
  if (typeof value !== "object" || value === null) throw new Error("mcp must be an object");
  const given = value as Partial<Record<keyof MetaSettings["mcp"], unknown>>;
  const out: MetaSettings["mcp"] = {
    templates: [],
    catalog: [],
    servers: [],
    user_servers: DEFAULT_META.mcp.user_servers,
  };
  if (given.templates !== undefined) {
    if (!Array.isArray(given.templates)) throw new Error("mcp.templates must be an array");
    out.templates = [...new Set(given.templates.filter((t): t is string => typeof t === "string"))];
  }
  if (given.catalog !== undefined) {
    if (!Array.isArray(given.catalog)) throw new Error("mcp.catalog must be an array");
    out.catalog = given.catalog.map((entry) => {
      const valid = validateCatalogEntry(entry);
      if (valid.icon)
        checkIconSize(valid.icon, settings.max_icon_bytes, `MCP template ${valid.id}`);
      return valid;
    });
  }
  if (given.user_servers !== undefined) out.user_servers = !!given.user_servers;
  if (given.servers !== undefined) {
    if (!Array.isArray(given.servers)) throw new Error("mcp.servers must be an array");
    out.servers = given.servers.map((server) => {
      const checked = validateMcpBody({ ...server } as Record<string, unknown>);
      if (!checked.name || !checked.url) throw new Error("each MCP server needs a name and URL");
      return {
        name: checked.name,
        url: checked.url,
        auth: (checked.auth ?? "none") as MetaMcpServer["auth"],
        headers: parseHeaders(checked.headers ?? ""),
      };
    });
  }
  return out;
}

/**
 * Meta settings as they may be stored: a whole document, each part checked the way a
 * config PATCH is. A part left out of `body` comes back empty.
 *
 * `defaults`, `capabilities` and `mcp.servers` seed the agent at creation only; after
 * that the previous values are kept as the record of how it started.
 */
export function validateMeta(
  body: Partial<MetaSettings>,
  previous: MetaSettings,
  { creation, settings }: { creation: boolean; settings: DeploymentSettings }
): MetaSettings {
  // Checked in this order, so the first error reported stays the same.
  const spend =
    body.monthly_spend_limit !== undefined
      ? spendLimit(body.monthly_spend_limit)
      : DEFAULT_META.monthly_spend_limit;
  const members =
    body.member_limit !== undefined
      ? memberLimit(body.member_limit, settings)
      : DEFAULT_META.member_limit;
  const modelList = body.models !== undefined ? models(body.models) : [];
  const options = body.field_options !== undefined ? fieldOptions(body.field_options) : {};
  const seeds = body.defaults !== undefined ? defaults(body.defaults, previous) : {};
  const locks = body.locked !== undefined ? locked(body.locked) : [];
  const seeded = body.capabilities !== undefined ? capabilities(body.capabilities, previous) : {};
  const servers =
    body.mcp !== undefined
      ? mcp(body.mcp, settings)
      : { templates: [], catalog: [], servers: [], user_servers: DEFAULT_META.mcp.user_servers };

  const meta: MetaSettings = {
    models: modelList,
    defaults: seeds,
    locked: locks,
    capabilities: seeded,
    field_options: options,
    mcp: servers,
    monthly_spend_limit: spend,
    member_limit: members,
  };
  if (!creation) {
    meta.defaults = previous.defaults;
    meta.mcp.servers = previous.mcp.servers;
    meta.capabilities = previous.capabilities;
  }
  return meta;
}

/**
 * One provisioned template, checked before it is stored.
 *
 * Every field is rendered on a page the agent's own owner opens, so a bad entry is a
 * broken tile rather than a bad request — hence the refusal here rather than a filter.
 * `url` is parsed because the tile turns it into a server; `auth` is checked against
 * the three this Worker can actually connect with.
 */
export function validateCatalogEntry(entry: unknown): McpCatalogEntry {
  if (typeof entry !== "object" || entry === null)
    throw new Error("each MCP template must be an object");
  const raw = entry as Record<string, unknown>;
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`each MCP template needs a ${key}`);
    return value.trim();
  };
  const url = text("url");
  try {
    new URL(url);
  } catch {
    throw new Error(`MCP template ${text("id")} has an invalid URL`);
  }
  const auth = raw.auth ?? "none";
  if (auth !== "none" && auth !== "headers" && auth !== "oauth") {
    throw new Error("an MCP template's auth must be none, headers or oauth");
  }
  const optional = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    id: text("id"),
    name: text("name"),
    url,
    auth,
    icon: raw.icon === undefined ? undefined : svgIcon(raw.icon, `MCP template ${text("id")} icon`),
    letter: optional("letter"),
    color: optional("color"),
  };
}

/** Meta settings as the browser may see them: every secret becomes a mask. */
export function redactMeta(meta: MetaSettings): MetaSettings {
  const defaults = { ...meta.defaults };
  for (const key of CORE_SECRETS) {
    if (defaults[key] !== undefined) (defaults[key] as string) = SECRET_MASK;
  }
  const capabilities: MetaSettings["capabilities"] = {};
  for (const [id, entry] of Object.entries(meta.capabilities)) {
    const fields: Record<string, string> = { ...(entry.fields ?? {}) };
    for (const field of CAPABILITY_FIELDS) {
      const key = String(field.key);
      if (field.secret && fields[key] !== undefined) fields[key] = SECRET_MASK;
    }
    capabilities[id] = { ...entry, ...(entry.fields ? { fields } : {}) };
  }
  return { ...meta, defaults, capabilities };
}

/** Tags an app attaches at creation: at most 10, plain keys, short string values. */
export function validateMetadata(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("metadata must be an object");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 10) throw new Error("metadata may have at most 10 keys");
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!METADATA_KEY.test(key))
      throw new Error(`metadata key "${key}" must match ${METADATA_KEY}`);
    if (typeof value !== "string" || value.length > 100) {
      throw new Error(`metadata "${key}" must be a string of at most 100 characters`);
    }
    out[key] = value;
  }
  return out;
}
