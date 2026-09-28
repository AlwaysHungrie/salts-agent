import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SHIPPED } from "./shipped";

const DEFAULT_AGENT_LIMIT = SHIPPED.default_agent_limit;

/**
 * The Worker over HTTP — the same surface the browser and the CLI reach.
 *
 * These are the tests that say the pieces are wired together: a route exists, it is
 * gated by the right check, and the gate fails closed. Clerk cannot sign a token in a
 * test, so callers here are identified through the documented back door — `API_SECRET`
 * plus `x-user-email` — which is the same code path `callerEmail` takes in production
 * when there is no verified token. Tests that assert a *refusal* deliberately send no
 * secret, so they exercise the anonymous case rather than a privileged one.
 */

const SECRET = env.API_SECRET as string;
const BASE = "https://worker.test";

/**
 * A fresh account for one test.
 *
 * The pool no longer rolls storage back between tests, and the directory is a single
 * deployment-wide object, so an address used twice carries the first test's agents
 * into the second — and `DEFAULT_AGENT_LIMIT` is 1, so the second test's create would
 * be refused for reasons that have nothing to do with what it is asserting. A unique
 * address per test removes the coupling entirely.
 */
function someone(label = "user") {
  return `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;
}

/** A request from a signed-in person, via the back door that stands in for Clerk. */
function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-secret": SECRET,
      "x-user-email": email,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

/** A request from the deployment owner: the secret, and nobody's address. */
function asOwner(init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-secret": SECRET,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

async function createAgent(email: string, name = "Test Agent") {
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(email, { method: "POST", body: JSON.stringify({ name, allowed_emails: email }) })
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("worker basics", () => {
  it("answers the root with its route listing", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect((await res.json() as { routes: unknown }).routes).toBeTruthy();
  });

  it("404s an unknown path", async () => {
    const res = await SELF.fetch(`${BASE}/no/such/route`);
    expect(res.status).toBe(404);
  });

  it("answers a CORS preflight", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents`, { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("sets CORS headers on an ordinary response", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});

describe("the identity gate", () => {
  it("refuses an anonymous caller on the admin switch", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/business-account`, {
      method: "POST",
      body: JSON.stringify({ email: "a@x.com", agent_limit: 5 }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a wrong secret on the admin switch", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/business-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-secret": "not-the-secret" },
      body: JSON.stringify({ email: "a@x.com", agent_limit: 5 }),
    });
    // The comparison is against the configured value, so a near-miss is a miss.
    expect(res.status).toBe(401);
  });

  it("ignores x-user-email from a caller with no secret", async () => {
    // This is the header's whole risk: it names anybody. Without the secret it must
    // carry no weight at all, so a caller claiming an address is simply nobody — and
    // the agent list refuses nobody outright rather than answering with an empty one.
    const owner = someone("owner");
    await createAgent(owner, "Private");
    const res = await SELF.fetch(`${BASE}/api/agents`, {
      headers: { "x-user-email": owner },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Private");
  });

  it("refuses an anonymous caller on the owner's stats", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/stats`)).status).toBe(401);
  });

  it("refuses an anonymous caller on the owner's user list", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/users`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/admin/users/a%40x.com`)).status).toBe(401);
  });

  it("refuses an anonymous caller on the owner's request queue", async () => {
    expect((await SELF.fetch(`${BASE}/api/admin/business-requests`)).status).toBe(401);
  });

  it("refuses an unsigned caller filing a business request", async () => {
    const res = await SELF.fetch(`${BASE}/api/business-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ increase: 5 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("creating an agent", () => {
  it("creates one and returns its id", async () => {
    const { res, body } = await createAgent(someone("owner"));
    expect(res.status).toBe(200);
    expect(body.id).toBeTruthy();
  });

  it("lists the agent back to its creator", async () => {
    const owner = someone("owner");
    await createAgent(owner, "Mine");
    const res = await SELF.fetch(`${BASE}/api/agents`, as(owner));
    const body = (await res.json()) as { agents: { name: string }[] };
    expect(body.agents.map((a) => a.name)).toContain("Mine");
  });

  it("does not list it to anyone else", async () => {
    await createAgent(someone("owner"), "Mine");
    const res = await SELF.fetch(`${BASE}/api/agents`, as(someone("stranger")));
    expect((await res.json() as { agents: unknown[] }).agents).toEqual([]);
  });

  it("refuses an agent with nobody on its access list", async () => {
    // An agent nobody is on is one nobody can reach, including to delete it.
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      as(someone("owner"), {
        method: "POST",
        body: JSON.stringify({ name: "Orphan", allowed_emails: "" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("refuses a list made only of things that are not addresses", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      as(someone("owner"), {
        method: "POST",
        body: JSON.stringify({ name: "Orphan", allowed_emails: "please add bob" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("reports the caller's ceiling and usage on the list", async () => {
    const owner = someone("owner");
    await createAgent(owner);
    const res = await SELF.fetch(`${BASE}/api/agents`, as(owner));
    const body = (await res.json()) as { agent_limit: number; agents_owned: number };
    expect(body.agent_limit).toBe(DEFAULT_AGENT_LIMIT);
    expect(body.agents_owned).toBe(1);
  });
});

describe("the agent ceiling", () => {
  it("refuses a second agent on the default limit", async () => {
    const capped = someone("capped");
    await createAgent(capped);
    const { res } = await createAgent(capped, "Second");
    // `DEFAULT_AGENT_LIMIT` is 1, so the second is the one that must be refused.
    expect(res.status).toBe(403);
  });

  it("allows more once the owner raises the ceiling", async () => {
    const biz = someone("biz");
    await createAgent(biz);
    const raised = await SELF.fetch(
      `${BASE}/api/admin/business-account`,
      asOwner({ method: "POST", body: JSON.stringify({ email: biz, agent_limit: 3 }) })
    );
    expect(raised.status).toBe(200);
    expect((await createAgent(biz, "Second")).res.status).toBe(200);
    expect((await createAgent(biz, "Third")).res.status).toBe(200);
    expect((await createAgent(biz, "Fourth")).res.status).toBe(403);
  });

  it("frees a slot when an agent is deleted", async () => {
    const recycler = someone("recycler");
    const { body } = await createAgent(recycler);
    const deleted = await SELF.fetch(
      `${BASE}/api/agents/${body.id}`,
      as(recycler, { method: "DELETE" })
    );
    expect(deleted.status).toBe(200);
    expect((await createAgent(recycler, "Replacement")).res.status).toBe(200);
  });

  it("counts against the admin, not against people merely on the list", async () => {
    const guest = someone("guest");
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(someone("admin"), {
        method: "POST",
        body: JSON.stringify({ name: "Shared", allowed_emails: guest }),
      })
    );
    // The guest administers nothing, so their own ceiling is untouched by being
    // added to somebody else's agent.
    expect((await createAgent(guest, "Their own")).res.status).toBe(200);
  });

  it("charges a whole fleet against the ceiling at once", async () => {
    const fleetAdmin = someone("fleet");
    await SELF.fetch(
      `${BASE}/api/admin/business-account`,
      asOwner({ method: "POST", body: JSON.stringify({ email: fleetAdmin, agent_limit: 2 }) })
    );
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      as(fleetAdmin, {
        method: "POST",
        body: JSON.stringify({
          name: "Fleet",
          fleet_name: "Team",
          allowed_emails: `${someone("a")},${someone("b")},${someone("c")}`,
        }),
      })
    );
    // Three agents against a ceiling of two: half a fleet is not what was asked for.
    expect(res.status).toBe(403);
  });
});

describe("the owner's admin switch", () => {
  it("sets a ceiling and echoes it", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/admin/business-account`,
      asOwner({ method: "POST", body: JSON.stringify({ email: "Biz@X.com", agent_limit: 9 }) })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "biz@x.com", agent_limit: 9 });
  });

  it("refuses a limit that is not a positive integer", async () => {
    for (const agent_limit of [0, -1, 1.5, "many", null]) {
      const res = await SELF.fetch(
        `${BASE}/api/admin/business-account`,
        asOwner({ method: "POST", body: JSON.stringify({ email: "biz@x.com", agent_limit }) })
      );
      expect(res.status).toBe(400);
    }
  });

  it("refuses a missing email", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/admin/business-account`,
      asOwner({ method: "POST", body: JSON.stringify({ agent_limit: 5 }) })
    );
    expect(res.status).toBe(400);
  });

  it("refuses a method other than POST", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/business-account`, asOwner({ method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("survives a body that is not JSON", async () => {
    const res = await SELF.fetch(
      `${BASE}/api/admin/business-account`,
      asOwner({ method: "POST", body: "not json at all" })
    );
    // A 400 is the answer; a 500 would mean the parse escaped.
    expect(res.status).toBe(400);
  });

  it("reports deployment counts", async () => {
    await createAgent(someone("counted"));
    const res = await SELF.fetch(`${BASE}/api/admin/stats`, asOwner());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: number };
    expect(body.agents).toBeGreaterThanOrEqual(1);
  });
});

