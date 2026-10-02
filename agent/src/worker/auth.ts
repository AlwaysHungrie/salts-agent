import type { Env } from "../env";
import { clerkEmail } from "../clerk";
import {
  type AccessRow,
  type AgentRow,
  agentIdOf,
  type ApiKeyRole,
  emailAllowed,
  splitEmails,
} from "../registry";
import { API_SECRET_HEADER } from "./http";
import { directory, registry } from "./stores";

/**
 * Whether the request carries `API_SECRET`. An unset secret is always false, so a
 * missing secret closes the admin routes rather than opening them.
 */
export function trustedCaller(request: Request, env: Env): boolean {
  if (!env.API_SECRET) return false;
  return request.headers.get(API_SECRET_HEADER) === env.API_SECRET;
}

/**
 * Required configuration: `CLERK_ISSUER`, without which no ordinary caller can be
 * identified. `API_SECRET` is optional (no admin routes). Checked per request so the
 * error says what is missing rather than a module-load 1101.
 */
export function unconfigured(env: Env): string[] {
  const missing: string[] = [];
  if (!env.CLERK_ISSUER) missing.push("CLERK_ISSUER");
  return missing;
}

/**
 * The caller's address, or "" (which matches no access list). Only a verified Clerk token
 * names anyone; `API_SECRET` unlocks the owner routes, never another person's identity.
 */
export async function callerEmail(request: Request, env: Env): Promise<string> {
  return await clerkEmail(request, env);
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
  if (email) {
    const access = await agentAccess(env, agentId);
    return !!access && emailAllowed(access.allowed_emails, email);
  }
  const key = await apiKeyCaller(request, env);
  if (!key || key.agentId !== agentId) return false;
  const access = await agentAccess(env, agentId);
  return !!access && keyPowers(access, key.role).isUser;
}

/**
 * An agent API key: `salt_<role>_<agentId>_<secret>`. The agent id is in the key so the
 * Worker knows which registry holds its hash; the secret is what proves it.
 */
const API_KEY = /^salt_(admin|user)_([A-Za-z0-9-]+)_([A-Za-z0-9]{32,})$/;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh key for the role, its hash (what is stored) and a hint to recognise it by. */
export async function newApiKey(agentId: string, role: ApiKeyRole) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `salt_${role}_${agentId}_${secret}`;
  return { key, hash: await sha256(key), hint: secret.slice(-4) };
}

export type KeyCaller = { agentId: string; role: ApiKeyRole };

/**
 * The agent and role a bearer API key was issued for, when it is that agent's current
 * key of that role; else undefined. A key reaches its own agent and nothing else.
 */
export async function apiKeyCaller(request: Request, env: Env): Promise<KeyCaller | undefined> {
  const offered = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const match = API_KEY.exec(offered);
  if (!match) return undefined;
  const role = match[1] as ApiKeyRole;
  const agentId = match[2];
  // Checked against the directory first, so a made-up id never seeds a store of its own.
  if (!(await directory(env).get(agentId))) return undefined;
  const stored = await registry(env, agentId).apiKeyHash(role);
  if (!stored) return undefined;
  const enc = new TextEncoder();
  const offeredHash = enc.encode(await sha256(offered));
  const storedHash = enc.encode(stored);
  if (offeredHash.byteLength !== storedHash.byteLength) return undefined;
  return crypto.subtle.timingSafeEqual(offeredHash, storedHash) ? { agentId, role } : undefined;
}

/**
 * Who a key acts as on its agent. The admin key is the agent's admin — a member too when
 * the admin is on the access list. The user key is a member with no address of its own.
 */
export function keyPowers(
  access: AccessRow,
  role: ApiKeyRole
): { email: string; isUser: boolean; isAdmin: boolean } {
  if (role === "user") return { email: "", isUser: true, isAdmin: false };
  const email = access.admin_email;
  return { email, isUser: emailAllowed(access.allowed_emails, email), isAdmin: !!email };
}

/** Whether a path is about the key's own agent: its routes, or one of its sessions. */
export function keyReaches(agentId: string, segments: string[]): boolean {
  const [first, second, third] = segments;
  if (!third) return false;
  const id = decodeURIComponent(third);
  if (first === "api" && second === "agents") return id === agentId;
  const sessionRoute =
    (first === "api" && second === "sessions") ||
    (first === "agents" && second === "session-agent");
  return sessionRoute && agentIdOf(id) === agentId;
}
