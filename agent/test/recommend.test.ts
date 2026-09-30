import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INVENTED_TOOL, MCP_KEPT, MCP_TOOLS } from "./openrouter-mock";
import { signedIn } from "./clerk";

/**
 * Letting the model choose which of a server's tools stay switched on.
 *
 * The cost this exists for is not the tools that get called. A connected server's whole
 * schema sits in front of every request of every turn, so forty tools nobody reaches
 * for are still forty tools the agent pays for on every message. The switches to cut
 * that were already here; what this adds is a button that reads the descriptions.
 *
 * Two things it must never do: trust a name the server does not advertise, and read an
 * answer it could not parse as "keep none of them".
 */

const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedIn(email),
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

type Server = {
  id: string;
  name: string;
  tools: { name: string }[];
  disabled_tools: string[];
  last_error: string;
};

/** An agent with one connected MCP server, whose tools the stand-in has listed. */
async function withServer(name = "Notes", path = "/", patch: Record<string, unknown> = {}) {
  const email = someone("member");
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

  if (Object.keys(patch).length > 0) {
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/config`,
      as(email, { method: "PATCH", body: JSON.stringify(patch) })
    );
  }

  const created = (await (
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/mcp`,
      as(email, {
        method: "POST",
        body: JSON.stringify({ name, url: `https://mcp.test${path}` }),
      })
    )
  ).json()) as { server: Server };

  return { email, agentId: agent.id, server: created.server };
}

const recommend = (agentId: string, email: string, id: string) =>
  SELF.fetch(
    `${BASE}/api/agents/${agentId}/mcp/${id}/recommend`,
    as(email, { method: "POST", body: "{}" })
  );

describe("the MCP server stand-in", () => {
  it("lists its tools when a server is added", async () => {
    const { server } = await withServer();
    expect(server.last_error).toBe("");
    expect(server.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    // Nothing is switched off until something switches it off — the column holds the
    // exclusions, so a server arrives with every tool it offers in play.
    expect(server.disabled_tools).toEqual([]);
  });
});

describe("POST /mcp/:id/recommend", () => {
  it("switches off the tools the model did not keep", async () => {
    const { agentId, email, server } = await withServer();
    const res = await recommend(agentId, email, server.id);
    expect(res.status).toBe(200);

    const { server: chosen } = (await res.json()) as { server: Server };
    // The stand-in keeps everything whose name does not say `admin`, so those two are
    // what should have come off — and the tool list itself is untouched.
    expect(chosen.disabled_tools.sort()).toEqual(["admin_audit_log", "admin_list_users"]);
    expect(chosen.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
  });

  it("drops a name the server never advertised", async () => {
    // The stand-in always names one tool that does not exist. Written into the column
    // it would be an exclusion matching nothing; taken as a keep it would be harmless
    // — but a model that invented a name instead of a real one would silently switch
    // the real one off, which is the failure this guards.
    const { agentId, email, server } = await withServer();
    const { server: chosen } = (await (await recommend(agentId, email, server.id)).json()) as {
      server: Server;
    };
    expect(chosen.disabled_tools).not.toContain(INVENTED_TOOL);
    expect(chosen.tools.map((t) => t.name)).not.toContain(INVENTED_TOOL);
    expect(MCP_KEPT.every((name) => !chosen.disabled_tools.includes(name))).toBe(true);
  });

  it("sends the agent's own instructions to choose by", async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const { agentId, email, server } = await withServer("Notes", "/", {
      system_prompt: `You keep the team's notes. ${token}`,
    });
    await recommend(agentId, email, server.id);

    const asked = (await (
      await fetch(`https://openrouter.ai/__requests?contains=${token}`)
    ).json()) as { messages?: { role: string; content?: string }[] }[];
    const sent = asked.find((b) =>
      (b.messages ?? []).some((m) => m.role === "system" && m.content?.includes("MCP server"))
    );
    expect(sent).toBeDefined();
    const user = sent!.messages!.find((m) => m.role === "user")!.content!;
    // What it is choosing for, and what it is choosing between.
    expect(user).toContain(token);
    expect(user).toContain("search_pages");
    expect(user).toContain("Search every page in the workspace by text.");
  });

  it("leaves the switches alone when the answer cannot be read", async () => {
    // A server named `nonsense` makes the stand-in answer in prose. Nothing parseable
    // came back, so nothing is written: an unreadable answer must not read as an empty
    // keep list, which would switch every tool off at once.
    const { agentId, email, server } = await withServer("nonsense notes");
    const res = await recommend(agentId, email, server.id);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("did not name");

    const { servers } = (await (
      await SELF.fetch(`${BASE}/api/agents/${agentId}/mcp`, as(email))
    ).json()) as { servers: Server[] };
    expect(servers[0].disabled_tools).toEqual([]);
  });

  it("asks for a refresh when the server has listed nothing", async () => {
    const { agentId, email, server } = await withServer("Empty", "/empty");
    expect(server.tools).toEqual([]);
    const res = await recommend(agentId, email, server.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Refresh");
  });

  it("says so when the agent has no OpenRouter key", async () => {
    const { agentId, email, server } = await withServer("Notes", "/", {
      openrouter_api_key: "",
    });
    const res = await recommend(agentId, email, server.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("API key");
  });

  it("404s on a server this agent does not have", async () => {
    const { agentId, email } = await withServer();
    expect((await recommend(agentId, email, "nope")).status).toBe(404);
  });
});
