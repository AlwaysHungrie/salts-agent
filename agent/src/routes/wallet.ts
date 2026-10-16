import type { Env } from "../env";
import type { WalletKeyRow } from "../registry";
import { deploymentSettings } from "../settings";
import { callerEmail } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { checkOpenrouterKey } from "../worker/integrations";
import { directory, registry, writeConfig } from "../worker/stores";
import { keyCredit } from "../worker/wallet";

/** Buying is not wired to a payment provider yet; both purchase routes say so. */
const NOT_YET = "Buying keys isn't available yet.";

/**
 * A key as its owner sees it: a pasted key in full (it is theirs), a provisioned one
 * never — it may only be spent through an agent.
 */
async function view(row: WalletKeyRow) {
  const credit = await keyCredit(row.secret);
  return {
    id: row.id,
    nickname: row.nickname,
    kind: row.kind,
    created_at: row.created_at,
    agents: row.agents,
    key: row.kind === "own" ? row.secret : null,
    valid: credit.ok,
    limit: credit.limit,
    usage: credit.usage,
    remaining: credit.remaining,
  };
}

/** A dollar amount to buy: positive, at most two decimals' worth. */
function amountOf(value: unknown): number | undefined {
  const usd = Number(value);
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) / 100 : undefined;
}

/** Everything under `/api/wallet`: the signed-in caller's own OpenRouter keys. */
export async function handleWallet(
  request: Request,
  env: Env,
  segments: string[]
): Promise<Response | undefined> {
  const email = await callerEmail(request, env);
  if (!email) return jsonError("unauthorized", 401);
  const dir = directory(env);
  const [, , id, action] = segments;
  const method = request.method;

  if (!id) {
    if (method === "GET") {
      const settings = await deploymentSettings(env);
      const keys = await Promise.all((await dir.walletKeys(email)).map(view));
      return json({ keys, max: settings.max_wallet_keys });
    }
    if (method === "POST") return await addKey(request, env, email);
    return undefined;
  }

  if (id === "purchases" && !action && method === "POST") {
    const body = await readJson<{ amount?: number }>(request);
    if (!amountOf(body.amount)) return jsonError("Choose an amount to buy.", 400);
    return jsonError(NOT_YET, 501);
  }

  const key = await dir.walletKey(email, id);
  if (!key) return jsonError("not found", 404);

  if (!action && method === "DELETE") {
    const agents = (await dir.removeWalletKey(email, id)) ?? [];
    // Every agent that held the key loses it now, not on its next save.
    for (const agentId of agents) {
      await writeConfig(env, registry(env, agentId), {
        openrouter_api_key: "",
        openrouter_key_id: "",
      });
    }
    return json({ removed: id, agents: agents.length });
  }

  if (action === "credits" && method === "POST") {
    if (key.kind !== "provisioned") {
      return jsonError("Credits can only be added to a key bought here.", 400);
    }
    const body = await readJson<{ amount?: number }>(request);
    if (!amountOf(body.amount)) return jsonError("Choose an amount to add.", 400);
    return jsonError(NOT_YET, 501);
  }
  return undefined;
}

/** Add a pasted key, checked with OpenRouter first so a typo is refused now. */
async function addKey(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ key?: string }>(request);
  const secret = (body.key ?? "").trim().slice(0, 1000);
  if (!secret) return jsonError("Paste an OpenRouter API key.", 400);
  const checked = await checkOpenrouterKey(secret);
  if (!checked.ok) return jsonError(checked.error ?? "Key was rejected by OpenRouter", 400);

  const settings = await deploymentSettings(env);
  const added = await directory(env).addWalletKey(
    email,
    { kind: "own", secret },
    settings.max_wallet_keys
  );
  if ("error" in added) return jsonError(added.error, 400);
  return json(await view(added));
}
