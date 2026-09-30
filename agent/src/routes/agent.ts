import type { Env } from "../agent";
import type { AccessRow, AgentRow } from "../registry";
import { emailAllowed, normalizeEmails, sessionName, splitEmails } from "../registry";
import { deploymentSettings } from "../settings";
import { Telegram } from "../telegram";
import { agentAccess, callerEmail, isGuest } from "../worker/auth";
import { errorMessage, json, jsonError, listEntries, notFound, readJson } from "../worker/http";
import { agentFor, deleteAgent } from "../worker/provisioning";
import {
  directory,
  readConfig,
  registry,
  sessionPageSize,
  syncSessionCount,
  writeConfig,
} from "../worker/stores";
import { handleConfig, handleMeta } from "./agent-settings";
import { guestsView, handleGuest, publicView } from "./guest";
import { handleMcp } from "./mcp";

/**
 * Everything a route under `/api/agents/:agentId` needs to know about the call.
 *
 * A *user* is on the access list and owns the agent's pages. An *admin* made the agent
 * and owns its meta document and its deletion, nothing else. Both are true when the
 * admin put their own address on the list.
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
};

/** One agent: its row, settings, meta, MCP servers, sessions and bot status. */
export async function handleAgent(
  request: Request,
  env: Env,
  url: URL,
  agentId: string,
  segments: string[]
): Promise<Response | undefined> {
  const row = await directory(env).get(agentId);
  if (!row) return notFound();
  // The registry decides access; the row only supplies the name and timestamps.
  const access = await agentAccess(env, agentId, row);
  if (!access) return notFound();

  const email = await callerEmail(request, env);
  const call: AgentCall = {
    request,
    env,
    url,
    agentId,
    agent: { ...row, allowed_emails: access.allowed_emails, admin_email: access.admin_email },
    access,
    reg: registry(env, agentId),
    email,
    isUser: emailAllowed(access.allowed_emails, email),
    isAdmin: !!email && access.admin_email === email,
  };
  const section = segments[3];

  if (!call.isUser && !call.isAdmin) {
    if (!isGuest(access, email)) return notFound();
    return await handleGuest(request, env, url, call.agent, section, email);
  }

  if (section === "public" && request.method === "GET") {
    return json(await publicView(env, call.agent));
  }
  if (!section) return await handleAgentRow(call);

  // Past here is using the agent, which is the users'. Meta and `?meta=1` MCP check
  // for the admin themselves.
  if (!call.isUser && section !== "meta" && section !== "mcp") return notFound();

  if (section === "config") return await handleConfig(call);
  if (section === "meta") return await handleMeta(call);
  if (section === "mcp") {
    const fromMeta = url.searchParams.get("meta") === "1";
    if (!call.isUser && !(call.isAdmin && fromMeta)) return notFound();
    return await handleMcp(request, env, url, agentId, segments.slice(4));
  }
  if (section === "sessions") return await handleSessions(call);
  if (section === "telegram" && segments[4] === "status" && request.method === "GET") {
    return await telegramStatus(call);
  }
  return undefined;
}

/** `/api/agents/:agentId` itself: read it, edit it, delete it. */
async function handleAgentRow(call: AgentCall): Promise<Response | undefined> {
  const { request, env, url, agentId, agent, email } = call;
  // Readable by both roles; it says nothing an admin does not already know.
  if (request.method === "GET") return json(agentFor(agent, email));
  if (request.method === "PATCH") return await patchAgent(call);
  if (request.method === "DELETE") {
    // The admin's alone: a user should not be able to take it from the other users.
    if (!call.isAdmin) return notFound();
    await deleteAgent(env, url.origin, agentId);
    return json({ ok: true });
  }
  return undefined;
}

type AgentPatch = {
  name?: string;
  allowed_emails?: string | string[];
  guests?: boolean;
  guest_emails?: string | string[];
};

