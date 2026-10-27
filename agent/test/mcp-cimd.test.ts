import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseScope, exchangeCode, refreshToken, type McpServerRow } from "../src/mcp";
import { EMPTY_MCP_SERVER } from "../src/registry";
import { clientMetadataUrl, redirectUri, startMcpOauth } from "../src/routes/mcp-oauth";
import type { Registry } from "../src/worker/stores";

/**
 * MCP OAuth with CIMD (Client ID Metadata Documents): the Worker's client id is a URL
 * serving its own metadata, so an authorization server with no registration endpoint
 * (Clerk, as Salts runs it) still lets agents connect. Dynamic registration stays the
 * fallback.
 */

const BASE = "https://worker.test";
const MCP_URL = "https://mcp.bonfires.test/mcp";
const ISSUER = "https://clerk.example";
const MCP_SCOPES = ["openid", "email", "profile", "offline_access"];

/** Clerk's live metadata, trimmed to what the flow reads. */
const CLERK_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  token_endpoint_auth_methods_supported: ["client_secret_basic", "none", "client_secret_post"],
  scopes_supported: ["openid", "profile", "email", "public_metadata", "private_metadata"],
  client_id_metadata_document_supported: true,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

type Fake = {
  authServer: Record<string, unknown>;
  resourceScopes?: string[];
  challenge?: string;
};

/** Every outbound request, and the authorization and MCP servers answering them. */
function stubServers(fake: Fake) {
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === MCP_URL) {
      const headers: Record<string, string> = {};
      if (fake.challenge !== undefined) headers["www-authenticate"] = fake.challenge;
      return new Response("unauthorized", { status: 401, headers });
    }
    if (url.includes("oauth-protected-resource")) {
      return json({
        resource: MCP_URL,
        authorization_servers: [ISSUER],
        ...(fake.resourceScopes ? { scopes_supported: fake.resourceScopes } : {}),
      });
    }
    if (url.includes("oauth-authorization-server")) return json(fake.authServer);
    if (url === `${ISSUER}/register`) return json({ client_id: "dcr-1", client_secret: "s1" });
    if (url.endsWith("/token")) return json({ access_token: "t1", refresh_token: "r1" });
    return new Response("not found", { status: 404 });
  });
  return requests;
}

/** A registry that keeps what `startMcpOauth` writes, and nothing else. */
function fakeRegistry() {
  const saved: Partial<McpServerRow>[] = [];
  const reg = {
    updateMcpServer: async (_id: string, patch: Partial<McpServerRow>) => {
      saved.push(patch);
      return undefined;
    },
  } as unknown as Registry;
  return { reg, saved };
}

const row = (patch: Partial<McpServerRow> = {}): McpServerRow => ({
  ...EMPTY_MCP_SERVER,
  id: "m1",
  name: "Bonfires",
  url: MCP_URL,
  auth: "oauth",
  created_at: 0,
  ...patch,
});

const origin = "https://api.salts.dev";

afterEach(() => vi.restoreAllMocks());

