import type { Env } from "../env";
import { clerkEmail } from "../clerk";
import { type AccessRow, type AgentRow, emailAllowed, splitEmails } from "../registry";
import { API_SECRET_HEADER, USER_EMAIL_HEADER } from "./http";
import { directory, registry } from "./stores";

/**
 * Whether the request carries `API_SECRET`. An unset secret is always false, so a
 * missing secret closes the back door rather than opening it.
 */
export function trustedCaller(request: Request, env: Env): boolean {
  if (!env.API_SECRET) return false;
  return request.headers.get(API_SECRET_HEADER) === env.API_SECRET;
}

/**
 * Required configuration: `CLERK_ISSUER`, without which no ordinary caller can be
 * identified. `API_SECRET` is optional (no back door). Checked per request so the
 * error says what is missing rather than a module-load 1101.
 */
export function unconfigured(env: Env): string[] {
  const missing: string[] = [];
  if (!env.CLERK_ISSUER) missing.push("CLERK_ISSUER");
  return missing;
}

/**
 * The caller's address, or "" (which matches no access list). A verified Clerk token wins;
 * `x-user-email` is only trusted alongside `API_SECRET`.
 */
export async function callerEmail(request: Request, env: Env): Promise<string> {
  const verified = await clerkEmail(request, env);
  if (verified) return verified;
  // The back door: closed unless `API_SECRET` is set and presented.
  if (!trustedCaller(request, env)) return "";
  return (request.headers.get(USER_EMAIL_HEADER) ?? "").trim().toLowerCase();
}

/**
 * The agent's access list and admin from its own registry, the authority for every access
 * decision (the directory is only an index, and one object for the whole deployment).
 * An agent that predates this is seeded from the directory once. Undefined if no agent.
 */
export async function agentAccess(
  env: Env,
  agentId: string,
  known?: AgentRow
): Promise<AccessRow | undefined> {
  const reg = registry(env, agentId);
  const access = await reg.access();
  if (access.seeded) return access;
  // Unseeded means "not yet asked", not "nobody"; seed it rather than lock everyone out.
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
 * Whether a guest may reach this session route: the session's owner, on a conversational
 * route only (never files, tasks, reset, export, fork); on `/api/sessions/:id`, only delete.
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

/** Whether the caller may use `agentId`: membership only. The admin is not consulted. */

export async function mayUseAgent(request: Request, env: Env, agentId: string): Promise<boolean> {
  const email = await callerEmail(request, env);
  if (!email) return false;
  const access = await agentAccess(env, agentId);
  return !!access && emailAllowed(access.allowed_emails, email);
}