/** Guests are the admin's to set; the name and access list are the users'. */
async function patchAgent(call: AgentCall): Promise<Response> {
  const { request, env, agentId, email, reg } = call;
  const body = await readJson<AgentPatch>(request);

  if (body.guests !== undefined || body.guest_emails !== undefined) {
    if (!call.isAdmin) return notFound();
    let guestEmails: string | undefined;
    if (body.guest_emails !== undefined) {
      try {
        guestEmails = normalizeEmails(
          listEntries(body.guest_emails),
          (await deploymentSettings(env)).max_members
        );
      } catch (err) {
        return jsonError(errorMessage(err), 400);
      }
    }
    const saved = await reg.setGuests({
      ...(body.guests !== undefined ? { guests: body.guests ? 1 : 0 } : {}),
      ...(guestEmails !== undefined ? { guest_emails: guestEmails } : {}),
    });
    await directory(env).setGuests(agentId, saved.guests, saved.guest_emails);
    if (body.name === undefined && body.allowed_emails === undefined) {
      return json({ ...agentFor(call.agent, email), guests: guestsView(saved) });
    }
  }

  if (!call.isUser) return notFound();
  let next = call.agent;

  if (body.name !== undefined) {
    const cleaned = body.name.trim().slice(0, 60);
    if (!cleaned) return jsonError("name is required", 400);
    await directory(env).rename(agentId, cleaned);
    // The settings row keeps a copy: the system prompt tells the model its name.
    await writeConfig(env, reg, { agent_name: cleaned });
    next = { ...next, name: cleaned };
  }

  if (body.allowed_emails !== undefined) {
    const result = await setMembers(call, body.allowed_emails);
    if (result instanceof Response) return result;
    next = { ...next, allowed_emails: result };
  }

  return json(agentFor(next, email));
}

/**
 * Replace the access list. The editor is always kept on it, so nobody locks themselves
 * out, and the admin's `member_limit` is enforced here rather than in the browser.
 */
async function setMembers(call: AgentCall, input: string | string[]): Promise<string | Response> {
  const { request, env, agentId, reg } = call;
  const caller = await callerEmail(request, env);
  let allowed: string;
  try {
    allowed = normalizeEmails(
      [...(caller ? [caller] : []), ...listEntries(input)],
      (await deploymentSettings(env)).max_members
    );
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
  if (!allowed) return jsonError("at least one email is required", 400);

  const memberLimit = (await reg.meta()).member_limit;
  if (memberLimit > 0 && splitEmails(allowed).length > memberLimit) {
    return jsonError(
      `this agent may have at most ${memberLimit} member${memberLimit === 1 ? "" : "s"}`,
      403
    );
  }
  // Registry (the gate) before directory (the index): if the second write is lost, a
  // removed address has already lost access and merely still sees the agent listed.
  await reg.setAccess({ allowed_emails: allowed });
  await directory(env).setAllowedEmails(agentId, allowed);
  return allowed;
}

/** List the agent's sessions a page at a time, or start one. */
async function handleSessions(call: AgentCall): Promise<Response | undefined> {
  const { request, env, url, agentId, reg, email } = call;
  if (request.method === "GET") {
    const settings = await deploymentSettings(env);
    // `?mine=1` narrows to the sessions the caller started.
    const owner = url.searchParams.get("mine") === "1" ? email : "";
    return json(
      await reg.list(sessionPageSize(url, settings), url.searchParams.get("cursor") ?? "", owner)
    );
  }
  if (request.method === "POST") {
    const { title } = await readJson<{ title?: string }>(request);
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
      return jsonError(errorMessage(err), 409);
    }
    await syncSessionCount(env, agentId);
    return json(created);
  }
  return undefined;
}

/** "Why is the bot not answering?", asked of Telegram itself. */
async function telegramStatus(call: AgentCall): Promise<Response> {
  const { env, url, agentId, reg } = call;
  const config = await readConfig(env, reg);
  if (!config.telegram_bot_token) return jsonError("no bot token saved", 400);
  const bot = new Telegram(config.telegram_bot_token, env.TELEGRAM_API_BASE);
  try {
    const [info, me] = await Promise.all([bot.webhookInfo(), bot.me()]);
    return json({
      enabled: config.cap_telegram === 1,
      bot: me.username,
      expected: `${url.origin}/telegram/webhook/${agentId}`,
      webhook: info,
    });
  } catch (err) {
    return jsonError(errorMessage(err), 502);
  }
}
