import { SELF, env } from "cloudflare:test";
import { EMPTY_MCP_SERVER } from "../src/registry";
import { describe, expect, it } from "vitest";
import { clerkToken, signedIn } from "./clerk";

/**
 * A trusted app's Clerk OAuth access token as a way into its user's agent sessions.
 *
 * The suite trusts `https://trusted.test/client.json` for resource `https://worker.test`
 * (vitest.config.ts). Such a token may start a session on an agent the user is on, talk
 * in it and delete it; it is no Salts login anywhere else, and a token for another
 * resource or client, or for an unverified address, opens nothing.
 *
 * Also here: any caller may pay for its own message with `x-openrouter-key`, and narrow
 * the MCP servers it may use with `x-mcp-servers`.
 */

const BASE = "https://worker.test";
const TRUSTED = "https://trusted.test/client.json";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

/** An access token the way Clerk issues one: no sid and no email, the user in `sub`. */
const accessToken = (email: string, claims: Record<string, unknown> = {}) =>
  clerkToken(email, {
    sid: undefined,
    email: undefined,
    aud: [BASE],
    client_id: TRUSTED,
    scope: "openid email profile offline_access",
    ...claims,
  });

const bearer = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

async function createAgent(member: string): Promise<string> {
  const owner = someone("owner");
  const res = await SELF.fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedIn(owner) },
    body: JSON.stringify({
      name: "Tutor",
      allowed_emails: member,
      openrouter_api_key: "sk-fake-but-valid",
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const startSession = (agentId: string, token: string) =>
  SELF.fetch(`${BASE}/api/agents/${agentId}/sessions`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ title: "Office hours" }),
  });

describe("OAuth access tokens from a trusted app", () => {
  it("start, use and delete a session on the user's agent", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const token = accessToken(member);

    const started = await startSession(agentId, token);
    expect(started.status).toBe(200);
    const { id } = (await started.json()) as { id: string };

    const stream = await SELF.fetch(
      `${BASE}/agents/session-agent/${encodeURIComponent(id)}/stream`,
      {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ message: "hello" }),
      }
    );
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    const deleted = await SELF.fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(deleted.status).toBe(200);
  });

  it("open nothing on an agent the user is not on", async () => {
    const agentId = await createAgent(someone());
    const res = await startSession(agentId, accessToken(someone("stranger")));
    expect(res.status).toBe(404);
  });

  it("are no Salts login outside the session routes", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const token = accessToken(member);
    for (const path of [
      "/api/agents",
      `/api/agents/${agentId}`,
      `/api/agents/${agentId}/sessions`,
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: bearer(token) });
      expect(res.status, path).toBe(401);
    }
  });

  it("refuse a token issued for another resource", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(
      agentId,
      accessToken(member, { aud: ["https://mcp.example.com/mcp"] })
    );
    expect(res.status).toBe(401);
  });

  it("refuse a token issued to another client", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(
      agentId,
      accessToken(member, { client_id: "https://untrusted.test/client.json" })
    );
    expect(res.status).toBe(401);
  });

  it("refuse a user whose address is not verified", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(agentId, accessToken(member, { test_unverified: true }));
    expect(res.status).toBe(401);
  });
});

/** The keys OpenRouter was called with for requests carrying `marker`. */
async function keysFor(marker: string): Promise<string[]> {
  const res = await fetch(`https://openrouter.ai/__chat-keys?contains=${marker}`);
  return (await res.json()) as string[];
}

