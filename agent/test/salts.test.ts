import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * salts-tools computers over HTTP: pairing in the browser, then everything else from the
 * CLI with the computer's credential — the owner's agents, the tools on for each, what is
 * left to do — and each served agent's side kept in step.
 */

const BASE = "https://worker.test";
const GATEWAY = "g".repeat(48);
const TUNNEL = "https://mcp.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedIn(email),
      ...(init.headers as object),
    },
  };
}

const post = (path: string, body: unknown) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A request from the CLI, with the computer's credential. */
const cli = (credential: string, path: string, method = "GET", body?: unknown) =>
  SELF.fetch(`${BASE}/salts/computer${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function createAgent(email: string, name = "Test Agent") {
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(email, { method: "POST", body: JSON.stringify({ name, allowed_emails: email }) })
  );
  return ((await res.json()) as { id: string }).id;
}

/** What a computer running every tool reports. */
const TOOLS = {
  web: { kind: "searxng", state: "ready", needs: ["cap_web_search"] },
  matchmaker: {
    kind: "mcp",
    state: "ready",
    headers: ["X-OpenRouter-Api-Key"],
    needs: ["cap_mcp"],
  },
  analyst: {
    kind: "mcp",
    state: "missing",
    detail: "install uv",
    needs: ["cap_mcp", "cap_file_ingest"],
  },
};

/** Pair a computer for `email`, optionally serving `agents` at once; its credential. */
async function pair(email: string, agents: string[] = []) {
  const start = (await (await post("/salts/pair", { name: "MacBook" })).json()) as {
    user_code: string;
    device_code: string;
  };
  expect(start.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await (await post("/salts/pair/poll", { device_code: start.device_code })).json()).toEqual(
    { status: "pending" }
  );
  const seen = await SELF.fetch(`${BASE}/api/salts/pair/${start.user_code}`, as(email));
  expect(await seen.json()).toEqual({ name: "MacBook", approved: false });
  const approved = await SELF.fetch(
    `${BASE}/api/salts/pair/${start.user_code}`,
    as(email, { method: "POST", body: JSON.stringify({ agent_ids: agents }) })
  );
  expect(approved.status).toBe(200);
  const polled = (await (
    await post("/salts/pair/poll", { device_code: start.device_code })
  ).json()) as { status: string; credential: string };
  expect(polled.status).toBe("approved");
  return { credential: polled.credential, start };
}

const report = (credential: string, body: Record<string, unknown> = {}) =>
  cli(credential, "", "PUT", {
    tunnel_url: TUNNEL,
    gateway_token: GATEWAY,
    tools: TOOLS,
    version: "3.1.0",
    ...body,
  });

type AgentView = {
  id: string;
  name: string;
  linked: boolean;
  tools: string[];
  todos: { kind: string; tool: string; flag?: string; headers?: string[] }[];
};

async function agents(credential: string): Promise<AgentView[]> {
  return ((await (await cli(credential, "/agents")).json()) as { agents: AgentView[] }).agents;
}

const setTools = (credential: string, agentId: string, tools: string[]) =>
  cli(credential, `/agents/${agentId}`, "PUT", { tools });

async function config(email: string, agentId: string) {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/config`, as(email));
  return ((await res.json()) as { config: Record<string, unknown> }).config;
}

