import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * The typed API: one agent's routes, validated by zod and documented from the same
 * schemas. The document is what the user guide's playground reads.
 */

const BASE = "https://worker.test";
const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

async function createAgent(owner: string) {
  const res = await SELF.fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedIn(owner) },
    body: JSON.stringify({ name: "Doc", allowed_emails: owner, openrouter_api_key: "sk-fake" }),
  });
  return ((await res.json()) as { id: string }).id;
}

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

describe("the OpenAPI document", () => {
  it("is served without signing in and lists what a key can reach", async () => {
    const res = await SELF.fetch(`${BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Doc;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
    const paths = Object.keys(doc.paths);
    for (const path of [
      "/api/agents/{agentId}",
      "/api/agents/{agentId}/config",
      "/api/agents/{agentId}/meta",
      "/api/agents/{agentId}/mcp/{serverId}",
      "/api/agents/{agentId}/sessions",
      "/api/agents/{agentId}/api-keys/{role}",
      "/api/sessions/{sessionId}/fork",
      "/agents/session-agent/{sessionId}/chat",
      "/agents/session-agent/{sessionId}/stream",
      "/agents/session-agent/{sessionId}/files",
    ]) {
      expect(paths).toContain(path);
    }
    // Only what a key can reach: not the agent list, fleets, admin or webhooks.
    expect(paths.some((p) => /^\/api\/(admin|fleets)|^\/(telegram|whatsapp)/.test(p))).toBe(false);
    expect(paths).not.toContain("/api/agents");
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Config", "MetaSettings", "Session", "Error"])
    );
  });
});

describe("the typed routes", () => {
  it("take a JSON body whatever the content type says, as curl -d sends it", async () => {
    const owner = someone("owner");
    const id = await createAgent(owner);
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/sessions`, {
      method: "POST",
      headers: { ...signedIn(owner), "content-type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ title: "From curl" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("From curl");
  });

  it("refuses a malformed body as { error }, with CORS", async () => {
    const owner = someone("owner");
    const id = await createAgent(owner);
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/sessions`, {
      method: "POST",
      headers: { ...signedIn(owner), "content-type": "application/json" },
      body: JSON.stringify({ title: 42 }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await res.json()) as { error: string }).error).toMatch(/title/);
  });

  it("keeps the session object's own routes out of reach", async () => {
    const owner = someone("owner");
    const id = await createAgent(owner);
    const session = (await (
      await SELF.fetch(`${BASE}/api/agents/${id}/sessions`, {
        method: "POST",
        headers: signedIn(owner),
      })
    ).json()) as { id: string };
    for (const [method, path] of [
      ["GET", "export"],
      ["POST", "import"],
      ["POST", "destroy"],
      ["POST", "telegram"],
    ]) {
      const res = await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/${path}`, {
        method,
        headers: { ...signedIn(owner), "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, path).toBe(404);
    }
  });
});
