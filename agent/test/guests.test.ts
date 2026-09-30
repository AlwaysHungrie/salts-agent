import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * Guests, owner notes and agent metadata: what an app like socratic-salt builds on.
 *
 * A guest may message an agent and nothing else: start sessions of their own, read
 * and continue those, delete them. The notes are the owner's brief (private) and what
 * guests are shown (public). Metadata is how an app finds its own agents again.
 */

const SECRET = env.API_SECRET as string;
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

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function raiseLimit(email: string, limit: number) {
  await SELF.fetch(`${BASE}/api/admin/business-account`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-secret": SECRET },
    body: JSON.stringify({ email, agent_limit: limit }),
  });
}

async function createAgent(owner: string, extra: Record<string, unknown> = {}) {
  return await json<{ id: string }>(
    SELF.fetch(
      `${BASE}/api/agents`,
      as(owner, {
        method: "POST",
        body: JSON.stringify({
          name: "Challenge",
          allowed_emails: owner,
          openrouter_api_key: "sk-fake-but-valid",
          ...extra,
        }),
      })
    )
  );
}

function setGuests(agentId: string, email: string, body: Record<string, unknown>) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}`,
    as(email, { method: "PATCH", body: JSON.stringify(body) })
  );
}

function startSession(agentId: string, email: string) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}/sessions`,
    as(email, { method: "POST", body: JSON.stringify({ title: "Debate" }) })
  );
}

async function systemPromptFor(token: string): Promise<string> {
  const all = await json<{ stream?: boolean; messages?: { role: string; content?: unknown }[] }[]>(
    fetch(`https://openrouter.ai/__requests?contains=${token}`)
  );
  const turn = all.find((b) => b.stream);
  return String(turn?.messages?.find((m) => m.role === "system")?.content ?? "");
}

describe("owner notes", () => {
  it("keeps long notes and puts both in the system prompt", async () => {
    const owner = someone("owner");
    const { id } = await createAgent(owner);
    const brief = `Argue for Salt. ${"evidence ".repeat(3000)}`;
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(owner, {
        method: "PATCH",
        body: JSON.stringify({
          private_notes: brief,
          public_notes: "The decision: Salt or Spark.",
        }),
      })
    );
    const { config } = await json<{ config: { private_notes: string } }>(
      SELF.fetch(`${BASE}/api/agents/${id}/config`, as(owner))
    );
    expect(config.private_notes.length).toBe(brief.length);

    const session = await json<{ id: string }>(startSession(id, owner));
    const token = crypto.randomUUID().slice(0, 8);
    await SELF.fetch(
      `${BASE}/agents/session-agent/${session.id}/chat`,
      as(owner, { method: "POST", body: JSON.stringify({ message: `hi ${token}` }) })
    );
    const prompt = await systemPromptFor(token);
    expect(prompt).toContain("Argue for Salt.");
    expect(prompt).toContain("was shown before starting:\n\nThe decision: Salt or Spark.");
  });
});

