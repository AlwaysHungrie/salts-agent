import type { Env } from "../env";
import {
  type AuthServerMetadata,
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
 * The Worker's OAuth client id under CIMD (Client ID Metadata Documents): a URL that
 * serves the client's own metadata, which the authorization server fetches instead of
 * having us register. Per origin, so staging and production are separate clients.
 */
export const clientMetadataUrl = (origin: string) => `${origin}/oauth/client.json`;

/** The document served at `clientMetadataUrl(origin)`. Its `client_id` is that URL. */
export function clientMetadata(origin: string) {
  return {
    client_id: clientMetadataUrl(origin),
    client_name: "Salts",
    client_uri: "https://salts.dev",
    redirect_uris: [redirectUri(origin)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** `GET /oauth/client.json`: public, since authorization servers fetch it with no session. */
export function handleClientMetadata(url: URL): Response {
  return new Response(JSON.stringify(clientMetadata(url.origin)), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * Whether the authorization server takes a CIMD client id from a public client: it says
 * it fetches client metadata, and allows token requests with no secret (or does not say).
 */
export function supportsCimd(metadata: AuthServerMetadata): boolean {
  const methods = metadata.token_endpoint_auth_methods_supported;
  return (
    metadata.client_id_metadata_document_supported === true &&
    (!methods || methods.includes("none"))
  );
}

/**
 * Whether the saved client can be reused. A client registered against a different
 * authorization server, or for a different redirect URI (the Worker moved domains), is
 * no client at all: the provider rejects the authorize request. Where the server takes
 * CIMD, anything but the current CIMD client id is replaced, so registered clients move
 * over on their next connect; where it no longer does, a saved CIMD client id is dead.
 */
export function needsNewClient(
  row: Pick<McpServerRow, "oauth_client_id" | "oauth_authorize_url" | "oauth_redirect_uri">,
  authorizeUrl: string,
  redirect: string,
  cimd: { url: string; supported: boolean }
): boolean {
  return (
    !row.oauth_client_id ||
    row.oauth_authorize_url !== authorizeUrl ||
    row.oauth_redirect_uri !== redirect ||
    (cimd.supported ? row.oauth_client_id !== cimd.url : row.oauth_client_id === cimd.url)
  );
}

/**
 * Start an OAuth connection: discover endpoints, pick a client (CIMD where the server
 * takes it, else dynamic registration), park the PKCE verifier and state on the row, and
 * return the authorize URL.
 */
export async function startMcpOauth(
  reg: Registry,
  agentId: string,
  row: McpServerRow,
  origin: string,
  returnTo: string
): Promise<string> {
  const redirect = redirectUri(origin);
  const { metadata, resource, scope } = await discoverAuthServer(row.url);
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("that server does not advertise an OAuth authorization endpoint");
  }

  const cimd = { url: clientMetadataUrl(origin), supported: supportsCimd(metadata) };
  let clientId = row.oauth_client_id;
  let clientSecret = row.oauth_client_secret;
  if (needsNewClient(row, metadata.authorization_endpoint, redirect, cimd)) {
    if (cimd.supported) {
      // A public client: the id is our metadata URL, and there is no secret.
      clientId = cimd.url;
      clientSecret = "";
    } else if (metadata.registration_endpoint) {
      const registered = await registerClient(metadata.registration_endpoint, redirect);
      clientId = registered.client_id;
      clientSecret = registered.client_secret ?? "";
    } else {
      throw new Error(
        "that server supports neither client ID metadata documents (CIMD) nor dynamic registration"
      );
    }
  }

  const verifier = randomToken();
  // One redirect URI for every agent, so the state carries the agent id.
  const state = `${agentId}.${randomToken(16)}`;
  await reg.updateMcpServer(row.id, {
    auth: "oauth",
    oauth_client_id: clientId,
    oauth_client_secret: clientSecret,
    oauth_authorize_url: metadata.authorization_endpoint,
    oauth_token_url: metadata.token_endpoint,
    // Empty for a CIMD client: nothing was registered.
    oauth_registration_url: clientId === cimd.url ? "" : (metadata.registration_endpoint ?? ""),
    oauth_redirect_uri: redirect,
    oauth_resource: resource,
    oauth_scope: scope,
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
  if (scope) authorize.searchParams.set("scope", scope);
  return authorize.toString();
}

/**
 * OAuth callback: exchange the code, read the server's tools, and redirect back with
 * the outcome.
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