describe("users over HTTP", () => {
  it("finds a user by search and opens their agents", async () => {
    const email = someone("listed");
    await createAgent(email, "Listed Agent");
    const list = await SELF.fetch(
      `${BASE}/api/admin/users?q=${encodeURIComponent(email)}`,
      asOwner()
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as { users: { email: string }[] }).users).toEqual([
      { email, agents: 1 },
    ]);
    const detail = await SELF.fetch(
      `${BASE}/api/admin/users/${encodeURIComponent(email)}`,
      asOwner()
    );
    const body = (await detail.json()) as {
      agent_limit: number;
      agents: { name: string; role: string }[];
    };
    expect(body.agent_limit).toBe(DEFAULT_AGENT_LIMIT);
    expect(body.agents.map((a) => [a.name, a.role])).toEqual([["Listed Agent", "admin"]]);
  });
});

describe("business requests over HTTP", () => {
  it("lets a signed-in caller file one", async () => {
    const asker = someone("asker");
    const res = await SELF.fetch(
      `${BASE}/api/business-requests`,
      as(asker, { method: "POST", body: JSON.stringify({ increase: 5 }) })
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { email: string }).email).toBe(asker);
  });

  it("refuses an increase that is not a positive integer", async () => {
    for (const increase of [0, -2, 2.5, "lots"]) {
      const res = await SELF.fetch(
        `${BASE}/api/business-requests`,
        as(someone("asker"), { method: "POST", body: JSON.stringify({ increase }) })
      );
      expect(res.status).toBe(400);
    }
  });

  it("refuses a method other than POST", async () => {
    const res = await SELF.fetch(`${BASE}/api/business-requests`, as(someone("asker")));
    expect(res.status).toBe(405);
  });

  it("shows the filed request in the owner's queue", async () => {
    const queued = someone("queued");
    await SELF.fetch(
      `${BASE}/api/business-requests`,
      as(queued, { method: "POST", body: JSON.stringify({ increase: 4 }) })
    );
    const res = await SELF.fetch(`${BASE}/api/admin/business-requests`, asOwner());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: { email: string }[] };
    expect(body.requests.some((r) => r.email === queued)).toBe(true);
  });

  it("approving raises the account's ceiling", async () => {
    const grantee = someone("grantee");
    const filed = await SELF.fetch(
      `${BASE}/api/business-requests`,
      as(grantee, { method: "POST", body: JSON.stringify({ increase: 3 }) })
    );
    const { id } = (await filed.json()) as { id: string };

    const approved = await SELF.fetch(
      `${BASE}/api/admin/business-requests/${id}/approve`,
      asOwner({ method: "POST" })
    );
    expect(approved.status).toBe(200);

    // Observable where it matters: the account can now make more agents.
    await createAgent(grantee, "One");
    expect((await createAgent(grantee, "Two")).res.status).toBe(200);
  });

  it("refuses an anonymous caller trying to approve", async () => {
    const filed = await SELF.fetch(
      `${BASE}/api/business-requests`,
      as(someone("target"), { method: "POST", body: JSON.stringify({ increase: 3 }) })
    );
    const { id } = (await filed.json()) as { id: string };
    const res = await SELF.fetch(`${BASE}/api/admin/business-requests/${id}/approve`, {
      method: "POST",
    });
    // The whole point of the queue: filing is open, granting is not.
    expect(res.status).toBe(401);
  });
});

