import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ApiApp, ApiEnv } from "../api/app";
import { jsonOf, refusals } from "../api/app";
import {
  AgentRowSchema,
  GuestsSchema,
  OkSchema,
  SessionPageSchema,
  SessionRowSchema,
} from "../api/schemas";
import type { Env } from "../env";
import type { AccessRow, AgentRow } from "../registry";
import { emailAllowed, normalizeEmails, sessionName, splitEmails } from "../registry";
import { deploymentSettings } from "../settings";
import { Telegram } from "../telegram";
import { agentAccess, apiKeyCaller, callerEmail, isGuest, keyPowers } from "../worker/auth";
import { ApiError, errorMessage, listEntries, refuseNotFound } from "../worker/http";
import { agentFor, deleteAgent } from "../worker/provisioning";
import {
  directory,
  readConfig,
  registry,
  sessionPageSize,
  syncSessionCount,
  writeConfig,
} from "../worker/stores";
import { guestSessions, guestsView, publicView, startGuestSession } from "./guest";

/**
 * What a route under `/api/agents/{agentId}` knows about the call. A user is on the
 * access list; an admin made the agent and owns only its meta and deletion; a guest may
 * only message it.
 */
export type AgentCall = {
  request: Request;
  env: Env;
  url: URL;
  agentId: string;
  /** The directory row, with the access list and admin taken from the registry. */
  agent: AgentRow;
  access: AccessRow;
  reg: ReturnType<typeof registry>;
  email: string;
  isUser: boolean;
  isAdmin: boolean;
  /** Neither user nor admin, but on the agent's guest list. */
  isGuest: boolean;
};

/** The agent and the caller's roles on it, or undefined when there is no such agent. */
async function resolveCall(
  request: Request,
  env: Env,
  agentId: string
): Promise<AgentCall | undefined> {
  const row = await directory(env).get(agentId);
  if (!row) return undefined;
  // The registry decides access; the row only supplies the name and timestamps.
  const access = await agentAccess(env, agentId, row);
  if (!access) return undefined;

  const signedIn = await callerEmail(request, env);
  // Without a Clerk session the gate let this through on this agent's API key.
  const key = signedIn ? undefined : await apiKeyCaller(request, env);
  const powers =
    key?.agentId === agentId
      ? keyPowers(access, key.role)
      : {
          email: signedIn,
          isUser: emailAllowed(access.allowed_emails, signedIn),
          isAdmin: !!signedIn && access.admin_email === signedIn,
        };
  return {
    request,
    env,
    url: new URL(request.url),
    agentId,
    agent: { ...row, allowed_emails: access.allowed_emails, admin_email: access.admin_email },
    access,
    reg: registry(env, agentId),
    ...powers,
    isGuest: !powers.isUser && !powers.isAdmin && isGuest(access, powers.email),
  };
}

/** Who may reach a route, given the caller's roles on the agent. */
export const may = {
  /** On the access list: using the agent. */
  member: (c: AgentCall) => c.isUser,
  /** The admin: the meta document and deletion. */
  admin: (c: AgentCall) => c.isAdmin,
  /** Either: readable by both roles. */
  either: (c: AgentCall) => c.isUser || c.isAdmin,
  /** Members and guests: starting and listing sessions. */
  memberOrGuest: (c: AgentCall) => c.isUser || c.isGuest,
  /** Anyone the agent knows. */
  anyone: (c: AgentCall) => c.isUser || c.isAdmin || c.isGuest,
};

/**
 * Resolve the agent and refuse unless `policy` admits the caller. Everyone refused gets
 * the same 404: an agent you were not given is one that does not exist.
 */
export function agentRoute(policy: (call: AgentCall) => boolean): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const call = await resolveCall(c.req.raw, c.env, c.req.param("agentId") ?? "");
    if (!call || !policy(call)) refuseNotFound();
    c.set("call", call);
    await next();
  };
}

/** The `{agentId}` path parameter every agent route takes. */
export const AgentParams = z.object({
  agentId: z.string().openapi({ param: { name: "agentId", in: "path" }, example: "ab12cd34" }),
});

const AgentPatchSchema = z
  .object({
    name: z.string().optional(),
    allowed_emails: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({ description: "Replaces the member list. The caller stays on it." }),
    guests: z.boolean().optional().openapi({ description: "Admin only." }),
    guest_emails: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({ description: "Admin only. Empty with guests on means anyone signed in." }),
  })
  .openapi("AgentPatch");

const AgentWithGuestsSchema = AgentRowSchema.extend({ guests: GuestsSchema.optional() });

const PublicViewSchema = z
  .object({ id: z.string(), name: z.string(), public_notes: z.string() })
  .openapi("PublicAgent");

