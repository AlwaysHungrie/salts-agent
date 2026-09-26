import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COST_PER_TURN, MCP_TOOLS, replyTo } from "./openrouter-mock";
import { EMPTY_MCP_SERVER, agentIdOf } from "../src/registry";

/**
 * A whole turn, end to end.
 *
 * This is the suite the rest of the tests could not reach: the real `SessionAgent`,
 * the real Think integration, the real AI SDK client, the real transcript and usage
 * writes — with only OpenRouter replaced, by `outboundService` in vitest.config.ts.
 * Nothing in `src/` knows a test is running.
 *
 * What it buys: "the agent answers" stops being something only a human clicking
 * around can confirm. A refactor that breaks the turn loop, loses the transcript,
 * stops banking spend, or swallows a provider error now fails here rather than in
 * production.
 */

const SECRET = env.API_SECRET as string;
const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

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

/** An agent with a session, ready to be talked to. */
async function chatFixture(key = "sk-fake-but-valid") {
  const email = someone("member");
  const agent = (await (
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Agent",
          allowed_emails: email,
          openrouter_api_key: key,
        }),
      })
    )
  ).json()) as { id: string };

  const session = (await (
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/sessions`,
      as(email, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
    )
  ).json()) as { id: string };

  return { email, agentId: agent.id, sessionId: session.id };
}

function say(sessionId: string, email: string, message: string) {
  return SELF.fetch(
    `${BASE}/agents/session-agent/${sessionId}/chat`,
    as(email, { method: "POST", body: JSON.stringify({ message }) })
  );
}

function transcript(sessionId: string, email: string) {
  return SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/messages`, as(email));
}

/** The agent's own registry object, for the state a turn is supposed to have moved. */
const registryFor = (agentId: string) =>
  env.SessionRegistry.get(env.SessionRegistry.idFromName(agentId));

describe("a turn", () => {
  it("answers", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await say(sessionId, email, "hello");
    expect(res.status).toBe(200);
    expect((await res.json() as { reply: string }).reply).toBe(replyTo("hello"));
  });

  it("writes both sides into the transcript", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "hello");
    const body = (await (await transcript(sessionId, email)).json()) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", replyTo("hello")],
    ]);
  });

  it("keeps the transcript across turns, in order", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "first");
    await say(sessionId, email, "second");
    const body = (await (await transcript(sessionId, email)).json()) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages.map((m) => m.content)).toEqual([
      "first",
      replyTo("first"),
      "second",
      replyTo("second"),
    ]);
  });

  it("reports what the turn cost", async () => {
    const { sessionId, email } = await chatFixture();
    const body = (await (await say(sessionId, email, "hello")).json()) as {
      _meta: { request: { cost_usd: number } };
    };
    expect(body._meta.request.cost_usd).toBeCloseTo(COST_PER_TURN);
  });

  it("records token usage against the reply", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "hello");
    const body = (await (await transcript(sessionId, email)).json()) as {
      messages: { role: string; prompt_tokens: number; completion_tokens: number }[];
    };
    const reply = body.messages.find((m) => m.role === "assistant")!;
    expect(reply.prompt_tokens).toBeGreaterThan(0);
    expect(reply.completion_tokens).toBeGreaterThan(0);
  });

  it("banks the cost against the agent's month", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    await say(sessionId, email, "hello");
    // The session spent it; the registry is where "what has this agent spent" lives,
    // and the gate in front of every turn reads it from there.
    expect(await registryFor(agentId).spendThisMonth()).toBeCloseTo(COST_PER_TURN);
  });

  it("accumulates spend across turns", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    await say(sessionId, email, "one");
    await say(sessionId, email, "two");
    expect(await registryFor(agentId).spendThisMonth()).toBeCloseTo(COST_PER_TURN * 2);
  });

  it("keeps two agents' spend apart", async () => {
    const first = await chatFixture();
    const second = await chatFixture();
    await say(first.sessionId, first.email, "hello");
    expect(await registryFor(first.agentId).spendThisMonth()).toBeCloseTo(COST_PER_TURN);
    expect(await registryFor(second.agentId).spendThisMonth()).toBe(0);
  });

  it("names the session from the first exchange", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    await say(sessionId, email, "hello");
    // The title is a second, non-streamed model call; that it happens at all is the
    // thing worth pinning, since nothing else would notice if it stopped.
    const session = await registryFor(agentId).get(sessionId);
    expect(session?.title).toBeTruthy();
  });
});

