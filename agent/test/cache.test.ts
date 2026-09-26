import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cachedPromptTokens, prepareOpenRouterRequest } from "../src/agent";

/**
 * The cache breakpoint, and the number that proves it landed.
 *
 * What is actually at stake is the tool definitions. A connected MCP server puts its
 * whole schema in front of every request — Notion's is tens of thousands of tokens —
 * and the AI SDK re-sends all of it on every tool round of every turn. Three of the
 * four providers this Worker offers cache that prefix on their own; Anthropic caches
 * nothing without being asked, which is the one case these tests are about.
 *
 * The end-to-end case is the one that matters most: whether the breakpoint reaches the
 * body the AI SDK actually builds is not something a hand-assembled body can answer.
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

type ContentPart = { type?: string; text?: string; cache_control?: { type: string } };
type Body = {
  model?: string;
  stream?: boolean;
  usage?: { include?: boolean };
  provider?: { data_collection?: string };
  messages?: { role?: string; content?: string | ContentPart[] }[];
};

const request = (body: Body): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** The body a prepared request carries, parsed back. */
function prepared(body: Body): Body {
  const init = prepareOpenRouterRequest(request(body));
  return JSON.parse(init?.body as string) as Body;
}

const system = (body: Body) => body.messages?.find((m) => m.role === "system");

const anthropic = (patch: Partial<Body> = {}): Body => ({
  model: "anthropic/claude-haiku-4.5",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "hello" },
  ],
  ...patch,
});

describe("prepareOpenRouterRequest", () => {
  it("puts a breakpoint at the end of an Anthropic system prompt", () => {
    const parts = system(prepared(anthropic()))?.content as ContentPart[];
    expect(parts).toEqual([
      {
        type: "text",
        text: "You are a concise assistant.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("marks the last text part when the system prompt is already split up", () => {
    const parts = system(
      prepared(
        anthropic({
          messages: [
            {
              role: "system",
              content: [
                { type: "text", text: "rules" },
                { type: "text", text: "memories" },
              ],
            },
            { role: "user", content: "hello" },
          ],
        })
      )
    )?.content as ContentPart[];
    // The breakpoint ends the prefix, so it belongs on the last of them — anything
    // earlier would leave the rest of the system prompt out of the cache.
    expect(parts[0].cache_control).toBeUndefined();
    expect(parts[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves a body that already carries a breakpoint alone", () => {
    const already: Body = anthropic({
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: "hello" },
      ],
      usage: { include: true },
    });
    // Nothing to add and nothing to report: the body is handed back untouched rather
    // than spending a second of the four breakpoints Anthropic allows.
    expect(prepareOpenRouterRequest(request(already))?.body).toBe(JSON.stringify(already));
  });

  it("asks for nothing on a provider that caches by itself", () => {
    // DeepSeek, OpenAI and Gemini cache a repeated prefix with no breakpoint at all,
    // so marking one buys nothing and would only narrow what they match on.
    for (const model of ["deepseek/deepseek-v4-flash", "openai/gpt-5-mini", "google/gemini-2.5-flash"]) {
      const body = prepared(anthropic({ model }));
      expect(system(body)?.content).toBe("You are a concise assistant.");
      expect(body.usage?.include).toBe(true);
    }
  });

  it("still asks for usage on every request", () => {
    expect(prepared(anthropic()).usage?.include).toBe(true);
    expect(prepared(anthropic({ model: "vendor/model" })).usage?.include).toBe(true);
  });

  it("survives a body with no system message", () => {
    const body = prepared(anthropic({ messages: [{ role: "user", content: "hello" }] }));
    expect(body.usage?.include).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("forbids providers that train on the data only when asked to", () => {
    // WhatsApp turns: Meta's terms bar their content from training-data providers.
    const pinned = JSON.parse(
      prepareOpenRouterRequest(request(anthropic({ model: "vendor/model" })), true)?.body as string
    ) as Body;
    expect(pinned.provider?.data_collection).toBe("deny");
    expect(pinned.usage?.include).toBe(true);
    expect(prepared(anthropic({ model: "vendor/model" })).provider).toBeUndefined();
  });

  it("pins even a body that needed nothing else", () => {
    const ready: Body = { model: "vendor/model", messages: [], usage: { include: true } };
    const init = prepareOpenRouterRequest(request(ready), true);
    expect((JSON.parse(init?.body as string) as Body).provider?.data_collection).toBe("deny");
  });

  it("hands back anything it cannot read", () => {
    const form = { method: "POST", body: new FormData() } as RequestInit;
    expect(prepareOpenRouterRequest(form)).toBe(form);
    const broken = { method: "POST", body: "{not json" } as RequestInit;
    expect(prepareOpenRouterRequest(broken)).toBe(broken);
    expect(prepareOpenRouterRequest(undefined)).toBeUndefined();
  });
});

describe("cachedPromptTokens", () => {
  const step = (raw: unknown) => ({ usage: { raw } }) as never;

  it("reads what the provider says it served from cache", () => {
    expect(cachedPromptTokens(step({ prompt_tokens_details: { cached_tokens: 70_000 } }))).toBe(70_000);
  });

  it("is zero when the provider says nothing", () => {
    expect(cachedPromptTokens(step({}))).toBe(0);
    expect(cachedPromptTokens(step(undefined))).toBe(0);
    expect(cachedPromptTokens(step({ prompt_tokens_details: { cached_tokens: "lots" } }))).toBe(0);
    expect(cachedPromptTokens({} as never)).toBe(0);
  });
});

/** An agent with a session, on the model the test names. */
async function chatFixture(model?: string) {
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

  if (model) {
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/config`,
      as(email, { method: "PATCH", body: JSON.stringify({ model }) })
    );
  }

  const session = (await (
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/sessions`,
      as(email, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
    )
  ).json()) as { id: string };

  return { email, sessionId: session.id };
}

/**
 * The turn's own chat request, found in the mock's log by the token the message
 * carried. The title call is on the same exchange and is not streamed, which is what
 * separates the two.
 */
async function requestFor(token: string): Promise<Body> {
  const all = (await (
    await fetch(`https://openrouter.ai/__requests?contains=${token}`)
  ).json()) as Body[];
  return all.find((b) => b.stream) as Body;
}

describe("a turn's real request", () => {
  it("carries the breakpoint on an Anthropic model", async () => {
    const { sessionId, email } = await chatFixture("anthropic/claude-haiku-4.5");
    const token = crypto.randomUUID().slice(0, 8);
    await SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/chat`,
      as(email, { method: "POST", body: JSON.stringify({ message: `hello ${token}` }) })
    );

    const body = await requestFor(token);
    const parts = system(body)?.content as ContentPart[];
    // The system prompt is the last thing before the conversation, and OpenRouter
    // renders `tools` ahead of it — so this one breakpoint is what holds the tool
    // definitions in cache across every round of every later turn.
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(parts.at(-1)?.text).toContain("Durable Object");
  });

  it("carries none on the default model, which caches by itself", async () => {
    const { sessionId, email } = await chatFixture();
    const token = crypto.randomUUID().slice(0, 8);
    await SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/chat`,
      as(email, { method: "POST", body: JSON.stringify({ message: `hello ${token}` }) })
    );

    const body = await requestFor(token);
    expect(typeof system(body)?.content).toBe("string");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});