const SessionQuery = z.object({
  limit: z.string().optional().openapi({ description: "Page size." }),
  cursor: z.string().optional().openapi({ description: "From the previous page." }),
  mine: z.literal("1").optional().openapi({ description: "Only sessions the caller started." }),
});

const tag = ["Agent"];

/** The agent itself, its public view, its sessions and its bot's status. */
const readAgent = createRoute({
  method: "get",
  path: "/api/agents/{agentId}",
  tags: tag,
  summary: "Read the agent",
  middleware: [agentRoute(may.either)] as const,
  request: { params: AgentParams },
  responses: { 200: jsonOf(AgentRowSchema), ...refusals(404) },
});

const patchAgentRoute = createRoute({
  method: "patch",
  path: "/api/agents/{agentId}",
  tags: tag,
  summary: "Rename the agent, set its members or its guests",
  middleware: [agentRoute(may.either)] as const,
  request: {
    params: AgentParams,
    body: { content: { "application/json": { schema: AgentPatchSchema } } },
  },
  responses: { 200: jsonOf(AgentWithGuestsSchema), ...refusals(400, 403, 404) },
});

const deleteAgentRoute = createRoute({
  method: "delete",
  path: "/api/agents/{agentId}",
  tags: tag,
  summary: "Delete the agent and everything in it (admin)",
  middleware: [agentRoute(may.admin)] as const,
  request: { params: AgentParams },
  responses: { 200: jsonOf(OkSchema), ...refusals(404) },
});

const publicRoute = createRoute({
  method: "get",
  path: "/api/agents/{agentId}/public",
  tags: tag,
  summary: "The agent's name and public notes",
  middleware: [agentRoute(may.anyone)] as const,
  request: { params: AgentParams },
  responses: { 200: jsonOf(PublicViewSchema), ...refusals(404) },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/agents/{agentId}/sessions",
  tags: ["Sessions"],
  summary: "List sessions, newest first",
  description: "A guest sees only the sessions they started.",
  middleware: [agentRoute(may.memberOrGuest)] as const,
  request: { params: AgentParams, query: SessionQuery },
  responses: { 200: jsonOf(SessionPageSchema), ...refusals(404) },
});

const startSessionRoute = createRoute({
  method: "post",
  path: "/api/agents/{agentId}/sessions",
  tags: ["Sessions"],
  summary: "Start a session",
  middleware: [agentRoute(may.memberOrGuest)] as const,
  request: {
    params: AgentParams,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ title: z.string().optional() })
            .openapi({ example: { title: "From curl" } }),
        },
      },
    },
  },
  responses: { 200: jsonOf(SessionRowSchema), ...refusals(404, 409) },
});

const telegramStatusRoute = createRoute({
  method: "get",
  path: "/api/agents/{agentId}/telegram/status",
  tags: ["Channels"],
  summary: "Ask Telegram whether the bot is wired up",
  middleware: [agentRoute(may.member)] as const,
  request: { params: AgentParams },
  responses: {
    200: jsonOf(
      z.object({
        enabled: z.boolean(),
        bot: z.string(),
        expected: z.string(),
        webhook: z.record(z.string(), z.unknown()),
      })
    ),
    ...refusals(400, 404, 502),
  },
});

export function agentRoutes(app: ApiApp) {
  app.openapi(readAgent, (c) => c.json(agentFor(c.var.call.agent, c.var.call.email), 200));

  app.openapi(patchAgentRoute, async (c) =>
    c.json(await patchAgent(c.var.call, c.req.valid("json")), 200)
  );

  app.openapi(deleteAgentRoute, async (c) => {
    const { env, url, agentId } = c.var.call;
    await deleteAgent(env, url.origin, agentId);
    return c.json({ ok: true }, 200);
  });

  app.openapi(publicRoute, async (c) =>
    c.json(await publicView(c.var.call.env, c.var.call.agent), 200)
  );

  app.openapi(listSessionsRoute, async (c) => {
    const call = c.var.call;
    if (call.isGuest) return c.json(await guestSessions(call), 200);
    const settings = await deploymentSettings(call.env);
    const { cursor, mine } = c.req.valid("query");
    // `?mine=1` narrows to the sessions the caller started.
    const owner = mine === "1" ? call.email : "";
    return c.json(
      await call.reg.list(sessionPageSize(call.url, settings), cursor ?? "", owner),
      200
    );
  });

  app.openapi(startSessionRoute, async (c) => {
    const call = c.var.call;
    const { title } = c.req.valid("json");
    if (call.isGuest) return c.json(await startGuestSession(call, title), 200);
    return c.json(await startSession(call, title), 200);
  });

  app.openapi(telegramStatusRoute, async (c) => c.json(await telegramStatus(c.var.call), 200));
}