const send = (sessionId: string, headers: Record<string, string>, message: string) =>
  SELF.fetch(`${BASE}/agents/session-agent/${encodeURIComponent(sessionId)}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message }),
  });

describe("a caller's own OpenRouter key", () => {
  async function session(auth: Record<string, string>, member: string) {
    const agentId = await createAgent(member);
    const started = await SELF.fetch(`${BASE}/api/agents/${agentId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: "{}",
    });
    return ((await started.json()) as { id: string }).id;
  }

  it("pays for the reply and the title when an app sends one", async () => {
    const member = someone();
    const auth = bearer(accessToken(member));
    const id = await session(auth, member);
    const marker = `m-${crypto.randomUUID()}`;
    const key = `sk-or-own-${crypto.randomUUID()}`;
    const res = await send(id, { ...auth, "x-openrouter-key": key }, marker);
    expect(res.status).toBe(200);
    await res.text();
    // The reply, and the title call made from the opening exchange once the turn is over.
    await expect.poll(() => keysFor(marker).then((k) => k.length)).toBeGreaterThanOrEqual(2);
    expect(new Set(await keysFor(marker))).toEqual(new Set([key]));
  });

  it("works the same from a Salts login", async () => {
    const member = someone();
    const id = await session(signedIn(member), member);
    const marker = `m-${crypto.randomUUID()}`;
    const res = await send(id, { ...signedIn(member), "x-openrouter-key": "sk-or-mine" }, marker);
    await res.text();
    await expect.poll(() => keysFor(marker).then((k) => k.length)).toBeGreaterThanOrEqual(1);
    expect(new Set(await keysFor(marker))).toEqual(new Set(["sk-or-mine"]));
  });

  it("leaves the agent's key in use without one, and lasts one turn only", async () => {
    const member = someone();
    const auth = bearer(accessToken(member));
    const id = await session(auth, member);
    const first = await send(id, { ...auth, "x-openrouter-key": "sk-or-once" }, "hi");
    await first.text();

    const marker = `m-${crypto.randomUUID()}`;
    const res = await send(id, auth, marker);
    expect(res.status).toBe(200);
    await res.text();
    await expect.poll(() => keysFor(marker).then((k) => k.length)).toBeGreaterThanOrEqual(1);
    expect(new Set(await keysFor(marker))).toEqual(new Set(["sk-fake-but-valid"]));
  });
});

describe("a caller's choice of MCP servers", () => {
  /** An agent with two ready servers, as an app offering one per language would set up. */
  async function twoServers() {
    const member = someone();
    const agentId = await createAgent(member);
    const reg = env.SessionRegistry.get(env.SessionRegistry.idFromName(agentId));
    for (const name of ["Dev3Pack", "Dev3Pack Spanish"]) {
      await reg.addMcpServer({
        ...EMPTY_MCP_SERVER,
        id: crypto.randomUUID(),
        name,
        url: "https://mcp.test/",
        enabled: 1,
        tools_json: JSON.stringify([{ name: "search_documents", description: "Search." }]),
        created_at: Date.now(),
      });
    }
    const id = await (async () => {
      const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signedIn(member) },
        body: "{}",
      });
      return ((await res.json()) as { id: string }).id;
    })();
    return { member, id };
  }

  /** Which of the two servers' tools the model was offered for the turn carrying `marker`. */
  async function offered(marker: string): Promise<string[]> {
    const bodies = (await (
      await fetch(`https://openrouter.ai/__requests?contains=${marker}`)
    ).json()) as { stream?: boolean; tools?: unknown[] }[];
    const tools = JSON.stringify(bodies.find((b) => b.stream)?.tools ?? []);
    return ["[Dev3Pack]", "[Dev3Pack Spanish]"].filter((tag) => tools.includes(tag));
  }

  async function turn(headers: Record<string, string>) {
    const { member, id } = await twoServers();
    const marker = `m-${crypto.randomUUID()}`;
    const res = await send(id, { ...signedIn(member), ...headers }, marker);
    expect(res.status).toBe(200);
    await res.text();
    return await offered(marker);
  }

  it("offers every enabled server without the header", async () => {
    expect(await turn({})).toEqual(["[Dev3Pack]", "[Dev3Pack Spanish]"]);
  });

  it("offers only the one named, in any case", async () => {
    expect(await turn({ "x-mcp-servers": "dev3pack spanish" })).toEqual(["[Dev3Pack Spanish]"]);
    expect(await turn({ "x-mcp-servers": "Dev3Pack" })).toEqual(["[Dev3Pack]"]);
  });

  it("offers none when it names none of them", async () => {
    expect(await turn({ "x-mcp-servers": "Elsewhere" })).toEqual([]);
  });

  it("lasts one turn", async () => {
    const { member, id } = await twoServers();
    const first = await send(id, { ...signedIn(member), "x-mcp-servers": "Dev3Pack" }, "hi");
    await first.text();
    const marker = `m-${crypto.randomUUID()}`;
    await (await send(id, signedIn(member), marker)).text();
    expect(await offered(marker)).toEqual(["[Dev3Pack]", "[Dev3Pack Spanish]"]);
  });
});
