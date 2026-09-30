import type { Env } from "../agent";
import {
  discoverAuthServer,
  exchangeCode,
  type McpServerRow,
  pkceChallenge,
  randomToken,
  registerClient,
} from "../mcp";
import { errorMessage } from "../worker/http";
import { syncMcpTools } from "../worker/integrations";
import { registry, type Registry } from "../worker/stores";

/** Where the authorization server sends the browser back to. Always this Worker. */
export const redirectUri = (origin: string) => `${origin}/api/mcp/oauth/callback`;

/**
 * Begin an OAuth connection: discover the provider's endpoints, register this app as
 * a client if it has not been already, and hand back the URL to send the user to.
 *
 * The PKCE verifier and the CSRF state are parked on the row; the callback is the
 * only thing that reads them, and it clears them once the tokens are in. The state
 * is prefixed with the agent id, because the callback has nothing else to go on.
 */
export async function startMcpOauth(
  reg: Registry,
  agentId: string,
  row: McpServerRow,
  origin: string,
  returnTo: string
): Promise<string> {
  const redirect = redirectUri(origin);
  const { metadata, resource } = await discoverAuthServer(row.url);
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("that server does not advertise an OAuth authorization endpoint");
  }

  let clientId = row.oauth_client_id;
  let clientSecret = row.oauth_client_secret;
  // A client registered against a different authorization server is no client at all.
  if (!clientId || row.oauth_authorize_url !== metadata.authorization_endpoint) {
    if (!metadata.registration_endpoint) {
      throw new Error("that server supports neither a saved client nor dynamic registration");
    }
    const registered = await registerClient(metadata.registration_endpoint, redirect);
    clientId = registered.client_id;
    clientSecret = registered.client_secret ?? "";
  }

  const verifier = randomToken();
  // The redirect URI is registered with the provider and cannot vary per agent, so
  // the callback is one route for all of them — and the state is the only thing that
  // comes back. It carries the agent so the callback knows whose registry to open.
  const state = `${agentId}.${randomToken(16)}`;
  await reg.updateMcpServer(row.id, {
    auth: "oauth",
    oauth_client_id: clientId,
    oauth_client_secret: clientSecret,
    oauth_authorize_url: metadata.authorization_endpoint,
    oauth_token_url: metadata.token_endpoint,
    oauth_registration_url: metadata.registration_endpoint ?? "",
    oauth_resource: resource,
    oauth_scope: (metadata.scopes_supported ?? []).join(" "),
    oauth_verifier: verifier,
    oauth_state: state,
    oauth_return_to: returnTo,
    last_error: "",
  });

  const authorize = new URL(metadata.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirect);
  authorize.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  // RFC 8707: bind the token to this server, so it is useless anywhere else.
  if (resource) authorize.searchParams.set("resource", resource);
  const scopes = (metadata.scopes_supported ?? []).join(" ");
  if (scopes) authorize.searchParams.set("scope", scopes);
  return authorize.toString();
}

/**
 * The provider sends the browser back here with a code. It is traded for tokens, the
 * server's tools are read straight away, and the user lands back on the page they
 * started from — connected, or with the reason it failed on the card.
 */
export async function handleOauthCallback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const agentId = state.split(".")[0] ?? "";
  if (!agentId) return new Response("unknown or expired authorization state", { status: 400 });
  const reg = registry(env, agentId);
  const row = await reg.mcpServerByState(state);
  // No row for this state means a stale or forged callback; there is nothing to do.
  if (!row) return new Response("unknown or expired authorization state", { status: 400 });

  const back = new URL(row.oauth_return_to || `${url.origin}/`);
  const fail = async (message: string) => {
    await reg.updateMcpServer(row.id, { oauth_state: "", oauth_verifier: "", last_error: message });
    back.searchParams.set("mcp_error", message);
    return Response.redirect(back.toString(), 302);
  };

  const error = url.searchParams.get("error");
  if (error) return await fail(url.searchParams.get("error_description") ?? error);
  const code = url.searchParams.get("code") ?? "";
  if (!code) return await fail("the provider returned no authorization code");

  try {
    const tokens = await exchangeCode(row.oauth_token_url, {
      code,
      clientId: row.oauth_client_id,
      clientSecret: row.oauth_client_secret || undefined,
      redirectUri: redirectUri(url.origin),
      verifier: row.oauth_verifier,
      resource: row.oauth_resource || undefined,
    });
    const connected = await reg.updateMcpServer(row.id, {
      oauth_access_token: tokens.access_token,
      oauth_refresh_token: tokens.refresh_token ?? "",
      oauth_expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
      oauth_scope: tokens.scope ?? row.oauth_scope,
      oauth_verifier: "",
      oauth_state: "",
      last_error: "",
    });
    if (connected) await syncMcpTools(reg, connected);
    back.searchParams.set("mcp_connected", row.name);
    return Response.redirect(back.toString(), 302);
  } catch (err) {
    return await fail(errorMessage(err));
  }
}
