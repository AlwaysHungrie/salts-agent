import type { Env } from "../env";
import { forgetCachedSettings, missingSettings, SETTINGS_FIELDS } from "../settings";
import { callerEmail, trustedCaller } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { payerAddress } from "../payments";
import { isProvisioningKey } from "../worker/provisioned-keys";
import { directory, syncSessionCount } from "../worker/stores";

const methodNotAllowed = () => jsonError("method not allowed", 405);

/** A numeric `?limit=`, falling back to 20. */
function limitParam(url: URL): number {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  return Number.isFinite(limit) ? limit : 20;
}

/**
 * Everything under `/api/admin`: the owner's routes, gated on `API_SECRET` alone (no
 * Clerk session) and matched before the identity gate.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const route = segments[2];
  const known = [
    "business-account",
    "settings",
    "business-requests",
    "stats",
    "users",
    "provisioning-key",
    "payments",
  ];
  if (!known.includes(route)) return undefined;
  if (!trustedCaller(request, env)) return jsonError("unauthorized", 401);

  if (route === "business-account") return await setAgentLimit(request, env);
  if (route === "settings") return await handleSettings(request, env);
  if (route === "provisioning-key") return await handleProvisioningKey(request, env);
  if (route === "payments") return await handlePayments(request, env);
  if (route === "business-requests")
    return await handleBusinessRequests(request, env, url, segments);
  if (route === "stats") {
    // Session counts are cached in the directory; this fills in agents that predate the cache.
    const dir = directory(env);
    for (const id of await dir.unmeasuredAgents()) await syncSessionCount(env, id);
    return json(await dir.counts());
  }
  return await handleUsers(request, env, url, segments);
}

/** Raise an account's agent ceiling: a business account is only a higher number. */
async function setAgentLimit(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const body = await readJson<{ email?: string; agent_limit?: number }>(request);
  const email = (body.email ?? "").trim().toLowerCase();
  const limit = Number(body.agent_limit);
  if (!email || !Number.isInteger(limit) || limit < 1) {
    return jsonError("email and a positive integer agent_limit are required", 400);
  }
  await directory(env).setAgentLimit(email, limit);
  return json({ email, agent_limit: limit });
}

/**
 * The deployment's settings. GET returns the document, missing fields and field
 * descriptors (the admin CLI keeps no copy). PATCH merges; every field is required.
 */
async function handleSettings(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  if (request.method === "GET") {
    const settings = await dir.storedSettings();
    return json({ settings, missing: missingSettings(settings), fields: SETTINGS_FIELDS });
  }
  if (request.method === "PATCH" || request.method === "POST") {
    const body = await request.json().catch(() => undefined);
    const saved = await dir.setSettings(body);
    if ("error" in saved) return jsonError(saved.error, 400);
    // The owner who just changed a value must not be served the cached copy.
    forgetCachedSettings();
    return json({ ...saved, fields: SETTINGS_FIELDS });
  }
  return methodNotAllowed();
}

/**
 * The OpenRouter provisioning key bought keys are made with. Write-only: GET says whether
 * one is set and its last four characters, never the key. PUT checks it with OpenRouter
 * first; DELETE removes it, which closes key purchases.
 */
async function handleProvisioningKey(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  const shown = (key: string) => ({ set: Boolean(key), hint: key ? key.slice(-4) : "" });
  if (request.method === "GET") return json(shown(await dir.provisioningKey()));
  if (request.method === "PUT") {
    const body = await readJson<{ key?: string }>(request);
    const key = (body.key ?? "").trim().slice(0, 1000);
    if (!key) return jsonError("Paste an OpenRouter provisioning key.", 400);
    if (!(await isProvisioningKey(key))) {
      return jsonError("OpenRouter didn't accept that as a provisioning key.", 400);
    }
    await dir.setProvisioningKey(key);
    return json(shown(key));
  }
  if (request.method === "DELETE") {
    await dir.setProvisioningKey("");
    return json(shown(""));
  }
  return methodNotAllowed();
}

