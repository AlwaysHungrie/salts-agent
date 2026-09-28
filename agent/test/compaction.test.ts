import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  COST_PER_TURN,
  FIRST_SUMMARY,
  SLOW_REPLY_MS,
  UPDATED_SUMMARY,
  replyTo,
} from "./openrouter-mock";
import { SHIPPED } from "./shipped";

/**
 * Compaction: `!compact`, and the automatic kind past `compact_after_tokens`.
 *
 * What it must never do is as important as what it does. The summary replaces older
 * messages only in what the model is sent; the transcript the chat draws is left
 * whole, and a session under the line runs exactly as it did before compaction
 * existed.
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

async function chatFixture() {
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
  const session = (await (
    await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/sessions`,
      as(email, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
    )
  ).json()) as { id: string };
  return { email, agentId: agent.id, sessionId: session.id };
}

async function say(sessionId: string, email: string, message: string): Promise<string> {
  const res = await SELF.fetch(
    `${BASE}/agents/session-agent/${sessionId}/chat`,
    as(email, { method: "POST", body: JSON.stringify({ message }) })
  );
  return ((await res.json()) as { reply: string }).reply;
}

async function transcript(sessionId: string, email: string): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/agents/session-agent/${sessionId}/messages`, as(email));
  const body = (await res.json()) as { messages: { content: string }[] };
  return body.messages.map((m) => m.content);
}

type Sent = { stream?: boolean; messages?: { role: string; content?: unknown }[] };

/** The turn requests (not summary or title calls) that carried `token`. */
async function turnsCarrying(token: string): Promise<Sent[]> {
  const all = (await (
    await fetch(`https://openrouter.ai/__requests?contains=${token}`)
  ).json()) as Sent[];
  return all.filter((b) => b.stream);
}

/** Every summary call that carried `token`. */
async function summariesCarrying(token: string): Promise<Sent[]> {
  const all = (await (
    await fetch(`https://openrouter.ai/__requests?contains=${token}`)
  ).json()) as Sent[];
  return all.filter((b) => !b.stream && JSON.stringify(b).includes("SUMMARIZE"));
}

const setThreshold = (value: number) =>
  SELF.fetch(`${BASE}/api/admin/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-api-secret": SECRET },
    body: JSON.stringify({ compact_after_tokens: value }),
  });

const registryFor = (agentId: string) =>
  env.SessionRegistry.get(env.SessionRegistry.idFromName(agentId));

/** Four exchanges, each word tagged so a test can find its own requests. */
async function fourTurns(sessionId: string, email: string, tag: string) {
  for (const word of ["first", "second", "third", "fourth"]) {
    await say(sessionId, email, `${word}-${tag}`);
  }
}

describe("!compact", () => {
  it("says there is nothing to compact before anything was said", async () => {
    const { sessionId, email, agentId } = await chatFixture();
    expect(await say(sessionId, email, "!compact")).toContain("Nothing to compact");
    // No summary call was made, so nothing was spent.
    expect(await registryFor(agentId).spendThisMonth()).toBeCloseTo(0);
  });

  it("compacts even a single exchange", async () => {
    const { sessionId, email } = await chatFixture();
    await say(sessionId, email, "hello");
    // The question goes into the summary; the reply is the one message kept.
    expect(await say(sessionId, email, "!compact")).toContain("Compacted: 1 earlier message");
  });

  it("summarises everything but the latest message for the model", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);

    // No head kept, last message kept: the other seven go into the summary.
    const reply = await say(sessionId, email, "!compact");
    expect(reply).toContain("Compacted: 7 earlier messages");

    await say(sessionId, email, `fifth-${tag}`);
    const [next] = await turnsCarrying(`fifth-${tag}`);
    const sent = JSON.stringify(next.messages);
    expect(sent).toContain(FIRST_SUMMARY);
    expect(sent).toContain("Summary of the earlier part of this conversation");
    expect(sent).not.toContain(`first-${tag}`);
    expect(sent).not.toContain(`third-${tag}`);
    // The latest message, the fourth reply, is sent as it was.
    expect(sent).toContain(replyTo(`fourth-${tag}`));
  });

  it("leaves the transcript whole", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    const before = await transcript(sessionId, email);
    await say(sessionId, email, "!compact");
    expect(await transcript(sessionId, email)).toEqual(before);
  });

  it("folds an earlier summary into the next one", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    await say(sessionId, email, "!compact");
    await say(sessionId, email, `fifth-${tag}`);
    await say(sessionId, email, `sixth-${tag}`);
    // Eleven: all twelve transcript messages but the latest.
    expect(await say(sessionId, email, "!compact")).toContain("Compacted: 11 earlier messages");

    await say(sessionId, email, `seventh-${tag}`);
    const [next] = await turnsCarrying(`seventh-${tag}`);
    const sent = JSON.stringify(next.messages);
    expect(sent).toContain(UPDATED_SUMMARY);
    expect(sent).not.toContain(FIRST_SUMMARY);
    expect(sent).not.toContain(`fifth-${tag}`);
  });

  it("banks what the summary cost against the agent's month", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email, agentId } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    await say(sessionId, email, "!compact");
    expect(await registryFor(agentId).spendThisMonth()).toBeCloseTo(COST_PER_TURN * 5);
  });

  it("refuses while a reply is still being written", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    const streaming = SELF.fetch(
      `${BASE}/agents/session-agent/${sessionId}/stream`,
      as(email, { method: "POST", body: JSON.stringify({ message: "!!slow go on" }) })
    );
    await scheduler.wait(SLOW_REPLY_MS / 4);
    expect(await say(sessionId, email, "!compact")).toContain("still being written");
    await (await streaming).text();
  });

  it("keeps the session answering afterwards", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    await say(sessionId, email, "!compact");
    expect(await say(sessionId, email, "still there")).toBe(replyTo("still there"));
  });
});

describe("automatic compaction", () => {
  afterEach(async () => {
    await setThreshold(SHIPPED.compact_after_tokens);
  });

  it("compacts before a turn once the last one's prompt passed the line", async () => {
    // Every mocked call reports 11 prompt tokens, so a line of 5 is always crossed.
    await setThreshold(5);
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);

    const [fourth] = await turnsCarrying(`fourth-${tag}`);
    expect(JSON.stringify(fourth.messages)).toContain(FIRST_SUMMARY);
    // The transcript is still every message the chat has had.
    expect(await transcript(sessionId, email)).toHaveLength(8);
  });

  it("never compacts at 0", async () => {
    await setThreshold(0);
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    expect(await summariesCarrying(`first-${tag}`)).toHaveLength(0);
  });

  it("leaves a conversation under the shipped line alone", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const { sessionId, email } = await chatFixture();
    await fourTurns(sessionId, email, tag);
    expect(await summariesCarrying(`first-${tag}`)).toHaveLength(0);
    const [fourth] = await turnsCarrying(`fourth-${tag}`);
    const sent = JSON.stringify(fourth.messages);
    expect(sent).toContain(`second-${tag}`);
    expect(sent).not.toContain("MOCK-SUMMARY");
  });
});
