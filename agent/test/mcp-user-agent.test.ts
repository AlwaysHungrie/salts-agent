import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverAuthServer,
  exchangeCode,
  McpClient,
  registerClient,
  USER_AGENT,
} from "../src/mcp";

/**
 * Every outbound MCP and OAuth request names itself. A Worker's `fetch` sends no
 * User-Agent by default, and some providers' firewalls refuse such a request outright
 * (Porkbun answers client registration with a bare 403).
 */

const seen: Headers[] = [];

function stubFetch(respond: (url: string) => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push(new Headers(init?.headers));
    return respond(String(input));
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  seen.length = 0;
});

describe("outbound User-Agent", () => {
  it("is sent on discovery, registration and token exchange", async () => {
    stubFetch((url) => {
      if (url.includes("oauth-protected-resource")) {
        return json({ authorization_servers: ["https://auth.test"] });
      }
      if (url.includes("oauth-authorization-server")) {
        return json({
          authorization_endpoint: "https://auth.test/authorize",
          token_endpoint: "https://auth.test/token",
          registration_endpoint: "https://auth.test/register",
        });
      }
      if (url.endsWith("/register")) return json({ client_id: "c1" });
      return json({ access_token: "t1" });
    });

    await discoverAuthServer("https://mcp.test/mcp");
    await registerClient("https://auth.test/register", "https://worker.test/cb");
    await exchangeCode("https://auth.test/token", {
      code: "x",
      clientId: "c1",
      redirectUri: "https://worker.test/cb",
      verifier: "v",
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const headers of seen) expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("is sent on MCP calls, unless the server's own headers set one", async () => {
    stubFetch(() =>
      json({ jsonrpc: "2.0", id: 1, result: { tools: [], protocolVersion: "2025-06-18" } })
    );

    await new McpClient("https://mcp.test/mcp").listTools();
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) expect(headers.get("user-agent")).toBe(USER_AGENT);

    seen.length = 0;
    await new McpClient("https://mcp.test/mcp", { "User-Agent": "Custom/2" }).listTools();
    for (const headers of seen) expect(headers.get("user-agent")).toBe("Custom/2");
  });
});