describe("tools inside a turn", () => {
  it("runs a tool the model calls and answers with its result", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await say(sessionId, email, "!!toolcall please list the workspace");
    expect(res.status).toBe(200);
    // Two legs: the model asks for `list`, the agent runs it, the model answers. A
    // break anywhere in that chain shows up as the wrong reply here.
    expect((await res.json() as { reply: string }).reply).toBe("I listed the workspace.");
  });

  it("records the tool step on the reply", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "!!toolcall list it");
    const body = (await (await transcript(sessionId, email)).json()) as {
      messages: { role: string; steps: string }[];
    };
    const reply = body.messages.find((m) => m.role === "assistant")!;
    expect(reply.steps).toContain("list");
  });
});

describe("when the provider fails", () => {
  it("does not crash the request on a 500", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await say(sessionId, email, "!!fail500 hello");
    // The turn failed; the request must not. A 500 from here would take the chat page
    // down rather than showing the person what happened.
    expect(res.status).toBe(200);
  });

  it("does not bank spend for a turn that failed", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    await say(sessionId, email, "!!fail500 hello");
    expect(await registryFor(agentId).spendThisMonth()).toBe(0);
  });

  it("does not crash the request on a rejected key", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await say(sessionId, email, "!!fail401 hello");
    expect(res.status).toBe(200);
  });

  it("still answers after a failed turn", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "!!fail500 hello");
    // The session must not be wedged by one bad turn.
    const res = await say(sessionId, email, "hello");
    expect((await res.json() as { reply: string }).reply).toBe(replyTo("hello"));
  });
});

describe("the spending limit", () => {
  it("answers normally when there is no limit", async () => {
    const { sessionId, email } = await chatFixture();
    expect((await (await say(sessionId, email, "hi")).json() as { reply: string }).reply).toBe(
      replyTo("hi")
    );
  });

  it("refuses a turn once the month's limit is reached", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    const registry = registryFor(agentId);
    await registry.setMeta({ ...(await registry.meta()), monthly_spend_limit: 0.001 });
    await registry.addSpend(0.002);

    const reply = (await (await say(sessionId, email, "hello")).json() as { reply: string }).reply;
    // Said in words the person can act on, rather than a silent failure or a 402.
    expect(reply).toContain("spending limit");
  });

  it("does not call the provider once the limit is reached", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    const registry = registryFor(agentId);
    await registry.setMeta({ ...(await registry.meta()), monthly_spend_limit: 0.001 });
    await registry.addSpend(0.002);
    await say(sessionId, email, "hello");
    // The gate is in front of the call, so the total is untouched by the refused turn.
    expect(await registry.spendThisMonth()).toBeCloseTo(0.002);
  });
});

describe("bang commands over chat", () => {
  it("starts a new session with !new", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "hello");
    const res = await say(sessionId, email, "!new");
    expect(res.status).toBe(200);
    // The command is handled before a turn is ever started, so it costs nothing.
    expect((await res.json() as { _meta: { request: { cost_usd: number } } })._meta.request.cost_usd).toBe(0);
  });

  it("does not spend on a command", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    await say(sessionId, email, "!unstick");
    expect(await registryFor(agentId).spendThisMonth()).toBe(0);
  });

  it("treats a sentence mentioning a command as an ordinary message", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await say(sessionId, email, "what does !new do?");
    expect((await res.json() as { reply: string }).reply).toBe(replyTo("what does !new do?"));
  });
});