type AgentPatch = z.infer<typeof AgentPatchSchema>;

/** Guests are the admin's to set; the name and access list are the users'. */
async function patchAgent(call: AgentCall, body: AgentPatch) {
  const { env, agentId, email, reg } = call;

  if (body.guests !== undefined || body.guest_emails !== undefined) {
    if (!call.isAdmin) refuseNotFound();
    let guestEmails: string | undefined;
    if (body.guest_emails !== undefined) {
      try {
        guestEmails = normalizeEmails(
          listEntries(body.guest_emails),
          (await deploymentSettings(env)).max_members
        );
      } catch (err) {
        throw new ApiError(400, errorMessage(err));
      }
    }
    const saved = await reg.setGuests({
      ...(body.guests !== undefined ? { guests: body.guests ? 1 : 0 } : {}),
      ...(guestEmails !== undefined ? { guest_emails: guestEmails } : {}),
    });
    await directory(env).setGuests(agentId, saved.guests, saved.guest_emails);
    if (body.name === undefined && body.allowed_emails === undefined) {
      return { ...agentFor(call.agent, email), guests: guestsView(saved) };
    }
  }

  if (!call.isUser) refuseNotFound();
  let next = call.agent;

  if (body.name !== undefined) {
    const cleaned = body.name.trim().slice(0, 60);
    if (!cleaned) throw new ApiError(400, "name is required");
    await directory(env).rename(agentId, cleaned);
    // The settings row keeps a copy: the system prompt tells the model its name.
    await writeConfig(env, reg, { agent_name: cleaned });
    next = { ...next, name: cleaned };
  }

  if (body.allowed_emails !== undefined) {
    next = { ...next, allowed_emails: await setMembers(call, body.allowed_emails) };
  }

  return agentFor(next, email);
}

/**
 * Replace the access list. The editor is always kept on it, so nobody locks themselves
 * out, and the admin's `member_limit` is enforced here rather than in the browser.
 */
async function setMembers(call: AgentCall, input: string | string[]): Promise<string> {
  const { request, env, agentId, reg } = call;
  const caller = await callerEmail(request, env);
  let allowed: string;
  try {
    allowed = normalizeEmails(
      [...(caller ? [caller] : []), ...listEntries(input)],
      (await deploymentSettings(env)).max_members
    );
  } catch (err) {
    throw new ApiError(400, errorMessage(err));
  }
  if (!allowed) throw new ApiError(400, "at least one email is required");

  const memberLimit = (await reg.meta()).member_limit;
  if (memberLimit > 0 && splitEmails(allowed).length > memberLimit) {
    throw new ApiError(
      403,
      `this agent may have at most ${memberLimit} member${memberLimit === 1 ? "" : "s"}`
    );
  }
  // Registry (the gate) before directory (the index): if the second write is lost, a
  // removed address has already lost access and merely still sees the agent listed.
  await reg.setAccess({ allowed_emails: allowed });
  await directory(env).setAllowedEmails(agentId, allowed);
  return allowed;
}

/** Start a session for a member. */
async function startSession(call: AgentCall, title: string | undefined) {
  const { env, agentId, reg, email } = call;
  // The agent id is part of the name, so one namespace holds every agent's sessions.
  const sessionId = sessionName(agentId, crypto.randomUUID().slice(0, 8));
  // The hex id attributes Cloudflare analytics to a session; see
  // docs/cloudflare-durable-object-costs.md.
  const objectId = env.SessionAgent.idFromName(sessionId).toString();
  await directory(env).touch(agentId);
  let created;
  try {
    created = await reg.create(
      sessionId,
      title ?? "New session",
      objectId,
      undefined,
      (await deploymentSettings(env)).max_sessions,
      email
    );
  } catch (err) {
    throw new ApiError(409, errorMessage(err));
  }
  await syncSessionCount(env, agentId);
  return created;
}

/** "Why is the bot not answering?", asked of Telegram itself. */
async function telegramStatus(call: AgentCall) {
  const { env, url, agentId, reg } = call;
  const config = await readConfig(env, reg);
  if (!config.telegram_bot_token) throw new ApiError(400, "no bot token saved");
  const bot = new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE);
  try {
    const [info, me] = await Promise.all([bot.webhookInfo(), bot.me()]);
    return {
      enabled: config.cap_telegram === 1,
      bot: me.username,
      expected: `${url.origin}/telegram/webhook/${agentId}`,
      webhook: info as unknown as Record<string, unknown>,
    };
  } catch (err) {
    throw new ApiError(502, errorMessage(err));
  }
}
