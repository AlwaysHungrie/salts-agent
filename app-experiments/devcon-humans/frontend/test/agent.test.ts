import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFleetAgent, agentIdOf, createSession, deleteSession, findFleetAgent, issueAgentKey } from "@/lib/agent";
import { ensureFindHumans, mintSecret } from "@/lib/provision";

vi.mock("@/lib/db", () => ({ users: vi.fn() }));

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let servers: { id: string; name: string; headers: Record<string, string> }[];

beforeEach(() => {
  calls = [];
  servers = [];
  vi.stubEnv("AGENT_URL", "https://worker.test/");
  vi.stubEnv("FLEET_API_KEY", `salt_fleet_f1e2_${"a".repeat(48)}`);
  vi.stubEnv("FIND_HUMANS_MCP_URL", "https://humans.test/mcp");
  vi.stubEnv("FIND_HUMANS_SIGNING_KEY", "signing-key");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/agents?email=")) return Response.json({ agents: url.includes("known") ? [{ id: "ab12cd34" }] : [] });
    if (url.endsWith("/api/fleets/f1e2/agents")) return Response.json({ agents: [{ id: "ab12cd34" }] });
    if (url.includes("/api-keys/")) return Response.json({ key: `salt_${url.split("/").pop()}_ab12cd34_k` });
    if (url.endsWith("/mcp?meta=1") && (init.method ?? "GET") === "GET") return Response.json({ servers });
    if (url.endsWith("/sessions")) return Response.json({ id: "ab12cd34-s1" });
    return Response.json({ ok: true });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the agent client", () => {
  it("finds a fleet agent by email, or adds one, with the fleet key", async () => {
    expect(await findFleetAgent("known@x.com")).toBe("ab12cd34");
    expect(await findFleetAgent("new@x.com")).toBeNull();
    expect(await addFleetAgent("new@x.com")).toBe("ab12cd34");
    expect(await issueAgentKey("ab12cd34", "user")).toBe("salt_user_ab12cd34_k");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://worker.test/api/fleets/f1e2/agents?email=known%40x.com",
      "GET https://worker.test/api/fleets/f1e2/agents?email=new%40x.com",
      "POST https://worker.test/api/fleets/f1e2/agents",
      "POST https://worker.test/api/fleets/f1e2/agents/ab12cd34/api-keys/user",
    ]);
    expect(calls.every((c) => c.headers.authorization === `Bearer salt_fleet_f1e2_${"a".repeat(48)}`)).toBe(true);
    expect(calls[2].body).toEqual({ allowed_emails: "new@x.com" });
  });

  it("adds find-humans with a fresh minted secret as its only header", async () => {
    await ensureFindHumans("salt_admin_ab12cd34_x");
    const added = calls.find((c) => c.method === "POST")!;
    expect(added.url).toBe("https://worker.test/api/agents/ab12cd34/mcp?meta=1");
    expect(added.headers.authorization).toBe("Bearer salt_admin_ab12cd34_x");
    const body = added.body as { name: string; auth: string; headers: Record<string, string> };
    expect(body).toMatchObject({ name: "find-humans", url: "https://humans.test/mcp", auth: "headers" });
    expect(Object.keys(body.headers)).toEqual(["X-Find-Humans-Secret"]);
    const [, id] = body.headers["X-Find-Humans-Secret"].split(".");
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.headers["X-Find-Humans-Secret"]).toBe(mintSecret(id));
  });

  it("matches find-humans' signature", () => {
    // Same key and id as mcp-server/tests: the two sides must agree byte for byte.
    vi.stubEnv("FIND_HUMANS_SIGNING_KEY", "test-signing-key-0123456789abcdefghij");
    expect(mintSecret("asha-id-0123456789abcdef")).toBe(
      "fh1.asha-id-0123456789abcdef.pRrdEwqRLWQ0n8oduxsmcJXSSce6avC-weonQeU8i0Q",
    );
  });

  it("drops shared headers and keeps the user's profile id", async () => {
    servers = [{
      id: "s1",
      name: "find-humans",
      headers: { Authorization: "Bearer shared", "X-OpenRouter-Api-Key": "sk-or", "X-Find-Humans-Secret": "plain-secret-0123456789" },
    }];
    await ensureFindHumans("salt_admin_ab12cd34_x");
    const patched = calls.find((c) => c.method === "PATCH")!;
    expect(patched.url).toBe("https://worker.test/api/agents/ab12cd34/mcp/s1?meta=1");
    expect((patched.body as { headers: Record<string, string> }).headers).toEqual({
      "X-Find-Humans-Secret": mintSecret("plain-secret-0123456789"),
    });

    calls = [];
    servers = [{ id: "s1", name: "find-humans", headers: { "X-Find-Humans-Secret": mintSecret("their-id-0123456789") } }];
    await ensureFindHumans("salt_admin_ab12cd34_x");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("starts and deletes sessions on the key's own agent", async () => {
    expect(await createSession("salt_user_ab12cd34_y", "Chat")).toBe("ab12cd34-s1");
    await deleteSession("salt_user_ab12cd34_y", "ab12cd34-s0");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://worker.test/api/agents/ab12cd34/sessions",
      "DELETE https://worker.test/api/sessions/ab12cd34-s0",
    ]);
  });

  it("surfaces the Worker's error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "this account may administer at most 5 agents" }, { status: 403 }));
    await expect(addFleetAgent("x@x.com")).rejects.toMatchObject({ message: "this account may administer at most 5 agents", status: 403 });
  });

  it("reads the agent id from a key", () => {
    expect(agentIdOf("salt_user_ab12cd34_y")).toBe("ab12cd34");
    expect(() => agentIdOf("sk-nope")).toThrow();
  });
});
