import type { Env } from "../env";
import { forgetCachedSettings, missingSettings, SETTINGS_FIELDS } from "../settings";
import { callerEmail, trustedCaller } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { PAY_NETWORKS, payerAddress } from "../payments";
import { isProvisioningKey } from "../worker/provisioned-keys";
import { razorpayKeysWork } from "../razorpay";
import { twilioKeysWork } from "../twilio";
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
    "razorpay",
    "twilio",
    "whatsapp-signup",
  ];
  if (!known.includes(route)) return undefined;
  if (!trustedCaller(request, env)) return jsonError("unauthorized", 401);

  if (route === "business-account") return await setAgentLimit(request, env);
  if (route === "settings") return await handleSettings(request, env);
  if (route === "provisioning-key") return await handleProvisioningKey(request, env);
  if (route === "payments") return await handlePayments(request, env);
  if (route === "razorpay") return await handleRazorpay(request, env);
  if (route === "twilio") return await handleTwilio(request, env);
  if (route === "whatsapp-signup") return await handleWhatsappSignup(request, env);
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
 * project id (the browser's wallet modal), RPC URLs by network overriding the configured
 * ones (write-only: only hosts are shown, as a URL may carry an API key), and whether a provisioning key is set (set
 * through its own route, which checks it with OpenRouter). All but the key are public.
 * PATCH sets any of `evm`, `solana`, `reown_project_id`, `rpc: { [network]: url }`; a blank one switches it off.
 */
async function handlePayments(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  const view = async () => {
    const key = await dir.provisioningKey();
    return {
      ...(await dir.paymentAddresses()),
      reown_project_id: await dir.reownProjectId(),
      // Every network's RPC set here, by id ("" for the configured one); only the host,
      // as the URL may carry an API key.
      rpc: await (async () => {
        const set = await dir.paymentRpcs(PAY_NETWORKS.map((n) => n.id));
        return Object.fromEntries(PAY_NETWORKS.map((n) => [n.id, rpcHost(set[n.id] ?? "")]));
      })(),
      provisioning_key: { set: Boolean(key), hint: key ? key.slice(-4) : "" },
    };
  };
  if (request.method === "GET") return json(await view());
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = await readJson<{
    evm?: unknown;
    solana?: unknown;
    reown_project_id?: unknown;
    rpc?: Record<string, unknown>;
  }>(request);
  const given = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fields = (["evm", "solana", "reown_project_id", "rpc"] as const).filter((f) => body[f] !== undefined);
  if (!fields.length) return jsonError("Give evm, solana, reown_project_id or rpc.", 400);
  const rpcs = Object.entries(body.rpc && typeof body.rpc === "object" ? body.rpc : {}).map(
    ([id, url]) => [id, given(url)] as const
  );
  for (const [id, url] of rpcs) {
    if (!PAY_NETWORKS.some((n) => n.id === id)) return jsonError(`There is no network ${id}.`, 400);
    if (url && !rpcHost(url)) return jsonError("An RPC is an https:// URL.", 400);
  }
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
  for (const [id, url] of rpcs) await dir.setPaymentRpc(id, url.slice(0, 2000));
  return json(await view());
}

/**
 * Razorpay's credentials for card and UPI payments. The key id is public (the checkout
 * page carries it); the key secret and webhook secret are write-only, shown by their last
 * four characters. PATCH sets any of `key_id`, `key_secret`, `webhook_secret`; a blank one
 * removes it. Once a key id and secret are both set, Razorpay must accept them.
 */
async function handleRazorpay(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  const hidden = (v: string) => ({ set: Boolean(v), hint: v ? v.slice(-4) : "" });
  const view = async () => {
    const keys = await dir.razorpayKeys();
    return { key_id: keys.key_id, key_secret: hidden(keys.key_secret), webhook_secret: hidden(keys.webhook_secret) };
  };
  if (request.method === "GET") return json(await view());
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = await readJson<Record<string, unknown>>(request);
  const names = (["key_id", "key_secret", "webhook_secret"] as const).filter((f) => body[f] !== undefined);
  if (!names.length) return jsonError("Give key_id, key_secret or webhook_secret.", 400);
  const patch = Object.fromEntries(
    names.map((f) => [f, typeof body[f] === "string" ? body[f].trim().slice(0, 500) : ""])
  ) as Partial<Record<(typeof names)[number], string>>;
  if (patch.key_id && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(patch.key_id)) {
    return jsonError("A Razorpay key id starts rzp_test_ or rzp_live_.", 400);
  }
  const next = { ...(await dir.razorpayKeys()), ...patch };
  if ((patch.key_id || patch.key_secret) && next.key_id && next.key_secret && !(await razorpayKeysWork(next))) {
    return jsonError("Razorpay didn't accept that key id and secret together.", 400);
  }
  await dir.setRazorpayKeys(patch);
  return json(await view());
}

/**
 * Twilio's credentials, for buying Business Phone Numbers: the account SID (AC…) and an
 * API key (SK…) with its secret. The SIDs are shown; the secret is write-only, shown by
 * its last four characters. PATCH sets any of the three; a blank one removes it. Once all
 * three are set, Twilio must accept them together.
 */
async function handleTwilio(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  const view = async () => {
    const keys = await dir.twilioKeys();
    return {
      account_sid: keys.account_sid,
      api_key_sid: keys.api_key_sid,
      api_key_secret: { set: Boolean(keys.api_key_secret), hint: keys.api_key_secret.slice(-4) },
    };
  };
  if (request.method === "GET") return json(await view());
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = await readJson<Record<string, unknown>>(request);
  const names = (["account_sid", "api_key_sid", "api_key_secret"] as const).filter((f) => body[f] !== undefined);
  if (!names.length) return jsonError("Give account_sid, api_key_sid or api_key_secret.", 400);
  const patch = Object.fromEntries(
    names.map((f) => [f, typeof body[f] === "string" ? body[f].trim().slice(0, 200) : ""])
  ) as Partial<Record<(typeof names)[number], string>>;
  if (patch.account_sid && !/^AC[0-9a-f]{32}$/.test(patch.account_sid)) {
    return jsonError("A Twilio account SID is AC followed by 32 hex characters.", 400);
  }
  // The account SID works here too, with the account's auth token as the secret.
  if (patch.api_key_sid && !/^(SK|AC)[0-9a-f]{32}$/.test(patch.api_key_sid)) {
    return jsonError("A Twilio API key SID is SK (or the account SID, AC) followed by 32 hex characters.", 400);
  }
  const next = { ...(await dir.twilioKeys()), ...patch };
  if (next.account_sid && next.api_key_sid && next.api_key_secret && !(await twilioKeysWork(next))) {
    return jsonError("Twilio didn't accept that account SID and API key together.", 400);
  }
  await dir.setTwilioKeys(patch);
  return json(await view());
}

/**
 * Meta's Embedded Signup ids, which the WhatsApp for Business card opens signup with: the
 * Meta app, its Facebook Login for Business configuration, and Twilio's Partner Solution.
 * None is secret. PATCH sets any of the three; a blank one removes it.
 */
async function handleWhatsappSignup(request: Request, env: Env): Promise<Response> {
  const dir = directory(env);
  if (request.method === "GET") return json(await dir.whatsappSignup());
  if (request.method !== "PATCH") return methodNotAllowed();
  const body = await readJson<Record<string, unknown>>(request);
  const names = (["app_id", "config_id", "solution_id"] as const).filter((f) => body[f] !== undefined);
  if (!names.length) return jsonError("Give app_id, config_id or solution_id.", 400);
  const patch: Partial<Record<(typeof names)[number], string>> = {};
  for (const f of names) {
    const value = typeof body[f] === "string" ? body[f].trim() : "";
    if (value && !/^\d{1,32}$/.test(value)) return jsonError(`${f} is digits only.`, 400);
    patch[f] = value;
  }
  await dir.setWhatsappSignup(patch);
  return json(await dir.whatsappSignup());
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
