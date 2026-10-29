import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clerkToken, signedIn } from "./clerk";

/**
 * A trusted app's Clerk OAuth access token as a way into its user's agent sessions.
 *
 * The suite trusts `https://trusted.test/client.json` for resource `https://worker.test`
 * (vitest.config.ts). Such a token may start a session on an agent the user is on, talk
 * in it and delete it; it is no Salts login anywhere else, and a token for another
 * resource or client, or for an unverified address, opens nothing.
 */

const BASE = "https://worker.test";
const TRUSTED = "https://trusted.test/client.json";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

/** An access token the way Clerk issues one: no sid and no email, the user in `sub`. */
const accessToken = (email: string, claims: Record<string, unknown> = {}) =>
  clerkToken(email, {
    sid: undefined,
    email: undefined,
    aud: [BASE],
    client_id: TRUSTED,
    scope: "openid email profile offline_access",
    ...claims,
  });

const bearer = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

async function createAgent(member: string): Promise<string> {
  const owner = someone("owner");
  const res = await SELF.fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedIn(owner) },
    body: JSON.stringify({
      name: "Tutor",
      allowed_emails: member,
      openrouter_api_key: "sk-fake-but-valid",
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const startSession = (agentId: string, token: string) =>
  SELF.fetch(`${BASE}/api/agents/${agentId}/sessions`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ title: "Office hours" }),
  });

describe("OAuth access tokens from a trusted app", () => {
  it("start, use and delete a session on the user's agent", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const token = accessToken(member);

    const started = await startSession(agentId, token);
    expect(started.status).toBe(200);
    const { id } = (await started.json()) as { id: string };

    const stream = await SELF.fetch(
      `${BASE}/agents/session-agent/${encodeURIComponent(id)}/stream`,
      {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ message: "hello" }),
      }
    );
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    const deleted = await SELF.fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(deleted.status).toBe(200);
  });

  it("open nothing on an agent the user is not on", async () => {
    const agentId = await createAgent(someone());
    const res = await startSession(agentId, accessToken(someone("stranger")));
    expect(res.status).toBe(404);
  });

  it("are no Salts login outside the session routes", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const token = accessToken(member);
    for (const path of [
      "/api/agents",
      `/api/agents/${agentId}`,
      `/api/agents/${agentId}/sessions`,
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: bearer(token) });
      expect(res.status, path).toBe(401);
    }
  });

  it("refuse a token issued for another resource", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(
      agentId,
      accessToken(member, { aud: ["https://mcp.example.com/mcp"] })
    );
    expect(res.status).toBe(401);
  });

  it("refuse a token issued to another client", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(
      agentId,
      accessToken(member, { client_id: "https://untrusted.test/client.json" })
    );
    expect(res.status).toBe(401);
  });

  it("refuse a user whose address is not verified", async () => {
    const member = someone();
    const agentId = await createAgent(member);
    const res = await startSession(agentId, accessToken(member, { test_unverified: true }));
    expect(res.status).toBe(401);
  });
});
