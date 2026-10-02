import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * Agent API keys: programmatic access without signing in. Each agent has an admin key
 * (does what its admin may) and a user key (does what a member may). A key reaches its
 * own agent only, is shown once, and stops working the moment it is replaced or revoked.
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

function withKey(key: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
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

async function createAgent(owner: string, members = owner) {
  return await json<{ id: string }>(
    SELF.fetch(
      `${BASE}/api/agents`,
      as(owner, {
        method: "POST",
        body: JSON.stringify({
          name: "Keyed",
          allowed_emails: members,
          openrouter_api_key: "sk-fake-but-valid",
        }),
      })
    )
  );
}

type Generated = { role: string; key: string; hint: string; created_at: number };

function generate(agentId: string, role: string, init: RequestInit) {
  return SELF.fetch(`${BASE}/api/agents/${agentId}/api-keys/${role}`, {
    ...init,
    method: "POST",
  });
}

describe("agent API keys", () => {
  it("lets a member make a user key that does what a member can", async () => {
    const owner = someone("owner");
    const { id } = await createAgent(owner);
    const made = await json<Generated>(generate(id, "user", as(owner)));
    expect(made.role).toBe("user");
    expect(made.key).toMatch(new RegExp(`^salt_user_${id}_[0-9a-f]{48}$`));
    expect(made.key.endsWith(made.hint)).toBe(true);

    // Listed by hint only: the key itself is never shown again.
    const listed = await json<{ keys: Record<string, unknown>[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/api-keys`, as(owner))
    );
    expect(listed.keys.map((k) => k.role)).toEqual(["user"]);
    expect(JSON.stringify(listed)).not.toContain(made.key);

    const key = made.key;
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(key))).status).toBe(200);
    const patched = await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      withKey(key, { method: "PATCH", body: JSON.stringify({ temperature: 0.3 }) })
    );
    expect(patched.status).toBe(200);

    const session = await json<{ id: string }>(
      SELF.fetch(
        `${BASE}/api/agents/${id}/sessions`,
        withKey(key, { method: "POST", body: JSON.stringify({ title: "From curl" }) })
      )
    );
    const chat = await SELF.fetch(
      `${BASE}/agents/session-agent/${session.id}/chat`,
      withKey(key, { method: "POST", body: JSON.stringify({ message: "hello" }) })
    );
    expect(chat.status).toBe(200);
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/messages`, withKey(key))).status
    ).toBe(200);
    expect(
      (
        await SELF.fetch(
          `${BASE}/api/sessions/${session.id}`,
          withKey(key, { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) })
        )
      ).status
    ).toBe(200);

    // Not the admin's: meta, deletion, the admin key.
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/meta`, withKey(key))).status).toBe(404);
    expect(
      (await SELF.fetch(`${BASE}/api/agents/${id}`, withKey(key, { method: "DELETE" }))).status
    ).toBe(404);
    expect((await generate(id, "admin", withKey(key))).status).toBe(404);
  });

  it("lets the admin make an admin key that does what the admin can", async () => {
    const owner = someone("owner");
    const { id } = await createAgent(owner);
    const { key } = await json<Generated>(generate(id, "admin", as(owner)));
    expect(key).toMatch(new RegExp(`^salt_admin_${id}_`));

    expect((await SELF.fetch(`${BASE}/api/agents/${id}/meta`, withKey(key))).status).toBe(200);
    // The admin is a member here, so the key is too.
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(key))).status).toBe(200);
    // And it manages both keys.
    expect((await generate(id, "user", withKey(key))).status).toBe(200);
    const listed = await json<{ keys: { role: string }[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/api-keys`, withKey(key))
    );
    expect(listed.keys.map((k) => k.role)).toEqual(["admin", "user"]);

    expect(
      (await SELF.fetch(`${BASE}/api/agents/${id}`, withKey(key, { method: "DELETE" }))).status
    ).toBe(200);
  });

  it("gives an admin who is not a member an admin key that is not a member either", async () => {
    const owner = someone("owner");
    const { id } = await createAgent(owner, someone("member"));
    const { key } = await json<Generated>(generate(id, "admin", as(owner)));
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/meta`, withKey(key))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(key))).status).toBe(404);
  });

  it("keeps the admin key from members who are not the admin", async () => {
    const owner = someone("owner");
    const member = someone("member");
    const { id } = await createAgent(owner, `${owner},${member}`);
    await generate(id, "admin", as(owner));
    await generate(id, "user", as(owner));
    expect((await generate(id, "admin", as(member))).status).toBe(404);
    const listed = await json<{ keys: { role: string }[] }>(
      SELF.fetch(`${BASE}/api/agents/${id}/api-keys`, as(member))
    );
    expect(listed.keys.map((k) => k.role)).toEqual(["user"]);
  });

  it("reaches its own agent and nothing else", async () => {
    const owner = someone("owner");
    await raiseLimit(owner, 5);
    const { id } = await createAgent(owner);
    const other = await createAgent(owner);
    const { key } = await json<Generated>(generate(id, "admin", as(owner)));

    expect((await SELF.fetch(`${BASE}/api/agents/${other.id}/meta`, withKey(key))).status).toBe(
      401
    );
    expect((await SELF.fetch(`${BASE}/api/agents`, withKey(key))).status).toBe(401);
    const session = await json<{ id: string }>(
      SELF.fetch(`${BASE}/api/agents/${other.id}/sessions`, as(owner, { method: "POST" }))
    );
    expect(
      (await SELF.fetch(`${BASE}/agents/session-agent/${session.id}/messages`, withKey(key))).status
    ).toBe(401);
    // A key with the agent id swapped is not a key for that agent.
    const forged = key.replace(`_${id}_`, `_${other.id}_`);
    expect((await SELF.fetch(`${BASE}/api/agents/${other.id}/meta`, withKey(forged))).status).toBe(
      401
    );
  });

  it("stops working when replaced or revoked", async () => {
    const owner = someone("owner");
    const { id } = await createAgent(owner);
    const first = await json<Generated>(generate(id, "user", as(owner)));
    const second = await json<Generated>(generate(id, "user", as(owner)));
    expect(second.key).not.toBe(first.key);
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(first.key))).status).toBe(
      401
    );
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(second.key))).status).toBe(
      200
    );

    const revoked = await SELF.fetch(
      `${BASE}/api/agents/${id}/api-keys/user`,
      as(owner, { method: "DELETE" })
    );
    expect(revoked.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/agents/${id}/config`, withKey(second.key))).status).toBe(
      401
    );
  });
});
