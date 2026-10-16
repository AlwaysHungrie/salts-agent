import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * salts-tools computers over HTTP: pairing from the browser, the computer's report, and
 * each linked agent's side kept in step with the tools switched on there.
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

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
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

/** Pair a computer for `email` with `agents`, returning its credential. */
async function pair(email: string, agents: string[]) {
  const start = (await (await post("/salts/pair", { name: "MacBook" })).json()) as {
    user_code: string;
    device_code: string;
  };
  expect(start.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await (await post("/salts/pair/poll", { device_code: start.device_code })).json()).toEqual(
    {
      status: "pending",
    }
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
  ).json()) as {
    status: string;
    credential: string;
  };
  expect(polled.status).toBe("approved");
  return { credential: polled.credential, start };
}

function report(credential: string, body: Record<string, unknown> = {}) {
  return SELF.fetch(`${BASE}/salts/computer`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      tunnel_url: TUNNEL,
      gateway_token: GATEWAY,
      tools: TOOLS,
      version: "3.0.0",
      ...body,
    }),
  });
}

type Page = {
  id: string;
  online: boolean;
  agents: { id: string; tools: string[]; todos: { kind: string; tool: string; flag?: string }[] }[];
};

async function computers(email: string): Promise<Page[]> {
  const res = await SELF.fetch(`${BASE}/api/salts/computers`, as(email));
  return ((await res.json()) as { computers: Page[] }).computers;
}

const setTools = (email: string, computerId: string, agentId: string, tools: string[]) =>
  SELF.fetch(
    `${BASE}/api/salts/computers/${computerId}/agents/${agentId}`,
    as(email, { method: "PUT", body: JSON.stringify({ tools }) })
  );

