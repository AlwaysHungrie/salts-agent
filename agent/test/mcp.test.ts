import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  parseHeaders,
  parseNames,
  parseTools,
  pkceChallenge,
  qualifiedName,
  randomToken,
  slug,
  type McpServerRow,
} from "../src/mcp";
import { mcpServerReady, mcpServersForChat, mcpToolSpecs } from "../src/capabilities";
import { EMPTY_MCP_SERVER } from "../src/registry";
import { needsNewClient } from "../src/routes/mcp-oauth";

/**
 * External MCP servers: the one place this Worker runs code it did not write the
 * contract for.
 *
 * Everything a server sends — its tool list, its schemas, its names — is untrusted
 * input that reaches the model, so the parsers have to survive malformed values
 * rather than throw inside a turn. `mcpServerReady` and `mcpToolSpecs` are the gate:
 * a server that cannot authenticate must contribute nothing at all.
 */

const server = (patch: Partial<McpServerRow> = {}): McpServerRow => ({
  ...EMPTY_MCP_SERVER,
  id: "m1",
  name: "Docs Server",
  url: "https://mcp.example.com",
  created_at: 0,
  ...patch,
});

describe("parseHeaders", () => {
  it("reads a flat object of strings", () => {
    expect(parseHeaders('{"x-key":"value"}')).toEqual({ "x-key": "value" });
  });

  it("returns nothing for an empty value", () => {
    expect(parseHeaders("")).toEqual({});
    expect(parseHeaders("   ")).toEqual({});
  });

  it("returns nothing for malformed JSON rather than throwing", () => {
    // This value is typed into a settings box by hand. A throw here would fail the
    // turn rather than the header.
    expect(parseHeaders("{not json")).toEqual({});
  });

  it("drops values that are not strings", () => {
    expect(parseHeaders('{"a":"ok","b":5,"c":null,"d":{"nested":1}}')).toEqual({ a: "ok" });
  });

  it("drops a blank header name", () => {
    expect(parseHeaders('{"  ":"value","real":"v"}')).toEqual({ real: "v" });
  });

  it("trims the header name", () => {
    expect(parseHeaders('{" x-key ":"value"}')).toEqual({ "x-key": "value" });
  });
});

describe("parseNames and parseTools", () => {
  it("reads a list of names", () => {
    expect(parseNames('["a","b"]')).toEqual(["a", "b"]);
  });

  it("disables nothing for a malformed value", () => {
    // Failing open matters here: this list is what is switched *off*, so a parse
    // error must not silently disable a server's whole tool set.
    expect(parseNames("{not json")).toEqual([]);
    expect(parseNames("")).toEqual([]);
  });

  it("drops entries that are not strings", () => {
    expect(parseNames('["a",5,null,{"b":1}]')).toEqual(["a"]);
  });

  it("ignores a JSON value that is not an array", () => {
    expect(parseNames('{"a":1}')).toEqual([]);
    expect(parseTools('{"a":1}')).toEqual([]);
  });

  it("reads a tool list", () => {
    expect(parseTools('[{"name":"search"}]')).toEqual([{ name: "search" }]);
  });

  it("reads no tools from a malformed list", () => {
    expect(parseTools("{not json")).toEqual([]);
    expect(parseTools("")).toEqual([]);
  });
});

