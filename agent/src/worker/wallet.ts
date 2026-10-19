import type { Env } from "../env";
import type { Config } from "../registry";
import { ApiError } from "./http";
import { directory, type Registry } from "./stores";

/** A key's credit as OpenRouter reports it, in dollars. Null: no limit, or not reported. */
export type KeyCredit = {
  ok: boolean;
  limit: number | null;
  usage: number | null;
  remaining: number | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Ask OpenRouter what a key may still spend. Best effort: a failure reads as `ok: false`. */
export async function keyCredit(secret: string): Promise<KeyCredit> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return { ok: false, limit: null, usage: null, remaining: null };
    const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
    return {
      ok: true,
      limit: num(data.limit),
      usage: num(data.usage),
      remaining: num(data.limit_remaining),
    };
  } catch {
    return { ok: false, limit: null, usage: null, remaining: null };
  }
}

/**
 * Turn a wallet reference in a settings patch into the key it names, from `owner`'s
 * wallet only. A pasted key clears the reference; a blank reference with no pasted key
 * clears the key.
 *
 * `defaults` is for meta defaults being applied: there a blank or vanished reference
 * leaves the agent's key alone rather than refusing or clearing it.
 */
export async function withWalletKey(
  env: Env,
  owner: string,
  patch: Partial<Config>,
  defaults = false
): Promise<Partial<Config>> {
  const id = patch.openrouter_key_id;
  if (id === undefined) {
    return patch.openrouter_api_key === undefined ? patch : { ...patch, openrouter_key_id: "" };
  }
  const key = id && owner ? await directory(env).walletKey(owner, id) : undefined;
  if (key) return { ...patch, openrouter_api_key: key.secret };
  if (defaults) {
    // A removed key is not swapped for an older pasted default either.
    const { openrouter_key_id: _id, ...rest } = patch;
    if (id) delete rest.openrouter_api_key;
    return rest;
  }
  if (id) throw new ApiError(400, "That key is not in your OpenRouter wallet.");
  return patch.openrouter_api_key === undefined ? { ...patch, openrouter_api_key: "" } : patch;
}

/** After a write: record which wallet key the agent now holds, if the patch changed it. */
export async function noteWalletUse(env: Env, agentId: string, patch: Partial<Config>) {
  if (patch.openrouter_key_id === undefined) return;
  await directory(env).setWalletKeyUse(agentId, patch.openrouter_key_id);
}

/** The agent's admin: whose wallet its meta defaults name keys from. */
export async function adminOf(reg: Registry): Promise<string> {
  return (await reg.access()).admin_email;
}