async function config(email: string, agentId: string) {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/config`, as(email));
  return ((await res.json()) as { config: Record<string, unknown> }).config;
}

type Server = { id: string; name: string; url: string; headers: Record<string, string> };
async function servers(email: string, agentId: string): Promise<Server[]> {
  const res = await SELF.fetch(`${BASE}/api/agents/${agentId}/mcp`, as(email));
  return ((await res.json()) as { servers: Server[] }).servers;
}

/** A paired, reporting computer with one agent linked and nothing on yet. */
async function setup() {
  const email = someone();
  const agentId = await createAgent(email);
  const { credential } = await pair(email, [agentId]);
  expect((await report(credential)).status).toBe(200);
  const [page] = await computers(email);
  return { email, agentId, credential, computerId: page.id };
}

describe("pairing a computer", () => {
  it("hands the credential over once, then forgets the pairing", async () => {
    const email = someone();
    const agentId = await createAgent(email);
    const { start } = await pair(email, [agentId]);
    expect(
      await (await post("/salts/pair/poll", { device_code: start.device_code })).json()
    ).toEqual({
      status: "gone",
    });
  });

  it("refuses an agent the approver cannot use", async () => {
    const theirs = await createAgent(someone("other"));
    const start = (await (await post("/salts/pair", { name: "X" })).json()) as {
      user_code: string;
    };
    const res = await SELF.fetch(
      `${BASE}/api/salts/pair/${start.user_code}`,
      as(someone(), { method: "POST", body: JSON.stringify({ agent_ids: [theirs] }) })
    );
    expect(res.status).toBe(404);
  });

  it("needs a signed-in user to see or approve a code", async () => {
    const start = (await (await post("/salts/pair", { name: "X" })).json()) as {
      user_code: string;
    };
    expect((await SELF.fetch(`${BASE}/api/salts/pair/${start.user_code}`)).status).toBe(401);
  });

  it("refuses a report with no or a made-up credential", async () => {
    expect((await report("")).status).toBe(401);
    expect((await report(`salts_c_${"a".repeat(12)}_${"b".repeat(64)}`)).status).toBe(401);
  });
});

describe("a paired computer", () => {
  it("lists linked agents with nothing on, and is online once it reports", async () => {
    const { email, agentId, credential } = await setup();
    const body = (await (await report(credential)).json()) as {
      agents: { id: string }[];
      wanted: string[];
    };
    expect(body.agents.map((a) => a.id)).toEqual([agentId]);
    expect(body.wanted).toEqual([]);
    const [page] = await computers(email);
    expect(page.online).toBe(true);
    expect(page.agents[0].tools).toEqual([]);
  });

  it("puts web search and an MCP server on the agent when switched on, and the computer is told", async () => {
    const { email, agentId, credential, computerId } = await setup();
    expect((await setTools(email, computerId, agentId, ["web", "matchmaker"])).status).toBe(200);

    const cfg = await config(email, agentId);
    expect(cfg.searxng_url).toBe(`${TUNNEL}/web`);
    const [server] = await servers(email, agentId);
    expect(server.name).toBe("matchmaker");
    expect(server.url).toBe(`${TUNNEL}/matchmaker/mcp`);
    expect(server.headers.Authorization).toBe(`Bearer ${GATEWAY}`);
    expect(server.headers["X-OpenRouter-Api-Key"]).toBe("");

    const body = (await (await report(credential)).json()) as { wanted: string[] };
    expect(body.wanted).toEqual(["matchmaker", "web"]);
  });

  it("lists what is still to do on the agent", async () => {
    const { email, agentId, computerId } = await setup();
    await setTools(email, computerId, agentId, ["matchmaker"]);
    const [page] = await computers(email);
    const kinds = page.agents[0].todos.map((t) => t.kind);
    expect(kinds).toContain("headers");
  });

  it("repoints everything when the tunnel moves", async () => {
    const { email, agentId, credential, computerId } = await setup();
    await setTools(email, computerId, agentId, ["web", "matchmaker"]);
    await report(credential, { tunnel_url: "https://mcp.test/moved" });
    expect((await config(email, agentId)).searxng_url).toBe("https://mcp.test/moved/web");
    expect((await servers(email, agentId))[0].url).toBe("https://mcp.test/moved/matchmaker/mcp");
  });

  it("takes a tool back out when it is switched off", async () => {
    const { email, agentId, computerId } = await setup();
    await setTools(email, computerId, agentId, ["web", "matchmaker"]);
    await setTools(email, computerId, agentId, []);
    expect((await config(email, agentId)).searxng_url).toBe("");
    expect(await servers(email, agentId)).toEqual([]);
  });

  it("never touches a server of the same name set up some other way", async () => {
    const { email, agentId, computerId } = await setup();
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp`,
      as(email, {
        method: "POST",
        body: JSON.stringify({ name: "matchmaker", url: "https://mcp.test/mine", auth: "none" }),
      })
    );
    await setTools(email, computerId, agentId, ["matchmaker"]);
    const [server] = await servers(email, agentId);
    expect(server.url).toBe("https://mcp.test/mine");
    const [page] = await computers(email);
    expect(page.agents[0].todos.map((t) => t.kind)).toContain("name_taken");
  });

  it("switches the tool off when the user removes its server, so it stays removed", async () => {
    const { email, agentId, credential, computerId } = await setup();
    await setTools(email, computerId, agentId, ["matchmaker"]);
    const [server] = await servers(email, agentId);
    await SELF.fetch(
      `${BASE}/api/agents/${agentId}/mcp/${server.id}`,
      as(email, { method: "DELETE" })
    );
    await report(credential);
    expect(await servers(email, agentId)).toEqual([]);
    expect((await computers(email))[0].agents[0].tools).toEqual([]);
  });

  it("unlinking an agent cleans it up; disconnecting revokes the credential", async () => {
    const { email, agentId, credential, computerId } = await setup();
    await setTools(email, computerId, agentId, ["web", "matchmaker"]);
    const unlinked = await SELF.fetch(
      `${BASE}/api/salts/computers/${computerId}/agents/${agentId}`,
      as(email, { method: "DELETE" })
    );
    expect(unlinked.status).toBe(200);
    expect((await config(email, agentId)).searxng_url).toBe("");
    expect(await servers(email, agentId)).toEqual([]);

    await SELF.fetch(`${BASE}/api/salts/computers/${computerId}`, as(email, { method: "DELETE" }));
    expect(await computers(email)).toEqual([]);
    expect((await report(credential)).status).toBe(401);
  });

  it("is invisible to anyone but the person who paired it", async () => {
    const { computerId } = await setup();
    const stranger = someone("stranger");
    expect(await computers(stranger)).toEqual([]);
    const res = await SELF.fetch(`${BASE}/api/salts/computers/${computerId}`, as(stranger));
    expect(res.status).toBe(404);
  });

  it("refuses a report of tools it cannot use", async () => {
    const { credential } = await setup();
    expect(
      (await report(credential, { tools: { "Bad Name": { kind: "mcp", state: "ready" } } })).status
    ).toBe(400);
    expect(
      (await report(credential, { tools: { x: { kind: "mcp", state: "ready", needs: ["nope"] } } }))
        .status
    ).toBe(400);
    expect((await report(credential, { tunnel_url: "http://plain.test" })).status).toBe(400);
  });

  it("keeps the agent pointed at the last tunnel while a new one opens", async () => {
    const { email, agentId, credential, computerId } = await setup();
    await setTools(email, computerId, agentId, ["web"]);
    expect((await report(credential, { tunnel_url: "" })).status).toBe(200);
    expect((await config(email, agentId)).searxng_url).toBe(`${TUNNEL}/web`);
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