describe("slug and qualifiedName", () => {
  it("lowercases and replaces punctuation", () => {
    expect(slug("My Docs Server!")).toBe("my_docs_server");
  });

  it("trims leading and trailing separators", () => {
    expect(slug("  --Docs--  ")).toBe("docs");
  });

  it("falls back to a usable name when nothing survives", () => {
    // OpenRouter rejects an empty function name, so this may never return "".
    expect(slug("!!!")).toBe("mcp");
    expect(slug("")).toBe("mcp");
  });

  it("caps the slug", () => {
    expect(slug("a".repeat(100)).length).toBeLessThanOrEqual(24);
  });

  it("keeps a qualified name inside the length a function name allows", () => {
    const name = qualifiedName(server({ name: "x".repeat(100) }), "y".repeat(100));
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("namespaces a tool under its server", () => {
    expect(qualifiedName(server({ name: "Docs" }), "search")).toBe("mcp_docs_search");
  });

  it("keeps two servers' identically named tools apart", () => {
    const a = qualifiedName(server({ name: "Alpha" }), "search");
    const b = qualifiedName(server({ name: "Beta" }), "search");
    expect(a).not.toBe(b);
  });
});

describe("mcpServersForChat", () => {
  const servers = [server({ name: "Open" }), server({ name: "Wallet", in_groups: 0 })];
  const names = (chat: Parameters<typeof mcpServersForChat>[1]) =>
    mcpServersForChat(servers, chat).map((s) => s.name);

  it("leaves a server switched off for groups out of a Telegram group or supergroup", () => {
    expect(names({ source: "telegram", chat_type: "group" })).toEqual(["Open"]);
    expect(names({ source: "telegram", chat_type: "supergroup" })).toEqual(["Open"]);
  });

  it("keeps every server for a private chat, WhatsApp and the browser", () => {
    expect(names({ source: "telegram", chat_type: "private" })).toEqual(["Open", "Wallet"]);
    expect(names({ source: "whatsapp", chat_type: "private" })).toEqual(["Open", "Wallet"]);
    expect(names({ source: "web", chat_type: "" })).toEqual(["Open", "Wallet"]);
    expect(names(undefined)).toEqual(["Open", "Wallet"]);
  });
});

describe("mcpServerReady", () => {
  it("is true for an enabled server needing no auth", () => {
    expect(mcpServerReady(server())).toBe(true);
  });

  it("is false for a disabled server", () => {
    expect(mcpServerReady(server({ enabled: 0 }))).toBe(false);
  });

  it("is false with no URL", () => {
    expect(mcpServerReady(server({ url: "" }))).toBe(false);
    expect(mcpServerReady(server({ url: "   " }))).toBe(false);
  });

  it("is false for an OAuth server with no access token", () => {
    // The handshake was started and never finished; calling it would 401 inside a turn.
    expect(mcpServerReady(server({ auth: "oauth", oauth_access_token: "" }))).toBe(false);
  });

  it("is true for an OAuth server holding a token", () => {
    expect(mcpServerReady(server({ auth: "oauth", oauth_access_token: "token" }))).toBe(true);
  });
});

describe("mcpToolSpecs", () => {
  const withTools = (patch: Partial<McpServerRow> = {}) =>
    server({ tools_json: '[{"name":"search","description":"Search the docs"}]', ...patch });

  it("exposes a connected server's tools", () => {
    const specs = mcpToolSpecs([withTools()]);
    expect(specs.map((s) => s.name)).toEqual(["mcp_docs_server_search"]);
  });

  it("labels the tool with the server it came from", () => {
    expect(mcpToolSpecs([withTools()])[0].description).toContain("Docs Server");
  });

  it("gives a tool with no schema an empty object schema", () => {
    // Handed straight to the model; `undefined` here is a malformed tool definition.
    const specs = mcpToolSpecs([withTools({ tools_json: '[{"name":"search"}]' })]);
    expect(specs[0].parameters).toEqual({ type: "object", properties: {} });
  });

  it("passes a server's own schema through untouched", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const specs = mcpToolSpecs([
      withTools({ tools_json: JSON.stringify([{ name: "search", inputSchema: schema }]) }),
    ]);
    expect(specs[0].parameters).toEqual(schema);
  });

  it("exposes nothing from a server that is not ready", () => {
    expect(mcpToolSpecs([withTools({ enabled: 0 })])).toEqual([]);
    expect(mcpToolSpecs([withTools({ auth: "oauth", oauth_access_token: "" })])).toEqual([]);
  });

  it("leaves out a tool that was switched off", () => {
    // A tool never handed to the model is one it cannot call — that is the whole
    // enforcement mechanism for the per-tool switches.
    const specs = mcpToolSpecs([withTools({ disabled_tools: '["search"]' })]);
    expect(specs).toEqual([]);
  });

  it("keeps the other tools when one is switched off", () => {
    const specs = mcpToolSpecs([
      withTools({
        tools_json: '[{"name":"search"},{"name":"fetch"}]',
        disabled_tools: '["search"]',
      }),
    ]);
    expect(specs.map((s) => s.name)).toEqual(["mcp_docs_server_fetch"]);
  });

  it("exposes every ready server's tools together", () => {
    const specs = mcpToolSpecs([
      withTools({ id: "m1", name: "Alpha" }),
      withTools({ id: "m2", name: "Beta" }),
    ]);
    expect(specs).toHaveLength(2);
  });

  it("survives a server whose tool list is malformed", () => {
    expect(mcpToolSpecs([withTools({ tools_json: "{not json" })])).toEqual([]);
  });

  it("returns nothing for no servers", () => {
    expect(mcpToolSpecs([])).toEqual([]);
  });
});

describe("OAuth helpers", () => {
  it("makes a token of the requested size", () => {
    // base64url of 32 bytes; the exact length matters less than it being long and
    // URL-safe, since it travels as a query parameter.
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken(32).length).toBeGreaterThanOrEqual(32);
  });

  it("does not repeat itself", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
  });

  it("derives a PKCE challenge that is stable for one verifier", async () => {
    const verifier = randomToken();
    expect(await pkceChallenge(verifier)).toBe(await pkceChallenge(verifier));
  });

  it("derives different challenges for different verifiers", async () => {
    expect(await pkceChallenge("one")).not.toBe(await pkceChallenge("two"));
  });

  it("produces a URL-safe challenge with no padding", async () => {
    const challenge = await pkceChallenge(randomToken());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
  });

  it("pins the protocol version it negotiates", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });
});

describe("needsNewClient", () => {
  const authorize = "https://auth.example.com/authorize";
  const redirect = "https://api.salts.dev/api/mcp/oauth/callback";
  const registered = server({
    oauth_client_id: "c1",
    oauth_authorize_url: authorize,
    oauth_redirect_uri: redirect,
  });

  it("reuses a client registered for this server and redirect URI", () => {
    expect(needsNewClient(registered, authorize, redirect)).toBe(false);
  });

  it("registers when there is no client yet", () => {
    expect(needsNewClient(server(), authorize, redirect)).toBe(true);
  });

  it("registers when the authorization server changed", () => {
    expect(needsNewClient(registered, "https://other.example.com/authorize", redirect)).toBe(true);
  });

  it("registers when the Worker's redirect URI changed", () => {
    const moved = "https://old.workers.dev/api/mcp/oauth/callback";
    expect(needsNewClient(registered, authorize, moved)).toBe(true);
  });

  it("registers for a client saved before the redirect URI was recorded", () => {
    expect(needsNewClient({ ...registered, oauth_redirect_uri: "" }, authorize, redirect)).toBe(
      true
    );
  });
});
