import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { agentIdOf } from "./registry";
import { fileBusinessRequest, handleAdmin } from "./routes/admin";
import { handleAgents } from "./routes/agents";
import { handleFleets } from "./routes/fleets";
import { ROUTE_INDEX } from "./routes/index-page";
import { handleOauthCallback } from "./routes/mcp-oauth";
import { handleSearxngMcp, handleSearxngUrl } from "./routes/searxng";
import { handleSession } from "./routes/sessions";
import { handleWebhook } from "./routes/telegram";
import { handleWhatsappWebhook } from "./routes/whatsapp";
import { deploymentSettings, SettingsIncompleteError } from "./settings";
import {
  apiKeyCaller,
  callerEmail,
  keyReaches,
  mayUseAgent,
  mayUseSessionAsGuest,
  unconfigured,
} from "./worker/auth";
import { CORS, json, jsonError, notFound, withCors } from "./worker/http";
import { directory, registry } from "./worker/stores";

export { SessionAgent } from "./agent";
export { AgentDirectory, SessionRegistry } from "./registry";

/**
 * Checks before any route: the deployment is configured, CORS preflight, and the
 * settings are complete. Returns a response to end with, or undefined to carry on.
 */
async function preflight(request: Request, env: Env, segments: string[]) {
  // 503, not 500: the deployment is incomplete rather than broken.
  const missing = unconfigured(env);
  if (missing.length) {
    return jsonError(
      `This Worker is not configured: ${missing.join(", ")} is not set, so no Clerk session token can be verified and no ordinary caller can be identified. Set it in \`vars\` in agent/wrangler.jsonc — it is the \`iss\` your Clerk tokens carry, e.g. https://<subdomain>.clerk.accounts.dev.`,
      503
    );
  }
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Until every setting is stored, only the two routes the admin CLI needs are served.
  const settingUp =
    segments[0] === "api" &&
    segments[1] === "admin" &&
    (segments[2] === "settings" || segments[2] === "stats");
  if (settingUp) return undefined;
  try {
    await deploymentSettings(env);
  } catch (err) {
    if (!(err instanceof SettingsIncompleteError)) throw err;
    // Shown to end users, so it names no fields; the owner uses `admin-cli check`.
    return jsonError("Deployment is missing default settings", 503);
  }
  return undefined;
}

/**
 * The identity gate: everything under /api and /agents needs a caller (a Clerk session,
 * or an agent API key on that agent's routes), and a session route needs one allowed on
 * the session's agent (or its guest owner).
 */
async function gate(request: Request, env: Env, segments: string[]) {
  if ((segments[0] === "api" || segments[0] === "agents") && !(await callerEmail(request, env))) {
    // No Clerk session: an agent API key, on its own agent's routes only.
    const key = await apiKeyCaller(request, env);
    if (!key || !keyReaches(key.agentId, segments)) return jsonError("unauthorized", 401);
  }
  const sessionRoute =
    (segments[0] === "agents" && segments[1] === "session-agent" && segments[2]) ||
    (segments[0] === "api" && segments[1] === "sessions" && segments[2]);
  if (!sessionRoute) return undefined;
  const sessionId = decodeURIComponent(segments[2]);
  const owner = agentIdOf(sessionId);
  const allowed =
    !!owner &&
    ((await mayUseAgent(request, env, owner)) ||
      (await mayUseSessionAsGuest(request, env, owner, sessionId, segments)));
  return allowed ? undefined : notFound();
}

/** Keep the sidebar ordered by recency: a message touches its session and agent. */
function touchOnMessage(env: Env, ctx: ExecutionContext, segments: string[]) {
  if (segments[0] !== "agents" || segments[1] !== "session-agent" || !segments[2]) return;
  if (segments[3] !== "stream" && segments[3] !== "chat") return;
  const sessionId = decodeURIComponent(segments[2]);
  const agentId = agentIdOf(sessionId);
  if (!agentId) return;
  ctx.waitUntil(
    (async () => {
      await registry(env, agentId).touch(sessionId);
      await directory(env).touch(agentId);
    })()
  );
}

/**
 * Routes matched before the identity gate, because their callers have no Clerk session:
 * the MCP OAuth redirect (state token) and the owner's admin routes (`API_SECRET`).
 */
async function unauthenticatedRoute(
  request: Request,
  env: Env,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const [first, second, third] = segments;
  if (first === "api" && second === "mcp" && third === "oauth" && segments[3] === "callback") {
    return await handleOauthCallback(url, env);
  }
  if (first === "api" && second === "admin") return await handleAdmin(request, env, url, segments);
  return undefined;
}

/**
 * Webhook-style routes, outside the gated /api and /agents prefixes: Telegram and
 * WhatsApp prove themselves with per-agent secrets, SearXNG with the agent's token.
 */
async function channelRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  segments: string[]
): Promise<Response | undefined> {
  const [first, second, third] = segments;
  const method = request.method;
  if (method === "POST" && first === "telegram" && second === "webhook" && third) {
    return await handleWebhook(request, env, ctx, third);
  }
  if (
    (method === "POST" || method === "GET") &&
    first === "whatsapp" &&
    second === "webhook" &&
    third
  ) {
    return await handleWhatsappWebhook(request, env, ctx, url, third);
  }
  // salts-tools posts its tunnel URLs here; the agent's SearXNG token is the proof.
  if (method === "POST" && first === "searxng" && second && third === "url" && !segments[3]) {
    return await handleSearxngUrl(request, env, decodeURIComponent(second));
  }
  if (method === "POST" && first === "searxng" && second && third === "mcp" && !segments[3]) {
    return await handleSearxngMcp(request, env, decodeURIComponent(second));
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    const early =
      (await preflight(request, env, segments)) ??
      (await unauthenticatedRoute(request, env, url, segments));
    if (early) return early;

    if (segments[0] === "api" && segments[1] === "business-requests" && !segments[2]) {
      return await fileBusinessRequest(request, env);
    }

    const refused = await gate(request, env, segments);
    if (refused) return refused;

    if (segments[0] === "api") {
      const handled =
        segments[1] === "fleets"
          ? await handleFleets(request, env, url, segments)
          : segments[1] === "agents"
            ? await handleAgents(request, env, url, segments)
            : segments[1] === "sessions" && segments[2]
              ? await handleSession(request, env, url, segments)
              : undefined;
      if (handled) return handled;
    }

    touchOnMessage(env, ctx, segments);

    const channel = await channelRoute(request, env, ctx, url, segments);
    if (channel) return channel;

    const routed = await routeAgentRequest(request, env);
    if (routed) return withCors(routed);

    if (url.pathname === "/") return json(ROUTE_INDEX);
    return jsonError("not found", 404);
  },
};