describe("!enable-mcp and !disable-mcp", () => {
  async function withServer(patch: Record<string, unknown> = {}) {
    const fixture = await chatFixture();
    await registryFor(fixture.agentId).addMcpServer({
      ...EMPTY_MCP_SERVER,
      id: crypto.randomUUID(),
      name: "Docs",
      url: "https://mcp.test/",
      enabled: 0,
      disabled_tools: '["read_page"]',
      created_at: Date.now(),
      ...patch,
    });
    return fixture;
  }
  const reply = async (res: Response) => ((await res.json()) as { reply: string }).reply;
  const row = async (agentId: string) => (await registryFor(agentId).mcpServers())[0];

  it("enables a server with every tool and says how many", async () => {
    const { sessionId, email, agentId } = await withServer();
    const text = await reply(await say(sessionId, email, "!enable-mcp docs"));
    expect(text).toContain(`Docs enabled with all ${MCP_TOOLS.length} tools`);
    const server = await row(agentId);
    expect(server.enabled).toBe(1);
    expect(JSON.parse(server.disabled_tools)).toEqual([]);
  });

  it("disables a server and keeps its tool selection", async () => {
    const { sessionId, email, agentId } = await withServer({ enabled: 1 });
    const text = await reply(await say(sessionId, email, "!disable-mcp Docs"));
    expect(text).toMatch(/^Disabled\./);
    const server = await row(agentId);
    expect(server.enabled).toBe(0);
    expect(server.disabled_tools).toBe('["read_page"]');
  });

  it("reports a server it cannot find", async () => {
    const { sessionId, email } = await withServer();
    expect(await reply(await say(sessionId, email, "!enable-mcp nope"))).toContain('No MCP server named "nope"');
    expect(await reply(await say(sessionId, email, "!disable-mcp nope"))).toBe(
      "Error disabling MCP server, please visit the web UI."
    );
  });

  it("reports a server that is not connected", async () => {
    const { sessionId, email } = await withServer({ auth: "oauth" });
    expect(await reply(await say(sessionId, email, "!enable-mcp docs"))).toContain("not connected");
  });

  it("reports a server it cannot reach", async () => {
    const { sessionId, email, agentId } = await withServer({ url: "https://unreachable.test/" });
    expect(await reply(await say(sessionId, email, "!enable-mcp docs"))).toMatch(/^Error connecting to Docs/);
    expect((await row(agentId)).last_error).not.toBe("");
  });
});

describe("access control on a turn", () => {
  it("refuses a stranger", async () => {
    const { sessionId } = await chatFixture();
    const res = await say(sessionId, someone("stranger"), "let me in");
    expect(res.status).toBe(404);
  });

  it("refuses an anonymous caller", async () => {
    const { sessionId } = await chatFixture();
    const res = await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "let me in" }),
    });
    expect([401, 404]).toContain(res.status);
  });

  it("hides the transcript from a stranger", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "something private");
    const res = await transcript(sessionId, someone("stranger"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("something private");
  });

  it("keeps a session bound to the agent named in its id", async () => {
    const { sessionId } = await chatFixture();
    const other = await chatFixture();
    // The owner is encoded in the session id, and the access check reads it from
    // there. A member of a different agent must not reach this session.
    expect(agentIdOf(sessionId)).not.toBe(other.agentId);
    const res = await say(sessionId, other.email, "hello");
    expect(res.status).toBe(404);
  });
});

