import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * Header values on an MCP server: readable by whoever may edit them, masked for
 * everyone else, and editable after the server is saved.
 */

const BASE = "https://worker.test";
const MASK = "••••••••";

const someone = () => `member-${crypto.randomUUID().slice(0, 8)}@x.com`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedIn(email),
    },
  };
}

type Server = { id: string; name: string; url: string; headers: Record<string, string> };

async function withHeadersServer() {
  const email = someone();
  const agent = (await (
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Agent",
          allowed_emails: email,
          openrouter_api_key: "sk-fake-but-valid",
        }),
      })
    )
  ).json()) as { id: string };
  const created = (await (
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/mcp`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "Keyed",
          url: "https://mcp.test/",
          auth: "headers",
          headers: { Authorization: "Bearer first" },
        }),
      })
    )
  ).json()) as { server: Server };
  return { email, agentId: agent.id, server: created.server };
}

const list = async (agentId: string, email: string, query = "") =>
  (
    (await (await SELF.fetch(`${BASE}/api/agents/${agentId}/mcp${query}`, as(email))).json()) as {
      servers: Server[];
    }
  ).servers;

describe("MCP header values", () => {
  it("are returned in full to a caller that may edit the list", async () => {
    const { email, agentId, server } = await withHeadersServer();
    expect(server.headers).toEqual({ Authorization: "Bearer first" });
    expect((await list(agentId, email))[0].headers).toEqual({ Authorization: "Bearer first" });
  });

  it("can be changed after the server is saved", async () => {
    const { email, agentId, server } = await withHeadersServer();
    const res = await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
      as(email, {
        method: "PATCH",
        body: JSON.stringify({ headers: { Authorization: "Bearer second", "X-Team": "t1" } }),
      })
    );
    expect(res.status).toBe(200);
    const { server: updated } = (await res.json()) as { server: Server };
    expect(updated.headers).toEqual({ Authorization: "Bearer second", "X-Team": "t1" });
  });

  it("survive the server's URL being changed after it is saved", async () => {
    const { email, agentId, server } = await withHeadersServer();
    const res = await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
      as(email, { method: "PATCH", body: JSON.stringify({ url: "https://mcp.test/moved" }) })
    );
    expect(res.status).toBe(200);
    const { server: moved } = (await res.json()) as { server: Server };
    expect(moved.url).toBe("https://mcp.test/moved");
    expect(moved.headers).toEqual({ Authorization: "Bearer first" });
  });

  it("are masked when the list is managed for the caller, and shown to the owning dialog", async () => {
    const { email, agentId } = await withHeadersServer();
    const locked = await SELF.fetch(
      `${BASE}/api/agents/${agentId}/meta`,
      as(email, { method: "PATCH", body: JSON.stringify({ mcp: { user_servers: false } }) })
    );
    expect(locked.status).toBe(200);
    expect((await list(agentId, email))[0].headers).toEqual({ Authorization: MASK });
    expect((await list(agentId, email, "?meta=1"))[0].headers).toEqual({
      Authorization: "Bearer first",
    });
  });
});

describe("a server the admin gave, with adding servers off", () => {
  it("can be repointed and reconfigured by the user, but not renamed, added to or removed", async () => {
    const { email, agentId, server } = await withHeadersServer();
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/meta`,
      as(email, { method: "PATCH", body: JSON.stringify({ mcp: { user_servers: false } }) })
    );
    const patch = (body: unknown) =>
      SELF.fetch(
        `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
        as(email, { method: "PATCH", body: JSON.stringify(body) })
      );

    const moved = await patch({ url: "https://mcp.test/moved", headers: { Authorization: "Bearer mine" } });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { server: Server }).server.url).toBe("https://mcp.test/moved");
    expect((await list(agentId, email, "?meta=1"))[0].headers).toEqual({ Authorization: "Bearer mine" });
    // The name as it stands may ride along with an edit; a new one is the admin's.
    expect((await patch({ name: server.name, url: "https://mcp.test/again" })).status).toBe(200);
    expect((await patch({ name: "Renamed" })).status).toBe(403);

    const added = await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp`,
      as(email, { method: "POST", body: JSON.stringify({ name: "Another", url: "https://mcp.test/x" }) })
    );
    expect(added.status).toBe(403);
    const removed = await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
      as(email, { method: "DELETE" })
    );
    expect(removed.status).toBe(403);
  });
});