describe("guests", () => {
  async function challenge() {
    const owner = someone("owner");
    const { id } = await createAgent(owner);
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(owner, {
        method: "PATCH",
        body: JSON.stringify({ private_notes: "SECRET BRIEF", public_notes: "Public context" }),
      })
    );
    return { owner, id };
  }

  it("keeps a stranger out until guests are switched on", async () => {
    const { id } = await challenge();
    const guest = someone("guest");
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/public`, as(guest))).status).toBe(404);
    expect((await startSession(id, guest)).status).toBe(404);
  });

  it("with an empty list, lets any signed-in address message it — and nothing more", async () => {
    const { owner, id } = await challenge();
    expect((await setGuests(id, owner, { guests: true })).status).toBe(200);
    const guest = someone("guest");

    const view = await json<Record<string, unknown>>(
      SELF.fetch(`${BASE}/api/agents/${id}/public`, as(guest))
    );
    expect(view).toEqual({ id, name: "Challenge", public_notes: "Public context" });
    expect(JSON.stringify(view)).not.toContain("SECRET BRIEF");

    // Nothing else of the agent.
    for (const path of ["", "/config", "/meta", "/mcp"]) {
      expect((await SELF.fetch(`${BASE}/api/agents/${id}${path}`, as(guest))).status).toBe(404);
    }

    const session = await json<{ id: string; owner_email: string }>(startSession(id, guest));
    expect(session.owner_email).toBe(guest);
    const res = await SELF.fetch(
      `${BASE}/agents/session-agent/${session.id}/chat`,
      as(guest, { method: "POST", body: JSON.stringify({ message: "Spark is better" }) })
    );
    expect(res.status).toBe(200);
    const transcript = await SELF.fetch(
      `${BASE}/agents/session-agent/${session.id}/messages`,
      as(guest)
    );
    expect(transcript.status).toBe(200);

    // Only conversing: no reset, no files, no fork.
    expect(
      (
        await SELF.fetch(
          `${BASE}/agents/session-agent/${session.id}/reset`,
          as(guest, { method: "POST" })
        )
      ).status
    ).toBe(404);
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/files`, as(guest))).status
    ).toBe(404);
    expect(
      (
        await SELF.fetch(
          `${BASE}/api/sessions/${session.id}/fork`,
          as(guest, { method: "POST", body: "{}" })
        )
      ).status
    ).toBe(404);

    // The owner reads it; the guest may delete it.
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/messages`, as(owner))).status
    ).toBe(200);
    expect(
      (await SELF.fetch(`${BASE}/api/sessions/${session.id}`, as(guest, { method: "DELETE" })))
        .status
    ).toBe(200);
  });

  it("keeps each guest to their own sessions", async () => {
    const { owner, id } = await challenge();
    await setGuests(id, owner, { guests: true });
    const alice = someone("alice");
    const bob = someone("bob");
    const aliceSession = await json<{ id: string }>(startSession(id, alice));
    await json(startSession(id, bob));
    const ownerSession = await json<{ id: string }>(startSession(id, owner));

    const listed = await json<{ sessions: { id: string }[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/sessions`, as(alice))
    );
    expect(listed.sessions.map((s) => s.id)).toEqual([aliceSession.id]);

    for (const other of [ownerSession.id]) {
      expect(
        (await SELF.fetch(`${BASE}/agents/session-agent/${other}/messages`, as(alice))).status
      ).toBe(404);
      expect(
        (await SELF.fetch(`${BASE}/api/sessions/${other}`, as(alice, { method: "DELETE" }))).status
      ).toBe(404);
    }
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${aliceSession.id}/messages`, as(bob))).status
    ).toBe(404);

    // The owner sees every guest's session, and `mine=1` narrows to their own.
    const all = await json<{ sessions: { owner_email: string }[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/sessions`, as(owner))
    );
    expect(all.sessions.map((s) => s.owner_email).sort()).toEqual([alice, bob, owner].sort());
    const mine = await json<{ sessions: { id: string }[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/sessions?mine=1`, as(owner))
    );
    expect(mine.sessions.map((s) => s.id)).toEqual([ownerSession.id]);
  });

  it("with a list, admits only the addresses on it", async () => {
    const { owner, id } = await challenge();
    const invited = someone("invited");
    await setGuests(id, owner, { guests: true, guest_emails: [invited] });
    expect((await startSession(id, invited)).status).toBe(200);
    expect((await startSession(id, someone("uninvited"))).status).toBe(404);

    const { config } = {
      config: await json<{ guests: unknown }>(
        SELF.fetch(`${BASE}/api/agents/${id}/config`, as(owner))
      ),
    };
    expect(config.guests).toEqual({ enabled: true, emails: [invited] });
  });

  it("closes again when guests are switched off", async () => {
    const { owner, id } = await challenge();
    await setGuests(id, owner, { guests: true });
    const guest = someone("guest");
    const session = await json<{ id: string }>(startSession(id, guest));
    await setGuests(id, owner, { guests: false });
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/messages`, as(guest))).status
    ).toBe(404);
  });

  it("lets only the admin decide who the guests are", async () => {
    const { owner, id } = await challenge();
    const member = someone("member");
    await SELF.fetch(
      `${BASE}/api/agents/${id}`,
      as(owner, { method: "PATCH", body: JSON.stringify({ allowed_emails: [owner, member] }) })
    );
    expect((await setGuests(id, member, { guests: true })).status).toBe(404);
  });

  it("lists the agents an address may message", async () => {
    const { owner, id } = await challenge();
    const invited = someone("invited");
    const listFor = async (email: string) =>
      (
        await json<{ agents: { id: string; admin_email: string }[] }>(
          SELF.fetch(`${BASE}/api/agents?as=guest&limit=100`, as(email))
        )
      ).agents;

    expect((await listFor(invited)).some((a) => a.id === id)).toBe(false);
    await setGuests(id, owner, { guests: true, guest_emails: [invited] });
    const listed = await listFor(invited);
    expect(listed.find((a) => a.id === id)?.admin_email).toBe("");
    expect((await listFor(someone("other"))).some((a) => a.id === id)).toBe(false);
  });
});

describe("agent metadata", () => {
  it("filters an app's own agents in and everyone else's out", async () => {
    const owner = someone("owner");
    await raiseLimit(owner, 5);
    const tagged = await createAgent(owner, { metadata: { app: "socratic-salt" } });
    const plain = await createAgent(owner);
    const ids = async (query: string) =>
      (
        await json<{ agents: { id: string }[] }>(
          SELF.fetch(`${BASE}/api/agents?${query}`, as(owner))
        )
      ).agents.map((a) => a.id);

    expect(await ids("with=app:socratic-salt")).toEqual([tagged.id]);
    expect(await ids("without=app")).toEqual([plain.id]);
    expect((await ids("")).sort()).toEqual([tagged.id, plain.id].sort());
    expect(await ids("with=app:other")).toEqual([]);
  });

  it("refuses metadata it cannot store safely", async () => {
    const owner = someone("owner");
    for (const metadata of [{ "bad key!": "x" }, { app: 1 }, ["app"], { app: "x".repeat(101) }]) {
      const res = await SELF.fetch(
        `${BASE}/api/agents`,
        as(owner, {
          method: "POST",
          body: JSON.stringify({ name: "X", allowed_emails: owner, metadata }),
        })
      );
      expect(res.status).toBe(400);
    }
  });
});