describe("streaming a turn", () => {
  it("streams a reply as server-sent events", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/stream`,
      as(email, { method: "POST", body: JSON.stringify({ message: "hello" }) })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("data:");
    // The reply arrives as many small deltas, so it is reassembled rather than
    // matched whole — which is also a check that the delta events carry the text.
    const streamed = [...body.matchAll(/^data: (.*)$/gm)]
      .map(([, payload]) => {
        try {
          return JSON.parse(payload) as { type?: string; text?: string };
        } catch {
          return {};
        }
      })
      .filter((event) => event.type === "delta")
      .map((event) => event.text ?? "")
      .join("");
    expect(streamed).toBe(replyTo("hello"));
  });

  it("persists a streamed turn to the transcript", async () => {
    const { sessionId, email } = await chatFixture();
    await SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/stream`,
      as(email, { method: "POST", body: JSON.stringify({ message: "streamed" }) })
    ).then((r) => r.text());
    const body = (await (await transcript(sessionId, email)).json()) as {
      messages: { role: string; content: string }[];
    };
    // The stream is what the browser reads, but the transcript is what survives a
    // reload — a turn that streamed and stored nothing would look fine until then.
    expect(body.messages.map((m) => m.content)).toContain("streamed");
  });

  it("rejects a stream request with no message", async () => {
    const { sessionId, email } = await chatFixture();
    const res = await SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/stream`,
      as(email, { method: "POST", body: JSON.stringify({}) })
    );
    expect(res.status).toBe(400);
  });
});

describe("the OpenRouter key", () => {
  it("refuses to create an agent with a key the provider rejects", async () => {
    const email = someone("member");
    const res = await SELF.fetch(
      `${BASE}/api/agents`,
      as(email, {
        method: "POST",
        body: JSON.stringify({
          name: "Bad key",
          allowed_emails: email,
          openrouter_api_key: "sk-invalid",
        }),
      })
    );
    // Checked before the agent exists, so a typo does not leave a half-built agent
    // that answers nothing.
    expect(res.status).toBe(400);
  });

  it("says so plainly when an agent has no key at all", async () => {
    const email = someone("member");
    const agent = (await (
      await SELF.fetch(
        `${BASE}/api/agents`,
        as(email, { method: "POST", body: JSON.stringify({ name: "No key", allowed_emails: email }) })
      )
    ).json()) as { id: string };
    const session = (await (
      await SELF.fetch(
        `${BASE}/api/agents/${agent.id}/sessions`,
        as(email, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
      )
    ).json()) as { id: string };

    const res = await say(session.id, email, "hello");
    const text = await res.text();
    // Not a bare 401 from the provider reaching the chat as "Provider returned error".
    expect(text).toContain("OpenRouter API key");
  });
});

describe("the suite's own network seal", () => {
  it("blocks any outbound request that is not OpenRouter", async () => {
    // Proves the mock is a seal, not just a convenience: a test can never quietly
    // depend on a real service, and a webhook sync can never fire at a real bot.
    const res = await fetch("https://api.telegram.org/bot123/setWebhook");
    expect(res.status).toBe(503);
  });
});

/**
 * What the turn actually tells the model about itself.
 *
 * Asserted on the request that went out rather than on the string the prompt builder
 * returns, because the bug being guarded against was never in the wording — it was in
 * which list the wording was built from. With WhatsApp among the capabilities the
 * agent offered to message a phone number it was given, asked for the number, and ran
 * bash when no tool appeared.
 */
describe("what the agent is told it can reach", () => {
  /** An agent with WhatsApp switched on and every credential it asks for. */
  async function whatsappFixture() {
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

    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/config`,
      as(email, {
        method: "PATCH",
        body: JSON.stringify({
          cap_whatsapp: 1,
          whatsapp_number: "919876543210",
          whatsapp_phone_number_id: "123456789012345",
          whatsapp_waba_id: "123456789012345",
          whatsapp_access_token: "EAAtoken",
          whatsapp_app_secret: "0".repeat(32),
          whatsapp_verify_token: "a phrase only I know",
        }),
      })
    );

    const session = (await (
      await SELF.fetch(
        `${BASE}/api/agents/${agent.id}/sessions`,
        as(email, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
      )
    ).json()) as { id: string };

    return { email, sessionId: session.id };
  }

  /** The system prompt on the turn's own request, found by the token the message carried. */
  async function systemPromptFor(token: string): Promise<string> {
    const all = (await (
      await fetch(`https://openrouter.ai/__requests?contains=${token}`)
    ).json()) as { stream?: boolean; messages?: { role: string; content?: unknown }[] }[];
    const turn = all.find((b) => b.stream);
    return String(turn?.messages?.find((m) => m.role === "system")?.content ?? "");
  }

  it("names a configured channel as reach, not as a capability", async () => {
    const { sessionId, email } = await whatsappFixture();
    const token = crypto.randomUUID().slice(0, 8);
    await say(sessionId, email, `hello ${token}`);

    const prompt = await systemPromptFor(token);
    expect(prompt).toContain("You are reachable on WhatsApp");
    expect(prompt).toContain("cannot message any other number");
    // The line that caused it: WhatsApp among the things the model can do.
    const capabilities = prompt.match(/Capabilities available to you: .*/)?.[0] ?? "";
    expect(capabilities).not.toContain("WhatsApp");
  });

  it("says nothing about reach when no channel is configured", async () => {
    const { sessionId, email } = await chatFixture();
    const token = crypto.randomUUID().slice(0, 8);
    await say(sessionId, email, `hello ${token}`);

    expect(await systemPromptFor(token)).not.toContain("You are reachable on");
  });
});
