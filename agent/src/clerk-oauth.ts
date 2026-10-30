import { jwtVerify } from "jose";
import type { Env } from "./env";
import { issuerOf, jwks, tokenKey } from "./clerk";

/**
 * Clerk OAuth access tokens from trusted apps, as a narrow alternative to a Salts login.
 *
 * An app that signs its users in with this deployment's Clerk instance (OAuth, not a
 * Clerk session) can open their agents' sessions with the access token it was given,
 * rather than holding an agent API key. `clerkEmail` refuses these tokens, and they stay
 * refused everywhere but the session routes in `oauthRoute`: start, list and delete
 * sessions, talk in one, and read its transcript. A token is accepted only when:
 *
 *   a. it is signed by the issuer's keys, from `CLERK_ISSUER`, within its validity window,
 *   b. it has no `sid` (an OAuth access token, not a session token),
 *   c. its `aud` holds `OAUTH_RESOURCE` (RFC 8707), so a token Clerk issued for another
 *      resource (an MCP server that uses the same Clerk) is not one for this Worker,
 *   d. its `client_id` is one of `OAUTH_CLIENTS`, and
 *   e. the issuer's userinfo endpoint answers it with a verified email.
 *
 * Either variable unset turns this off. The address then goes through the agent's access
 * list like any signed-in caller's.
 */

type Entry = { email: string; until: number };
const verified = new Map<string, Entry>();
const MAX_ENTRIES = 500;
/** How long a verdict is reused: the delay before a revoked grant stops working here. */
const VERDICT_TTL = 60_000;

/** The session routes an OAuth caller may reach; everything else sees no caller. */
export function oauthRoute(request: Request): boolean {
  const [first, second, third, fourth, fifth] = new URL(request.url).pathname
    .split("/")
    .filter(Boolean);
  if (!third) return false;
  if (first === "api" && second === "agents") {
    return (
      fourth === "sessions" && !fifth && (request.method === "POST" || request.method === "GET")
    );
  }
  if (first === "api" && second === "sessions") return !fourth && request.method === "DELETE";
  if (first !== "agents" || second !== "session-agent") return false;
  if (fourth === "messages") return !fifth && request.method === "GET";
  return fourth === "stream" || fourth === "chat";
}

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

function prune(now: number) {
  for (const [key, entry] of verified) {
    if (entry.until <= now) verified.delete(key);
  }
  while (verified.size >= MAX_ENTRIES) {
    const oldest = verified.keys().next();
    if (oldest.done) break;
    verified.delete(oldest.value);
  }
}

/** The address a trusted app's OAuth access token stands for, or "". */
export async function oauthEmail(request: Request, env: Env): Promise<string> {
  const issuer = issuerOf(env);
  const resource = (env.OAUTH_RESOURCE ?? "").trim();
  const clients = listOf(env.OAUTH_CLIENTS);
  if (!issuer || !resource || !clients.length) return "";

  const token = /^bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  // Agent and fleet keys are not JWTs; don't spend a verification on them.
  if (!token || token.startsWith("salt_")) return "";

  const now = Date.now();
  const key = await tokenKey(token);
  const hit = verified.get(key);
  if (hit && hit.until > now) return hit.email;

  const remember = (email: string, until: number) => {
    prune(now);
    verified.set(key, { email, until });
    return email;
  };

  let exp: number | undefined;
  try {
    const { payload } = await jwtVerify(token, jwks(issuer), {
      issuer,
      audience: resource,
      clockTolerance: 30,
    });
    if (payload.sid !== undefined) throw new Error("a session token, not an access token");
    if (!clients.includes(String(payload.client_id ?? ""))) throw new Error("untrusted client");
    exp = payload.exp;
  } catch {
    return remember("", now + VERDICT_TTL);
  }
  const until = exp ? Math.min(exp * 1000, now + VERDICT_TTL) : now + VERDICT_TTL;

  // Clerk's access tokens name the user by id only; userinfo gives the address.
  // Issuer trouble is not the caller's fault: answer "" without remembering it.
  let info: { email?: string; email_verified?: boolean };
  try {
    const res = await fetch(`${issuer}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 500) return "";
    if (!res.ok) return remember("", until);
    info = (await res.json()) as typeof info;
  } catch {
    return "";
  }
  const email = info.email_verified === true ? (info.email ?? "").trim().toLowerCase() : "";
  return remember(email, until);
}