describe("agent access control", () => {
  it("lets a member read the agent's settings", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    const res = await SELF.fetch(`${BASE}/api/agents/${body.id}/config`, as(member));
    expect(res.status).toBe(200);
  });

  it("hides the settings from an address not on the list", async () => {
    const { body } = await createAgent(someone("member"));
    const res = await SELF.fetch(`${BASE}/api/agents/${body.id}/config`, as(someone("stranger")));
    expect(res.status).toBe(404);
  });

  it("hides the settings from an anonymous caller", async () => {
    const { body } = await createAgent(someone("member"));
    const res = await SELF.fetch(`${BASE}/api/agents/${body.id}/config`);
    // Refused before identity is even resolved, so this is a 401 rather than the 404
    // a signed-in stranger gets.
    expect(res.status).toBe(401);
  });

  it("404s an agent that does not exist", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/nosuchagent/config`, as(someone("anyone")));
    expect(res.status).toBe(404);
  });

  it("never returns a stored secret in the clear", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    await SELF.fetch(
      `${BASE}/api/agents/${body.id}/config`,
      as(member, {
        method: "PATCH",
        body: JSON.stringify({ openrouter_api_key: "sk-secret-value" }),
      })
    );
    const res = await SELF.fetch(`${BASE}/api/agents/${body.id}/config`, as(member));
    const text = await res.text();
    // The key is what every model call is billed to; it goes to the browser masked
    // or not at all.
    expect(text).not.toContain("sk-secret-value");
  });

  it("refuses a model id that is not shaped like one", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    const res = await SELF.fetch(
      `${BASE}/api/agents/${body.id}/config`,
      as(member, { method: "PATCH", body: JSON.stringify({ model: "not a model" }) })
    );
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed model id", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    const res = await SELF.fetch(
      `${BASE}/api/agents/${body.id}/config`,
      as(member, { method: "PATCH", body: JSON.stringify({ model: "vendor/model:free" }) })
    );
    expect(res.status).toBe(200);
  });

  it("stops a stranger deleting an agent", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    const res = await SELF.fetch(
      `${BASE}/api/agents/${body.id}`,
      as(someone("stranger"), { method: "DELETE" })
    );
    expect([403, 404]).toContain(res.status);
    // Still there afterwards, which is the assertion that matters.
    const still = await SELF.fetch(`${BASE}/api/agents/${body.id}/config`, as(member));
    expect(still.status).toBe(200);
  });
});

describe("sessions over HTTP", () => {
  it("creates a session under an agent the caller may open", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    const res = await SELF.fetch(
      `${BASE}/api/agents/${body.id}/sessions`,
      as(member, { method: "POST", body: JSON.stringify({ title: "First chat" }) })
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }).id).toContain(String(body.id));
  });

  it("lists the agent's sessions", async () => {
    const member = someone("member");
    const { body } = await createAgent(member);
    await SELF.fetch(
      `${BASE}/api/agents/${body.id}/sessions`,
      as(member, { method: "POST", body: JSON.stringify({ title: "First chat" }) })
    );
    const res = await SELF.fetch(`${BASE}/api/agents/${body.id}/sessions`, as(member));
    const listed = (await res.json()) as { sessions: { title: string }[] };
    expect(listed.sessions.map((s) => s.title)).toContain("First chat");
  });

  it("refuses a stranger creating a session", async () => {
    const { body } = await createAgent(someone("member"));
    const res = await SELF.fetch(
      `${BASE}/api/agents/${body.id}/sessions`,
      as(someone("stranger"), { method: "POST", body: JSON.stringify({ title: "Intrusion" }) })
    );
    expect(res.status).toBe(404);
  });

  it("refuses a session id that names no agent", async () => {
    // `agentIdOf` returns "" for an id with no separator, and the route has to treat
    // that as "not one of ours" rather than as an agent named "".
    const res = await SELF.fetch(`${BASE}/api/sessions/bogusid`, as(someone("member"), {
      method: "PATCH",
      body: JSON.stringify({ title: "nope" }),
    }));
    expect(res.status).toBe(404);
  });
});

describe("the model catalog", () => {
  it("lists the models this deployment offers", async () => {
    const res = await SELF.fetch(`${BASE}/api/agents/catalog`, as(someone("anyone")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { id: string }[] };
    expect(body.models.length).toBeGreaterThan(0);
  });
});

describe("salts-web repointing the SearXNG URL", () => {
  const TOKEN = "a".repeat(64);

  /** An agent whose SearXNG token is `TOKEN`, and the member who owns it. */
  async function agentWithToken(token = TOKEN) {
    const member = someone("member");
    const { body } = await createAgent(member);
    await SELF.fetch(
      `${BASE}/api/agents/${body.id}/config`,
      as(member, { method: "PATCH", body: JSON.stringify({ searxng_token: token }) })
    );
    return { member, id: body.id as string };
  }

  function repoint(id: string, url: unknown, token?: string) {
    return SELF.fetch(`${BASE}/searxng/${id}/url`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ url }),
    });
  }

  async function storedUrl(member: string, id: string) {
    const res = await SELF.fetch(`${BASE}/api/agents/${id}/config`, as(member));
    return ((await res.json()) as { config: { searxng_url: string } }).config.searxng_url;
  }

  it("sets the URL when the token matches", async () => {
    const { member, id } = await agentWithToken();
    const res = await repoint(id, "https://abc.ngrok-free.app/", TOKEN);
    expect(res.status).toBe(200);
    expect(await storedUrl(member, id)).toBe("https://abc.ngrok-free.app");
  });

  it("refuses a wrong token and leaves the URL alone", async () => {
    const { member, id } = await agentWithToken();
    const res = await repoint(id, "https://evil.example", "b".repeat(64));
    expect(res.status).toBe(401);
    expect(await storedUrl(member, id)).toBe("");
  });

  it("refuses a request with no token", async () => {
    const { id } = await agentWithToken();
    expect((await repoint(id, "https://evil.example")).status).toBe(401);
  });

  it("refuses every token when the agent has none set", async () => {
    const { id } = await agentWithToken("");
    expect((await repoint(id, "https://evil.example", "")).status).toBe(401);
    expect((await repoint(id, "https://evil.example", "anything")).status).toBe(401);
  });

  it("refuses an agent that does not exist", async () => {
    expect((await repoint("nosuchagent", "https://x.example", TOKEN)).status).toBe(401);
  });

  it("refuses a URL that is not http(s)", async () => {
    const { id } = await agentWithToken();
    expect((await repoint(id, "javascript:alert(1)", TOKEN)).status).toBe(400);
    expect((await repoint(id, "not a url", TOKEN)).status).toBe(400);
  });
});