describe("GET /oauth/client.json", () => {
  it("serves the client metadata document with no sign-in", async () => {
    const res = await SELF.fetch(`${BASE}/oauth/client.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({
      client_id: `${BASE}/oauth/client.json`,
      client_name: "Salts",
      client_uri: "https://salts.dev",
      redirect_uris: [redirectUri(BASE)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("names the URL it is served from as the client id", () => {
    expect(clientMetadataUrl(origin)).toBe("https://api.salts.dev/oauth/client.json");
  });
});

describe("startMcpOauth", () => {
  it("uses the CIMD client id when the authorization server takes it", async () => {
    const requests = stubServers({ authServer: CLERK_METADATA, resourceScopes: MCP_SCOPES });
    const { reg, saved } = fakeRegistry();

    const authorize = new URL(await startMcpOauth(reg, "a1", row(), origin, "/back"));

    expect(requests.some((r) => r.url.endsWith("/register"))).toBe(false);
    expect(authorize.origin + authorize.pathname).toBe(CLERK_METADATA.authorization_endpoint);
    expect(authorize.searchParams.get("client_id")).toBe(clientMetadataUrl(origin));
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri(origin));
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorize.searchParams.get("scope")).toBe("openid email profile offline_access");

    const patch = saved[0];
    expect(patch.oauth_client_id).toBe(clientMetadataUrl(origin));
    expect(patch.oauth_client_secret).toBe("");
    expect(patch.oauth_registration_url).toBe("");
    expect(patch.oauth_scope).toBe("openid email profile offline_access");
  });

  it("takes CIMD when the server does not list its token auth methods", async () => {
    const { token_endpoint_auth_methods_supported: _, ...unlisted } = CLERK_METADATA;
    stubServers({ authServer: unlisted });
    const { reg, saved } = fakeRegistry();
    await startMcpOauth(reg, "a1", row(), origin, "/back");
    expect(saved[0].oauth_client_id).toBe(clientMetadataUrl(origin));
  });

  it("registers when CIMD needs a secret it cannot have", async () => {
    const requests = stubServers({
      authServer: {
        ...CLERK_METADATA,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        registration_endpoint: `${ISSUER}/register`,
      },
    });
    const { reg, saved } = fakeRegistry();
    await startMcpOauth(reg, "a1", row(), origin, "/back");
    expect(requests.some((r) => r.url.endsWith("/register"))).toBe(true);
    expect(saved[0].oauth_client_id).toBe("dcr-1");
  });

  it("registers as before when the server offers only dynamic registration", async () => {
    const { client_id_metadata_document_supported: _, ...dcr } = CLERK_METADATA;
    const requests = stubServers({
      authServer: { ...dcr, registration_endpoint: `${ISSUER}/register` },
    });
    const { reg, saved } = fakeRegistry();

    const authorize = new URL(await startMcpOauth(reg, "a1", row(), origin, "/back"));

    expect(requests.filter((r) => r.url.endsWith("/register"))).toHaveLength(1);
    expect(authorize.searchParams.get("client_id")).toBe("dcr-1");
    expect(saved[0].oauth_client_secret).toBe("s1");
    expect(saved[0].oauth_registration_url).toBe(`${ISSUER}/register`);
  });

  it("refuses a server that offers neither", async () => {
    const { client_id_metadata_document_supported: _, ...neither } = CLERK_METADATA;
    stubServers({ authServer: neither });
    const { reg } = fakeRegistry();
    await expect(startMcpOauth(reg, "a1", row(), origin, "/back")).rejects.toThrow(/CIMD/);
  });

  it("moves a registered client to CIMD once the server takes it", async () => {
    const requests = stubServers({ authServer: CLERK_METADATA });
    const { reg, saved } = fakeRegistry();
    const registered = row({
      oauth_client_id: "dcr-old",
      oauth_client_secret: "old-secret",
      oauth_authorize_url: CLERK_METADATA.authorization_endpoint,
      oauth_redirect_uri: redirectUri(origin),
      oauth_registration_url: `${ISSUER}/register`,
    });

    await startMcpOauth(reg, "a1", registered, origin, "/back");

    expect(requests.some((r) => r.url.endsWith("/register"))).toBe(false);
    expect(saved[0].oauth_client_id).toBe(clientMetadataUrl(origin));
    expect(saved[0].oauth_client_secret).toBe("");
    expect(saved[0].oauth_registration_url).toBe("");
  });

  it("asks for the scope the MCP server's challenge names", async () => {
    stubServers({
      authServer: CLERK_METADATA,
      resourceScopes: MCP_SCOPES,
      challenge: 'Bearer resource_metadata="x", scope="openid email"',
    });
    const { reg, saved } = fakeRegistry();
    const authorize = new URL(await startMcpOauth(reg, "a1", row(), origin, "/back"));
    expect(authorize.searchParams.get("scope")).toBe("openid email");
    expect(saved[0].oauth_scope).toBe("openid email");
  });

  it("falls back to the authorization server's scopes when the MCP server lists none", async () => {
    stubServers({ authServer: CLERK_METADATA });
    const { reg } = fakeRegistry();
    const authorize = new URL(await startMcpOauth(reg, "a1", row(), origin, "/back"));
    expect(authorize.searchParams.get("scope")).toBe(CLERK_METADATA.scopes_supported.join(" "));
  });
});

describe("chooseScope", () => {
  const authServer = CLERK_METADATA.scopes_supported;

  it("prefers the challenge, then the resource metadata, then the authorization server", () => {
    expect(chooseScope({ challenge: "openid", resource: MCP_SCOPES, authServer })).toBe("openid");
    expect(chooseScope({ resource: MCP_SCOPES, authServer })).toBe(MCP_SCOPES.join(" "));
    expect(chooseScope({ authServer })).toBe(authServer.join(" "));
    expect(chooseScope({})).toBe("");
  });

  it("never asks for a scope the MCP server did not list", () => {
    const scope = chooseScope({ resource: MCP_SCOPES, authServer }).split(" ");
    expect(scope).not.toContain("private_metadata");
    expect(scope).not.toContain("public_metadata");
  });
});

describe("token requests from a public client", () => {
  function formOf(requests: { init?: RequestInit }[]) {
    return new URLSearchParams(String(requests[0].init?.body));
  }

  it("sends no client_secret on the code exchange", async () => {
    const requests = stubServers({ authServer: CLERK_METADATA });
    await exchangeCode(`${ISSUER}/oauth/token`, {
      code: "c",
      clientId: clientMetadataUrl(origin),
      clientSecret: undefined,
      redirectUri: redirectUri(origin),
      verifier: "v",
      resource: MCP_URL,
    });
    const form = formOf(requests);
    expect(form.get("client_id")).toBe(clientMetadataUrl(origin));
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("resource")).toBe(MCP_URL);
  });

  it("sends no client_secret on a refresh", async () => {
    const requests = stubServers({ authServer: CLERK_METADATA });
    await refreshToken(`${ISSUER}/oauth/token`, {
      refreshToken: "r",
      clientId: clientMetadataUrl(origin),
      clientSecret: undefined,
      resource: MCP_URL,
    });
    const form = formOf(requests);
    expect(form.get("client_id")).toBe(clientMetadataUrl(origin));
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("resource")).toBe(MCP_URL);
  });
});
