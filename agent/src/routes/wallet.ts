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
import { createKey, deleteKey, ProvisioningError } from "../worker/provisioned-keys";
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

/** A dollar amount to buy: $1 to `max`, at most two decimals' worth. */
function amountOf(value: unknown, max: number): number | undefined {
  const usd = Number(value);
  return Number.isFinite(usd) && usd >= 1 && usd <= max ? Math.round(usd * 100) / 100 : undefined;
}

/** The service fee on `usd` of credit, in dollars: rounded up to the cent. */
function feeOf(usd: number, bps: number): number {
  return Math.ceil((Math.round(usd * 100) * bps) / 10_000) / 100;
}

/**
 * A quote as the buyer's wallet needs it: what to send, where, on which chain, and how
 * the total breaks down into credit and fee.
 */
function quoteView(p: WalletPurchase, fee: number) {
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
    fee_usd: fee,
    total_usd: Math.round((p.amount_usd + fee) * 100) / 100,
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
      // The networks a purchase can be paid on here; empty when payments are off, and
      // while no provisioning key is set, as nothing paid for could be delivered.
      const open = Boolean(await dir.provisioningKey());
      const addresses = await dir.paymentAddresses();
      const networks = (open ? enabledNetworks(env, addresses) : []).map(({ id, label, family, chain_id, usdc, eth }) => ({
        id,
        label,
        family,
        chain_id,
        usdc,
        assets: eth ? ["usdc", "eth"] : ["usdc"],
      }));
      return json({
        keys,
        max: settings.max_wallet_keys,
        fee_bps: settings.wallet_fee_bps,
        max_usd: settings.max_wallet_purchase_usd,
        networks,
      });
    }
    if (method === "POST") return await addKey(request, env, email);
    return undefined;
  }

  if (id === "purchases" && method === "POST") {
    if (!action) return await quote(request, env, email);
    if (segments[4] === "confirm" && !segments[5]) return await confirm(request, env, email, action);
    return undefined;
  }

  const key = await dir.walletKey(email, id);
  if (!key) return jsonError("not found", 404);

  if (!action && method === "DELETE") {
    const agents = (await dir.removeWalletKey(email, id)) ?? [];
    // A bought key stops working at OpenRouter too. Best effort: it is gone from here.
    const provisioning = key.openrouter_hash ? await dir.provisioningKey() : "";
    if (provisioning) await deleteKey(provisioning, key.openrouter_hash).catch(() => undefined);
    // Every agent that held the key loses it now, not on its next save.
    for (const agentId of agents) {
      await writeConfig(env, registry(env, agentId), {
        openrouter_api_key: "",
        openrouter_key_id: "",
      });
    }
    return json({ removed: id, agents: agents.length });
  }
  return undefined;
}

/**
 * Quote a new key. The amount asked for carries a little dust of its own, so the payment
 * can only match this quote.
 */
