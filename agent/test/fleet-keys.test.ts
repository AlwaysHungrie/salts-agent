import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedIn } from "./clerk";

/**
 * A fleet's API key: an app outside salts finds and adds the fleet's agents by address
 * and issues their own keys with it, acting for the fleet's admin. It reaches nothing
 * else: not the fleet's settings, not its own key, not another fleet, not any agent.
 */

const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: { "content-type": "application/json", ...signedIn(email), ...(init.headers as Record<string, string>) },
  };
}

function withKey(key: string, init: RequestInit = {}) {
  return { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${key}` } };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

type Agent = { id: string; allowed_emails: string; admin_email: string; fleet_id: string };

/** A fleet of one agent, administered by `admin`, and a fresh key for it. */
async function fleetWithKey(admin: string) {
  const made = await json<{ fleet_id: string; agents: Agent[] }>(
    SELF.fetch(
      `${BASE}/api/agents`,
      as(admin, { method: "POST", body: JSON.stringify({ name: "Humans", fleet_name: "Humans", allowed_emails: someone("first") }) })
    )
  );
  const key = await json<{ key: string; hint: string }>(
    SELF.fetch(`${BASE}/api/fleets/${made.fleet_id}/api-keys/fleet`, as(admin, { method: "POST" }))
  );
  return { fleetId: made.fleet_id, key: key.key, hint: key.hint };
}

describe("a fleet's API key", () => {
  it("is shown once and only its hint after", async () => {
    const admin = someone("admin");
    const { fleetId, key, hint } = await fleetWithKey(admin);
    expect(key).toMatch(new RegExp(`^salt_fleet_${fleetId}_`));
    const seen = await json<{ keys: { role: string; hint: string }[] }>(
      SELF.fetch(`${BASE}/api/fleets/${fleetId}/api-keys`, as(admin))
    );
    expect(seen.keys).toMatchObject([{ role: "fleet", hint }]);
    expect(JSON.stringify(seen)).not.toContain(key);
  });

  it("adds an agent for an address, finds it again, and issues its keys", async () => {
    const admin = someone("admin");
    const { fleetId, key } = await fleetWithKey(admin);
    const guest = someone("ticket");
    const url = `${BASE}/api/fleets/${fleetId}/agents`;

    const none = await json<{ agents: Agent[] }>(SELF.fetch(`${url}?email=${encodeURIComponent(guest)}`, withKey(key)));
    expect(none.agents).toEqual([]);

    const added = await SELF.fetch(url, withKey(key, { method: "POST", body: JSON.stringify({ allowed_emails: guest }) }));
    expect(added.status).toBe(200);
    const [agent] = (await json<{ agents: Agent[] }>(added)).agents;
    expect(agent.allowed_emails).toBe(guest);
    expect(agent.admin_email).toBe(admin);
    expect(agent.fleet_id).toBe(fleetId);

    const found = await json<{ agents: Agent[] }>(SELF.fetch(`${url}?email=${encodeURIComponent(guest.toUpperCase())}`, withKey(key)));
    expect(found.agents.map((a) => a.id)).toEqual([agent.id]);

    const user = await json<{ key: string }>(SELF.fetch(`${url}/${agent.id}/api-keys/user`, withKey(key, { method: "POST" })));
    expect(user.key).toMatch(new RegExp(`^salt_user_${agent.id}_`));
    const session = await SELF.fetch(
      `${BASE}/api/agents/${agent.id}/sessions`,
      withKey(user.key, { method: "POST", body: JSON.stringify({ title: "Chat" }) })
    );
    expect(session.status).toBe(200);
  });

  it("reaches only its own fleet's agents", async () => {
    const mine = await fleetWithKey(someone("admin"));
    const theirs = await fleetWithKey(someone("other"));
    const outsider = await json<{ agents: Agent[] }>(
      SELF.fetch(`${BASE}/api/fleets/${theirs.fleetId}/agents?email=x@x.com`, withKey(theirs.key))
    );
    expect(outsider.agents).toEqual([]);

    expect((await SELF.fetch(`${BASE}/api/fleets/${theirs.fleetId}/agents?email=x@x.com`, withKey(mine.key))).status).toBe(401);
    // Not an agent key: it opens no agent's own routes.
    expect((await SELF.fetch(`${BASE}/api/agents`, withKey(mine.key))).status).toBe(401);
    // Not the fleet's settings, nor its own key.
    expect((await SELF.fetch(`${BASE}/api/fleets/${mine.fleetId}`, withKey(mine.key))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/api/fleets/${mine.fleetId}/api-keys/fleet`, withKey(mine.key, { method: "POST" }))).status).toBe(403);
  });

  it("issues keys only for agents in the fleet", async () => {
    const admin = someone("admin");
    const { fleetId, key } = await fleetWithKey(admin);
    const loner = await json<{ id: string }>(
      SELF.fetch(`${BASE}/api/agents`, as(admin, { method: "POST", body: JSON.stringify({ name: "Solo", allowed_emails: admin }) }))
    );
    const res = await SELF.fetch(`${BASE}/api/fleets/${fleetId}/agents/${loner.id}/api-keys/user`, withKey(key, { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("stops working once replaced or revoked", async () => {
    const admin = someone("admin");
    const { fleetId, key } = await fleetWithKey(admin);
    const url = `${BASE}/api/fleets/${fleetId}/agents?email=x@x.com`;
    expect((await SELF.fetch(url, withKey(key))).status).toBe(200);
    const next = await json<{ key: string }>(SELF.fetch(`${BASE}/api/fleets/${fleetId}/api-keys/fleet`, as(admin, { method: "POST" })));
    expect((await SELF.fetch(url, withKey(key))).status).toBe(401);
    expect((await SELF.fetch(url, withKey(next.key))).status).toBe(200);
    await SELF.fetch(`${BASE}/api/fleets/${fleetId}/api-keys/fleet`, as(admin, { method: "DELETE" }));
    expect((await SELF.fetch(url, withKey(next.key))).status).toBe(401);
  });
});
