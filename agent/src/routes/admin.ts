import type { Env } from "../env";
import { forgetCachedSettings, missingSettings, SETTINGS_FIELDS } from "../settings";
import { callerEmail, trustedCaller } from "../worker/auth";
import { json, jsonError, readJson } from "../worker/http";
import { directory, syncSessionCount } from "../worker/stores";

const methodNotAllowed = () => jsonError("method not allowed", 405);

/** A numeric `?limit=`, falling back to 20. */
function limitParam(url: URL): number {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  return Number.isFinite(limit) ? limit : 20;
}

/**
 * Everything under `/api/admin`: the deployment owner's routes, gated on `API_SECRET`
 * alone because the owner has no Clerk session. Matched before the identity gate.
 * Undefined when the path is not one of these.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const route = segments[2];
  const known = ["business-account", "settings", "business-requests", "stats", "users"];
  if (!known.includes(route)) return undefined;
  if (!trustedCaller(request, env)) return jsonError("unauthorized", 401);

  if (route === "business-account") return await setAgentLimit(request, env);
  if (route === "settings") return await handleSettings(request, env);
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
 * The deployment's settings. GET returns the stored document, the fields still missing
 * and the field descriptors, so the admin CLI holds no copy of any. PATCH merges; there
 * is no unset, because every field is required.
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
