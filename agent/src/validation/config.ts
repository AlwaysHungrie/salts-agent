import { CAPABILITIES, type CapabilityField, SECRET_MASK } from "../capabilities";
import type { Config } from "../registry";

export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;

/**
 * An OpenRouter model id shape (`vendor/model` with optional `:variant`); deliberately
 * not a catalogue, so meta settings can name any model.
 */
export const MODEL_ID = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Every capability toggle, and every credential field any capability declares. */
export const CAPABILITY_FLAGS = CAPABILITIES.map((c) => c.flag);
export const CAPABILITY_FIELDS: CapabilityField[] = CAPABILITIES.flatMap((c) => c.fields);

/**
 * Secrets outside any capability, masked and handled like capability credentials. Listed
 * separately because `redact` only walks `CAPABILITY_FIELDS`.
 */
export const CORE_SECRETS = ["openrouter_api_key"] as const satisfies readonly (keyof Config)[];

/** Maximum length of each owner's note; both are resent every turn. */
export const MAX_NOTES = 64_000;
/**
 * Check and clamp a config patch before it reaches an OpenRouter request. Only keys
 * present are returned, so a PATCH stays partial.
 */
export function validateConfig(body: Partial<Config>): Partial<Config> {
  const patch: Partial<Config> = {};

  if (body.model !== undefined) {
    // Only the shape is checked here; which ids an agent may use is enforced with its meta.
    if (typeof body.model !== "string" || !MODEL_ID.test(body.model.trim())) {
      throw new Error(`not an OpenRouter model id: ${String(body.model)}`);
    }
    patch.model = body.model.trim();
  }
  if (body.system_prompt !== undefined) {
    if (typeof body.system_prompt !== "string") throw new Error("system_prompt must be a string");
    patch.system_prompt = body.system_prompt.slice(0, 4000);
  }
  for (const key of ["private_notes", "public_notes"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") throw new Error(`${key} must be a string`);
    patch[key] = body[key].slice(0, MAX_NOTES);
  }
  if (body.temperature !== undefined) {
    if (!Number.isFinite(body.temperature)) throw new Error("temperature must be a number");
    patch.temperature = clamp(body.temperature, 0, 2);
  }
  if (body.max_tokens !== undefined) {
    if (!Number.isFinite(body.max_tokens)) throw new Error("max_tokens must be a number");
    patch.max_tokens = Math.round(clamp(body.max_tokens, 0, 32000));
  }
  if (body.reasoning_effort !== undefined) {
    if (!REASONING_EFFORTS.includes(body.reasoning_effort)) {
      throw new Error(`unknown reasoning effort: ${body.reasoning_effort}`);
    }
    patch.reasoning_effort = body.reasoning_effort;
  }
  if (body.context_messages !== undefined) {
    if (!Number.isFinite(body.context_messages))
      throw new Error("context_messages must be a number");
    patch.context_messages = Math.round(clamp(body.context_messages, 0, 200));
  }

  for (const key of CORE_SECRETS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    if (value === SECRET_MASK) continue;
    patch[key] = value.trim().slice(0, 1000);
  }

  for (const flag of CAPABILITY_FLAGS) {
    if (body[flag] !== undefined) (patch[flag] as number) = body[flag] ? 1 : 0;
  }

  for (const field of CAPABILITY_FIELDS) {
    const value = body[field.key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${field.key} must be a string`);
    // The mask is what a secret reads back as, so it means "leave this one alone".
    if (field.secret && value === SECRET_MASK) continue;
    let cleaned = value.trim();
    // Accept a leading @ but store the handle bare.
    if (field.key === "telegram_bot_username") cleaned = cleaned.replace(/^@+/, "");
    // A list holds many entries, so it gets more room than a single credential.
    (patch[field.key] as string) = cleaned.slice(0, field.list ? 8000 : 1000);
  }

  return patch;
}

/** Config as the browser may see it: secrets become a mask, never the key itself. */
export function redact(config: Config): Config {
  const safe = { ...config };
  for (const key of CORE_SECRETS) {
    safe[key] = String(config[key] ?? "") ? SECRET_MASK : "";
  }
  for (const field of CAPABILITY_FIELDS) {
    if (!field.secret) continue;
    (safe[field.key] as string) = String(config[field.key] ?? "") ? SECRET_MASK : "";
  }
  return safe;
}