type Server = { id: string; name: string; url: string; headers: Record<string, string> };
async function servers(email: string, agentId: string): Promise<Server[]> {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/mcp`, as(email));
  return ((await res.json()) as { servers: Server[] }).servers;
}

/** A paired, reporting computer, and one agent of its owner it does not serve yet. */
async function setup() {
  const email = someone();
  const agentId = await createAgent(email);
  const { credential } = await pair(email);
  expect((await report(credential)).status).toBe(200);
  return { email, agentId, credential };
}

describe("pairing a computer", () => {
  it("hands the credential over once, then forgets the pairing", async () => {
    const { start } = await pair(someone());
    expect(
      await (await post("/salts/pair/poll", { device_code: start.device_code })).json()
    ).toEqual({ status: "gone" });
  });

  it("can serve agents chosen while approving, but refuses one the approver cannot use", async () => {
    const email = someone();
    const mine = await createAgent(email);
    const { credential } = await pair(email, [mine]);
    expect((await agents(credential)).find((a) => a.id === mine)?.linked).toBe(true);

    const theirs = await createAgent(someone("other"));
    const start = (await (await post("/salts/pair", { name: "X" })).json()) as {
      user_code: string;
    };
    const res = await SELF.fetch(
      `${BASE}/api/salts/pair/${start.user_code}`,
      as(email, { method: "POST", body: JSON.stringify({ agent_ids: [theirs] }) })
    );
    expect(res.status).toBe(404);
  });

  it("needs a signed-in user to see or approve a code", async () => {
    const start = (await (await post("/salts/pair", { name: "X" })).json()) as {
      user_code: string;
    };
    expect((await SELF.fetch(`${BASE}/api/salts/pair/${start.user_code}`)).status).toBe(401);
  });

  it("refuses the CLI with no or a made-up credential", async () => {
    expect((await report("")).status).toBe(401);
    expect((await report(`salts_c_${"a".repeat(12)}_${"b".repeat(64)}`)).status).toBe(401);
    expect((await cli("", "/agents")).status).toBe(401);
  });
});

describe("managing agents from the CLI", () => {
  it("lists the owner's agents, none served yet", async () => {
    const { agentId, credential } = await setup();
    expect(await agents(credential)).toEqual([
      { id: agentId, name: "Test Agent", linked: false, tools: [], todos: [] },
    ]);
    const body = (await (await report(credential)).json()) as { wanted: string[] };
    expect(body.wanted).toEqual([]);
  });

  it("never lists or serves someone else's agent", async () => {
    const { credential } = await setup();
    const theirs = await createAgent(someone("other"));
    expect((await agents(credential)).some((a) => a.id === theirs)).toBe(false);
    expect((await setTools(credential, theirs, ["web"])).status).toBe(404);
  });

  it("puts web search and an MCP server on the agent when switched on, and the computer runs them", async () => {
    const { email, agentId, credential } = await setup();
    const res = await setTools(credential, agentId, ["web", "matchmaker"]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AgentView).linked).toBe(true);

    expect((await config(email, agentId)).searxng_url).toBe(`${TUNNEL}/web`);
    const [server] = await servers(email, agentId);
    expect(server.name).toBe("matchmaker");
    expect(server.url).toBe(`${TUNNEL}/matchmaker/mcp`);
    expect(server.headers.Authorization).toBe(`Bearer ${GATEWAY}`);
    expect(server.headers["X-OpenRouter-Api-Key"]).toBe("");

    const body = (await (await report(credential)).json()) as { wanted: string[] };
    expect(body.wanted).toEqual(["matchmaker", "web"]);
  });

  it("lists what is left to do, and does it: a capability, a header", async () => {
    const { email, agentId, credential } = await setup();
    await setTools(credential, agentId, ["matchmaker"]);
    const [agent] = await agents(credential);
    expect(agent.todos).toContainEqual({
      kind: "headers",
      tool: "matchmaker",
      headers: ["X-OpenRouter-Api-Key"],
    });

    if (agent.todos.some((t) => t.kind === "capability" && t.flag === "cap_mcp")) {
      const on = await cli(credential, `/agents/${agentId}/capability`, "POST", {
        flag: "cap_mcp",
      });
      expect(on.status).toBe(200);
      expect((await config(email, agentId)).cap_mcp).toBe(1);
    }
    // Only flags a tool on there needs.
    const other = await cli(credential, `/agents/${agentId}/capability`, "POST", {
      flag: "cap_vision",
    });
    expect(other.status).toBe(400);

    const filled = await cli(credential, `/agents/${agentId}/headers`, "PUT", {
      tool: "matchmaker",
      headers: { "X-OpenRouter-Api-Key": "sk-or-test" },
    });
    expect(filled.status).toBe(200);
    expect(JSON.stringify(await filled.json())).not.toContain("sk-or-test");
    expect((await servers(email, agentId))[0].headers["X-OpenRouter-Api-Key"]).toBe("sk-or-test");
    expect((await agents(credential))[0].todos.some((t) => t.kind === "headers")).toBe(false);

    // Never Authorization, or a header the tool did not ask for.
    for (const headers of [{ Authorization: "Bearer x" }, { "X-Other": "y" }]) {
      const res = await cli(credential, `/agents/${agentId}/headers`, "PUT", {
        tool: "matchmaker",
        headers,
      });
      expect(res.status).toBe(400);
    }
  });

  it("repoints everything when the tunnel moves, and keeps it while a new one opens", async () => {
    const { email, agentId, credential } = await setup();
    await setTools(credential, agentId, ["web", "matchmaker"]);
    await report(credential, { tunnel_url: "https://mcp.test/moved" });
    expect((await config(email, agentId)).searxng_url).toBe("https://mcp.test/moved/web");
    expect((await servers(email, agentId))[0].url).toBe("https://mcp.test/moved/matchmaker/mcp");
    await report(credential, { tunnel_url: "" });
    expect((await config(email, agentId)).searxng_url).toBe("https://mcp.test/moved/web");
  });

  it("takes a tool back out when it is switched off", async () => {
    const { email, agentId, credential } = await setup();
    await setTools(credential, agentId, ["web", "matchmaker"]);
    await setTools(credential, agentId, []);
    expect((await config(email, agentId)).searxng_url).toBe("");
    expect(await servers(email, agentId)).toEqual([]);
  });

  it("never touches a server of the same name set up some other way", async () => {
    const { email, agentId, credential } = await setup();
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp`,
      as(email, {
        method: "POST",
        body: JSON.stringify({ name: "matchmaker", url: "https://mcp.test/mine", auth: "none" }),
      })
    );
    await setTools(credential, agentId, ["matchmaker"]);
    expect((await servers(email, agentId))[0].url).toBe("https://mcp.test/mine");
    expect((await agents(credential))[0].todos.map((t) => t.kind)).toContain("name_taken");
  });

  it("switches the tool off when the user removes its server, so it stays removed", async () => {
    const { email, agentId, credential } = await setup();
    await setTools(credential, agentId, ["matchmaker"]);
    const [server] = await servers(email, agentId);
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
      as(email, { method: "DELETE" })
    );
    await report(credential);
    expect(await servers(email, agentId)).toEqual([]);
    expect((await agents(credential))[0].tools).toEqual([]);
  });

  it("stops serving an agent and cleans it up; unpairing revokes the credential", async () => {
    const { email, agentId, credential } = await setup();
    await setTools(credential, agentId, ["web", "matchmaker"]);
    const unlinked = await cli(credential, `/agents/${agentId}`, "DELETE");
    expect(unlinked.status).toBe(200);
    expect(((await unlinked.json()) as AgentView).linked).toBe(false);
    expect((await config(email, agentId)).searxng_url).toBe("");
    expect(await servers(email, agentId)).toEqual([]);

    await setTools(credential, agentId, ["web"]);
    expect((await cli(credential, "", "DELETE")).status).toBe(200);
    expect((await config(email, agentId)).searxng_url).toBe("");
    expect((await report(credential)).status).toBe(401);
  });

  it("refuses a report of tools it cannot use", async () => {
    const { credential } = await setup();
    const bad = (tools: unknown) => report(credential, { tools });
    expect((await bad({ "Bad Name": { kind: "mcp", state: "ready" } })).status).toBe(400);
    expect((await bad({ x: { kind: "mcp", state: "ready", needs: ["nope"] } })).status).toBe(400);
    expect((await report(credential, { tunnel_url: "http://plain.test" })).status).toBe(400);
  });
});

describe("pairing a computer that already served an agent", () => {
  it("adopts what its gateway token set up there, keeping headers the user filled in", async () => {
    const email = someone();
    const agentId = await createAgent(email);
    // What salts-tools set up before pairing existed: the token as the SearXNG token and
    // as the matchmaker's bearer, with the user's key filled in.
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/config`,
      as(email, { method: "PATCH", body: JSON.stringify({ searxng_token: GATEWAY }) })
    );
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "matchmaker",
          url: "https://mcp.test/old/matchmaker/mcp",
          auth: "headers",
          headers: { Authorization: `Bearer ${GATEWAY}`, "X-OpenRouter-Api-Key": "sk-or-mine" },
        }),
      })
    );

    const { credential } = await pair(email, [agentId]);
    const body = (await (await report(credential)).json()) as { agents: { tools: string[] }[] };
    expect(body.agents[0].tools).toEqual(["matchmaker", "web"]);

    const [server] = await servers(email, agentId);
    expect(server.url).toBe(`${TUNNEL}/matchmaker/mcp`);
    expect(server.headers["X-OpenRouter-Api-Key"]).toBe("sk-or-mine");
    expect((await config(email, agentId)).searxng_url).toBe(`${TUNNEL}/web`);
  });
});