/**
 * The payment settings, read together for the admin CLI's Payments tab: where purchases
 * are paid to (one EVM address for every EVM network, one Solana address), Reown's
 * project id (the browser's wallet modal), a Solana RPC URL overriding the configured one
 * (write-only: only its host is shown, as it may carry an API key), and whether a provisioning key is set (set
 * through its own route, which checks it with OpenRouter). All but the key are public.
 * PATCH sets any of `evm`, `solana`, `reown_project_id`, `solana_rpc`; a blank one switches it off.
 */
async function handlePayments(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  const view = async () => {
    const key = await dir.provisioningKey();
    return {
      ...(await dir.paymentAddresses()),
      reown_project_id: await dir.reownProjectId(),
      // Only the host: the URL may carry an API key.
      solana_rpc: rpcHost(await dir.solanaRpc()),
      provisioning_key: { set: Boolean(key), hint: key ? key.slice(-4) : "" },
    };
  };
  if (request.method === "GET") return json(await view());
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = await readJson<{
    evm?: unknown;
    solana?: unknown;
    reown_project_id?: unknown;
    solana_rpc?: unknown;
  }>(request);
  const given = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fields = (["evm", "solana", "reown_project_id", "solana_rpc"] as const).filter(
    (f) => body[f] !== undefined
  );
  if (!fields.length) return jsonError("Give evm, solana, reown_project_id or solana_rpc.", 400);
  const rpc = given(body.solana_rpc);
  if (rpc && !rpcHost(rpc)) return jsonError("A Solana RPC is an https:// URL.", 400);
  for (const family of ["evm", "solana"] as const) {
    const value = given(body[family]);
    // Kept as typed (an EVM checksum stays readable); compared lowercased.
    if (value && !payerAddress(family, value)) {
      return jsonError(`That isn't ${family === "evm" ? "an EVM" : "a Solana"} address.`, 400);
    }
  }
  const reown = given(body.reown_project_id);
  if (reown && !/^[0-9a-f]{32}$/i.test(reown)) {
    return jsonError("A Reown project id is 32 hex characters, from its dashboard.", 400);
  }
  for (const family of ["evm", "solana"] as const) {
    if (body[family] !== undefined) await dir.setPaymentAddress(family, given(body[family]));
  }
  if (body.reown_project_id !== undefined) await dir.setReownProjectId(reown);
  if (body.solana_rpc !== undefined) await dir.setSolanaRpc(rpc.slice(0, 2000));
  return json(await view());
}

/** An https URL's host, or "" for anything else. */
function rpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.host : "";
  } catch {
    return "";
  }
}

/** The owner's queue of requests for a higher agent ceiling. */
async function handleBusinessRequests(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response> {
  const dir = directory(env);
  const id = segments[3];
  if (!id) {
    if (request.method !== "GET") return methodNotAllowed();
    return json(
      await dir.listBusinessRequests(limitParam(url), url.searchParams.get("cursor") ?? "")
    );
  }
  if (segments[4] === "approve" && request.method === "POST") {
    const result = await dir.approveBusinessRequest(id);
    if (!result) return jsonError("no such request", 404);
    return json(result);
  }
  if (!segments[4] && request.method === "DELETE") {
    await dir.deleteBusinessRequest(id);
    return json({ ok: true });
  }
  return methodNotAllowed();
}

/** Every address the deployment knows, paged and searchable, or one address in detail. */
async function handleUsers(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const dir = directory(env);
  if (segments[3]) return json(await dir.userDetail(decodeURIComponent(segments[3])));
  return json(
    await dir.listUsers(
      limitParam(url),
      url.searchParams.get("cursor") ?? "",
      url.searchParams.get("q") ?? ""
    )
  );
}

/**
 * `POST /api/business-requests`: a signed-in account asking for a higher ceiling.
 * Anyone may file one; approving it is the owner's.
 */
export async function fileBusinessRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const email = await callerEmail(request, env);
  if (!email) return jsonError("sign in required", 401);
  const body = await readJson<{ increase?: number }>(request);
  const increase = Number(body.increase);
  if (!Number.isInteger(increase) || increase < 1) {
    return jsonError("a positive integer increase is required", 400);
  }
  return json(await directory(env).fileBusinessRequest(email, increase));
}
