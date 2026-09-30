import type { Env } from "../env";
import { clerkEmail } from "../clerk";
import { type AccessRow, type AgentRow, emailAllowed, splitEmails } from "../registry";
import { API_SECRET_HEADER, USER_EMAIL_HEADER } from "./http";
import { directory, registry } from "./stores";

/**
 * Whether a request carries the deployment's shared secret.
 *
 * An unset `API_SECRET` is false, never true. A missing secret closes the back door;
 * it does not prop it open. This is the one place that distinction is made, and
 * having it backwards would hand every identity in the deployment to anyone at all.
 */
export function trustedCaller(request: Request, env: Env): boolean {
  if (!env.API_SECRET) return false;
  return request.headers.get(API_SECRET_HEADER) === env.API_SECRET;
}

/**
 * What a deployment has to have been given before it is allowed to answer anything.
 *
 * `CLERK_ISSUER` is the one that matters. It is what lets the Worker verify a session
 * token, and a verified token is how every ordinary caller here becomes somebody.
 * Without it no signature can be checked, so no normal user can be identified at all,
 * and the only remaining way in is the `API_SECRET` back door — a deployment where
 * the sole working identity is the impersonation one. Worth refusing to start over.
 *
 * `API_SECRET` is deliberately *not* required. It is the back door, not the gate, and
 * a deployment without one simply has no back door — which is the safe direction to
 * fail in.
 *
 * Checked per request rather than at module load on purpose: a `throw` in the global
 * scope of a Worker surfaces as an opaque 1101, and the point of this gate is to say
 * exactly what is missing.
 */
export function unconfigured(env: Env): string[] {
  const missing: string[] = [];
  if (!env.CLERK_ISSUER) missing.push("CLERK_ISSUER");
  return missing;
}

/**
 * The signed-in address on whose behalf this call is made, or "" when nobody was
 * named. An empty address never matches an access list, so an agent's routes stay
 * closed unless the check is explicitly skipped.
 *
 * The Clerk token wins when there is one. Its signature was checked against Clerk's
 * own keys, so nothing between the browser and here could have changed the address in
 * it, and `clerkEmail` caches the result for the token's short life so this costs a
 * map lookup rather than a public-key operation on the calls that follow.
 *
 * `x-user-email` is the fallback, and it is only ever reached when there is no
 * verified token to prefer. It is trusted on the strength of `API_SECRET` alone —
 * see the note on the headers above for what that means and why it stays.
 */
export async function callerEmail(request: Request, env: Env): Promise<string> {
  const verified = await clerkEmail(request, env);
  if (verified) return verified;
  // The back door, and it opens for nobody without the secret. `trustedCaller` is
  // false when `API_SECRET` is unset, so a deployment that never configured one has
  // no second way in rather than an unguarded one.
  if (!trustedCaller(request, env)) return "";
  return (request.headers.get(USER_EMAIL_HEADER) ?? "").trim().toLowerCase();
}

/**
 * The agent's access list and admin, from the agent's own object.
 *
 * **The registry is authoritative for every access decision, always.** The directory
 * keeps a copy of the same list, but only as an index — it is what makes "the agents
 * this address may open" one query on the home page — and it never decides whether a
 * request is allowed. The two cannot be written in one transaction, because no
 * transaction spans two Durable Objects, so one of them has to be the truth and the
 * other has to be allowed to lag.
 *
 * Reading it here rather than from the directory is the entire point of the split:
 * this check runs on every message, every stream, every file, and `SessionRegistry`
 * is one object per agent, while the directory is one object for the deployment.
 *
 * Returns undefined when there is no such agent.
 *
 * The directory is still touched in one case: an agent created before access lived
 * in the registry has nothing there yet, and its list has to come from somewhere the
 * first time. That is a one-off per agent — `seedAccess` writes it down — so it costs
 * the directory one read per agent ever, not one per message.
 */
export async function agentAccess(
  env: Env,
  agentId: string,
  known?: AgentRow
): Promise<AccessRow | undefined> {
  const reg = registry(env, agentId);
  const access = await reg.access();
  if (access.seeded) return access;
  // Unseeded is not "nobody is allowed" — it is "nobody has asked yet". Reading it as
  // an empty list would turn this deployment into a lockout for every agent that
  // already exists, so the answer comes from the directory once and is then adopted.
  const row = known ?? (await directory(env).get(agentId));
  if (!row) return undefined;
  return await reg.seedAccess(row.allowed_emails, row.admin_email);
}

/**
 * Whether `email` is one of `agentId`'s guests: guests switched on, and either no
 * guest list — anyone signed in — or the address on it.
 */
export function isGuest(access: AccessRow, email: string): boolean {
  if (!email || !access.guests) return false;
  const list = splitEmails(access.guest_emails);
  return list.length === 0 || list.includes(email);
}

/** The session routes a guest may reach, and only on a session they started. */
export const GUEST_SESSION_ROUTES = new Set(["stream", "chat", "messages", "live", "summary"]);

/**
 * Whether the caller may reach this session route as a guest: a guest of its agent,
 * the session's owner, and a route that only converses — never files, tasks, reset,
 * export or fork. On `/api/sessions/:id` the one thing a guest may do is delete it.
 */
export async function mayUseSessionAsGuest(
  request: Request,
  env: Env,
  agentId: string,
  sessionId: string,
  segments: string[]
): Promise<boolean> {
  const route =
    segments[0] === "agents"
      ? GUEST_SESSION_ROUTES.has(segments[3] ?? "")
      : request.method === "DELETE" && !segments[3];
  if (!route) return false;
  const email = await callerEmail(request, env);
  const access = await agentAccess(env, agentId);
  if (!access || !isGuest(access, email)) return false;
  const session = await registry(env, agentId).get(sessionId);
  return !!session && session.owner_email === email;
}

/**
 * Whether the caller may *use* `agentId`: its chats, its files, its settings.
 *
 * The address has to be on the agent's list. Membership, and only membership: the
 * admin is deliberately not consulted, so an admin who never put their own address on
 * the list administers an agent they cannot open, which is the ordinary case now that
 * the two are separate.
 */

export async function mayUseAgent(request: Request, env: Env, agentId: string): Promise<boolean> {
  const email = await callerEmail(request, env);
  if (!email) return false;
  const access = await agentAccess(env, agentId);
  return !!access && emailAllowed(access.allowed_emails, email);
}