async function quote(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ amount?: number; network?: string; asset?: string; payer?: string }>(
    request
  );
  const settings = await deploymentSettings(env);
  const max = settings.max_wallet_purchase_usd;
  const amount = amountOf(body.amount, max);
  if (!amount) return jsonError(`Choose an amount from $1 to $${max}.`, 400);
  const dir = directory(env);
  if (!(await dir.provisioningKey())) return jsonError("Key purchases aren't open yet.", 503);
  // The key needs room in the wallet: once paid for, it is delivered regardless.
  if ((await dir.walletKeys(email)).length >= settings.max_wallet_keys) {
    return jsonError(`A wallet holds at most ${settings.max_wallet_keys} keys.`, 400);
  }
  const addresses = await dir.paymentAddresses();
  const network = enabledNetworks(env, addresses).find((n) => n.id === body.network);
  if (!network) return jsonError("Payments on that network aren't available.", 400);
  const asset = body.asset as PayAsset;
  if (asset !== "usdc" && !(asset === "eth" && network.eth)) {
    return jsonError(`${network.label} payments take USDC${network.eth ? " or ETH" : ""}.`, 400);
  }
  const payer = payerAddress(network.family, body.payer);
  if (!payer) return jsonError("Connect a wallet first.", 400);

  // The buyer pays the credit plus the service fee; the key gets the credit.
  const fee = feeOf(amount, settings.wallet_fee_bps);
  const total = Math.round((amount + fee) * 100) / 100;
  const now = Date.now();
  for (let tries = 0; tries < 5; tries++) {
    let units: bigint;
    try {
      units = await quoteUnits(env, asset, total);
    } catch (err) {
      if (err instanceof PaymentError) return jsonError(err.message, 502);
      throw err;
    }
    const made = await dir.createPurchase({
      email,
      key_id: "",
      amount_usd: amount,
      network: network.id,
      asset,
      to_address: payAddress(addresses, network),
      payer,
      units: units.toString(),
      created_at: now,
      expires_at: now + QUOTE_TTL_MS,
    });
    if (!("error" in made)) return json(quoteView(made, fee));
  }
  return jsonError("Couldn't make a quote. Try again.", 503);
}

/**
 * Count a payment, then deliver it: read the transaction back from the chain, check it
 * against the quote, and make the key (or add the credit). 202 while the chain is not
 * final, or the delivery is under way or failed, for the browser to ask again; a counted
 * payment is never lost, as the next confirm with the same transaction delivers it.
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
  if (found.status !== "pending") {
    return found.tx === tx ? await deliver(env, found) : jsonError("This purchase is already paid.", 409);
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
    // Another confirm with this transaction may have counted it a moment ago.
    const now = await dir.purchase(email, id);
    if (now?.tx !== tx) return jsonError("That transaction has already been counted.", 409);
  }
  const paid = await dir.purchase(email, id);
  return paid ? await deliver(env, paid) : jsonError("not found", 404);
}

const delivering = () => json({ status: "pending", reason: "Setting up your key." }, 202);

/**
 * Turn a paid purchase into its key, held to the credit bought. Held by one confirm at a
 * time, so it happens once. The key is named at OpenRouter by its buyer and purchase, so
 * the deployment's OpenRouter dashboard says whose each key is.
 */
async function deliver(env: Env, p: WalletPurchase): Promise<Response> {
  if (p.status === "fulfilled") return json({ status: "paid", key_id: p.key_id });
  const dir = directory(env);
  const provisioning = await dir.provisioningKey();
  if (!provisioning || !(await dir.claimPurchase(p.id))) return delivering();

  try {
    const made = await createKey(provisioning, `Salts ${p.email} ${p.id}`, p.amount_usd);
    const row = await dir.fulfilNewKey(p.id, made).catch(() => undefined);
    if (!row) {
      // Recorded nowhere, so it must not live on at OpenRouter.
      await deleteKey(provisioning, made.openrouter_hash).catch(() => undefined);
      throw new ProvisioningError("Couldn't record the key.");
    }
    return json({ status: "paid", key_id: row.id });
  } catch (err) {
    await dir.releasePurchase(p.id);
    if (err instanceof ProvisioningError) return delivering();
    throw err;
  }
}

/** Add a pasted key, checked with OpenRouter first so a typo is refused now. */
async function addKey(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<{ key?: string }>(request);
  const secret = (body.key ?? "").trim().slice(0, 1000);
  if (!secret) return jsonError("Paste an OpenRouter API key.", 400);
  const checked = await checkOpenrouterKey(secret);
  if (!checked.ok) return jsonError(checked.error ?? "Failed to validate this OpenRouter API key", 400);

  const settings = await deploymentSettings(env);
  const added = await directory(env).addWalletKey(
    email,
    { kind: "own", secret },
    settings.max_wallet_keys
  );
  if ("error" in added) return jsonError(added.error, 400);
  return json(await view(added));
}
