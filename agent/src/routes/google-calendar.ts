import { createRoute, z } from "@hono/zod-openapi";
import { type ApiApp, jsonOf, refusals } from "../api/app";
import { GoogleCalendarSchema } from "../api/schemas";
import type { Env } from "../env";
import {
  GOOGLE_TOKEN_URL,
  forgetGoogleCalendar,
  googleAuthorizeUrl,
  googleRedirectUri,
  grantsCalendar,
  primaryCalendarEmail,
} from "../google-calendar";
import { exchangeCode, pkceChallenge, randomToken } from "../mcp";
import { ApiError, errorMessage } from "../worker/http";
import { registry } from "../worker/stores";
import { type AgentCall, AgentParams, agentRoute, may } from "./agent";

/** The deployment's Google OAuth client, or undefined when none is configured. */
function googleClient(env: Env): { id: string; secret: string } | undefined {
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
    : undefined;
}

const StatusSchema = z
  .object({
    connection: GoogleCalendarSchema,
    available: z.boolean().openapi({
      description: "Whether this deployment has a Google OAuth client to connect through.",
    }),
  })
  .openapi("GoogleCalendarStatus");

async function status({ env, reg }: AgentCall) {
  return { connection: await reg.googleCalendar(), available: !!googleClient(env) };
}

/** Park a PKCE verifier and state on the agent and hand back Google's consent screen. */
async function connect({ env, url, agentId, reg }: AgentCall, returnTo: string) {
  const client = googleClient(env);
  if (!client) throw new ApiError(503, "Google Calendar is not set up on this deployment.");
  const verifier = randomToken();
  // One redirect URI for every agent, so the state carries the agent id.
  const state = `${agentId}.${randomToken(16)}`;
  await reg.beginGoogleCalendar(state, verifier, returnTo);
  return {
    authorize_url: googleAuthorizeUrl({
      clientId: client.id,
      redirectUri: googleRedirectUri(url.origin),
      state,
      challenge: await pkceChallenge(verifier),
    }),
  };
}

/** Forget the tokens here, and revoke them at Google so the grant does not linger. */
async function disconnect({ reg }: AgentCall) {
  await forgetGoogleCalendar(reg);
  return { connection: await reg.googleCalendar() };
}

/**
 * Google's redirect after consent: exchange the code, read which account it is, store
 * the tokens and send the browser back with the outcome. Unauthenticated: the state,
 * parked on the agent when the connect began, is the proof.
 */
export async function handleGoogleOauthCallback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const agentId = state.split(".")[0] ?? "";
  const stale = () => new Response("unknown or expired authorization state", { status: 400 });
  if (!agentId) return stale();
  const reg = registry(env, agentId);
  const pending = await reg.googleCalendarPending(state);
  if (!pending) return stale();

  const back = new URL(pending.return_to || `${url.origin}/`);
  const fail = async (message: string) => {
    await reg.finishGoogleCalendar({ error: message });
    back.searchParams.set("gcal_error", message);
    return Response.redirect(back.toString(), 302);
  };

  const error = url.searchParams.get("error");
  if (error) {
    return await fail(
      error === "access_denied" ? "Access to Google Calendar was not granted." : error
    );
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code) return await fail("Google returned no authorization code.");
  const client = googleClient(env);
  if (!client) return await fail("Google Calendar is not set up on this deployment.");

  try {
    const tokens = await exchangeCode(GOOGLE_TOKEN_URL, {
      code,
      clientId: client.id,
      clientSecret: client.secret,
      redirectUri: googleRedirectUri(url.origin),
      verifier: pending.verifier,
    });
    // Google lets the user untick scopes on the consent screen; without them every tool fails.
    if (tokens.scope && !grantsCalendar(tokens.scope)) {
      return await fail(
        "Calendar access was not granted. Connect again and allow access to your calendars."
      );
    }
    const email = await primaryCalendarEmail(tokens.access_token);
    await reg.finishGoogleCalendar({
      email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? "",
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
      scope: tokens.scope ?? "",
    });
    back.searchParams.set("gcal_connected", email);
    return Response.redirect(back.toString(), 302);
  } catch (err) {
    return await fail(errorMessage(err));
  }
}

const tag = ["Google Calendar"];
const middleware = [agentRoute(may.member)];
const ConnectionAnswer = jsonOf(z.object({ connection: GoogleCalendarSchema }));

/** `/google-calendar`: the Google Calendar capability's connection, for the capabilities page. */
export function googleCalendarRoutes(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/agents/{agentId}/google-calendar",
      tags: tag,
      summary: "Read the Google Calendar connection",
      description: "Which Google account is connected, if any. Tokens are never returned.",
      middleware,
      request: { params: AgentParams },
      responses: { 200: jsonOf(StatusSchema), ...refusals(404) },
    }),
    async (c) => c.json(await status(c.var.call), 200)
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/google-calendar/connect",
      tags: tag,
      summary: "Start connecting Google Calendar",
      description: "Open `authorize_url` in a browser; Google sends it back to `return_to`.",
      middleware,
      request: {
        params: AgentParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                return_to: z.string().optional().openapi({ description: "Where to land after." }),
              }),
            },
          },
        },
      },
      responses: {
        200: jsonOf(z.object({ authorize_url: z.string() })),
        ...refusals(400, 404, 503),
      },
    }),
    async (c) => {
      const returnTo = c.req.valid("json").return_to ?? "";
      if (returnTo && !/^https?:\/\//.test(returnTo)) {
        throw new ApiError(400, "return_to must be an http(s) URL");
      }
      return c.json(await connect(c.var.call, returnTo), 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/agents/{agentId}/google-calendar/disconnect",
      tags: tag,
      summary: "Disconnect Google Calendar",
      description: "Forgets the tokens and revokes them at Google.",
      middleware,
      request: { params: AgentParams },
      responses: { 200: ConnectionAnswer, ...refusals(404) },
    }),
    async (c) => c.json(await disconnect(c.var.call), 200)
  );
}
