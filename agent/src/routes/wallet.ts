import type { Env } from "../env";
import type { WalletKeyRow } from "../registry";
import { deploymentSettings } from "../settings";
import { callerEmail } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { checkOpenrouterKey } from "../worker/integrations";
import { directory, registry, writeConfig } from "../worker/stores";
import {
  enabledNetworks,
  PAY_NETWORKS,
  type PayAsset,
  PaymentError,
  payAddress,
  payerAddress,
  QUOTE_TTL_MS,
  quoteUnits,
  txId,
  verifyPayment,
} from "../payments";
import type { WalletPurchase } from "../registry";
import { keyCredit } from "../worker/wallet";

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

/** A dollar amount to buy: $1 to $10,000, at most two decimals' worth. */
function amountOf(value: unknown): number | undefined {
  const usd = Number(value);
  return Number.isFinite(usd) && usd >= 1 && usd <= 10_000 ? Math.round(usd * 100) / 100 : undefined;
}

/** A quote as the buyer's wallet needs it: what to send, where, on which chain. */
function quoteView(p: WalletPurchase) {
  const network = PAY_NETWORKS.find((n) => n.id === p.network);
  return {
    id: p.id,
    network: p.network,
    family: network?.family,
    chain_id: network?.chain_id,
    asset: p.asset,
    to: p.to_address,
    token: p.asset === "usdc" ? network?.usdc : null,
    decimals: p.asset === "usdc" ? 6 : 18,
    units: p.units,
    amount_usd: p.amount_usd,
    status: p.status,
    expires_at: p.expires_at,
  };
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
      // The networks a purchase can be paid on here; empty when payments are off.
      const networks = enabledNetworks(env).map(({ id, label, family, chain_id, eth }) => ({
        id,
        label,
        family,
        chain_id,
        assets: eth ? ["usdc", "eth"] : ["usdc"],
      }));
      return json({ keys, max: settings.max_wallet_keys, networks });
    }
    if (method === "POST") return await addKey(request, env, email);
    return undefined;
  }

  if (id === "purchases" && method === "POST") {
    if (!action) return await quote(request, env, email, "");
    if (segments[4] === "confirm" && !segments[5]) return await confirm(request, env, email, action);
    return undefined;
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
    return await quote(request, env, email, key.id);
  }
  return undefined;
}

/**
 * Quote a purchase: a new key (`keyId` blank) or credit for a bought one. The amount
 * asked for carries a little dust of its own, so the payment can only match this quote.
 */
async function quote(request: Request, env: Env, email: string, keyId: string): Promise<Response> {
  const body = await readJson<{ amount?: number; network?: string; asset?: string; payer?: string }>(
    request
  );
  const amount = amountOf(body.amount);
  if (!amount) return jsonError("Choose an amount from $1 to $10,000.", 400);
  const network = enabledNetworks(env).find((n) => n.id === body.network);
  if (!network) return jsonError("Payments on that network aren't available.", 400);
  const asset = body.asset as PayAsset;
  if (asset !== "usdc" && !(asset === "eth" && network.eth)) {
    return jsonError(`${network.label} payments take USDC${network.eth ? " or ETH" : ""}.`, 400);
  }
  const payer = payerAddress(network.family, body.payer);
  if (!payer) return jsonError("Connect a wallet first.", 400);

  const now = Date.now();
  for (let tries = 0; tries < 5; tries++) {
    let units: bigint;
    try {
      units = await quoteUnits(env, asset, amount);
    } catch (err) {
      if (err instanceof PaymentError) return jsonError(err.message, 502);
      throw err;
    }
    const made = await directory(env).createPurchase({
      email,
      key_id: keyId,
      amount_usd: amount,
      network: network.id,
      asset,
      to_address: payAddress(env, network),
      payer,
      units: units.toString(),
      created_at: now,
      expires_at: now + QUOTE_TTL_MS,
    });
    if (!("error" in made)) return json(quoteView(made));
  }
  return jsonError("Couldn't make a quote. Try again.", 503);
}

/**
 * Count a payment: read the transaction back from the chain and check it against the
 * quote. 202 while it is not final yet, for the browser to ask again.
 */
async function confirm(request: Request, env: Env, email: string, id: string): Promise<Response> {
  const dir = directory(env);
  const found = await dir.purchase(email, id);
  if (!found) return jsonError("not found", 404);
  const network = PAY_NETWORKS.find((n) => n.id === found.network);
  if (!network) return jsonError("not found", 404);
  const body = await readJson<{ tx?: string }>(request);
  const tx = txId(network.family, body.tx);
  if (!tx) return jsonError("That isn't a transaction id.", 400);
  if (found.status === "paid") {
    return found.tx === tx ? json({ status: "paid" }) : jsonError("This purchase is already paid.", 409);
  }

  // A payment counts once, however many quotes it might match.
  if (await dir.txCounted(tx)) return jsonError("That transaction has already been counted.", 409);

  let verdict;
  try {
    verdict = await verifyPayment(env, found, tx);
  } catch (err) {
    if (err instanceof PaymentError) return jsonError(err.message, 502);
    throw err;
  }
  if (verdict.status === "pending") return json(verdict, 202);
  if (verdict.status === "failed") return jsonError(verdict.reason, 400);
  if (!(await dir.markPurchasePaid(found.id, tx))) {
    return jsonError("That transaction has already been counted.", 409);
  }
  // Provisioning the key (or topping it up) from a paid purchase is not built yet.
  return json({ status: "paid" });
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
