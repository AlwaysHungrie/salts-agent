import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SECRET_MASK } from "../src/capabilities";
import { signedIn } from "./clerk";

/**
 * The OpenRouter wallet: each account's keys, picked by nickname wherever a key is asked
 * for. A pasted key is its owner's to see; a provisioned one is only ever spent through
 * an agent. An agent holds a copy of the key it was given, so removing a key from the
 * wallet has to reach every agent that holds it.
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

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

type KeyView = {
  id: string;
  nickname: string;
  kind: string;
  key: string | null;
  agents: number;
  valid: boolean;
};

type ConfigView = { config: { openrouter_api_key: string; openrouter_key_id: string } };

/** The directory the routes use, for what no route may do: provision a key. */
const directory = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));

function addKey(email: string, key = "sk-or-wallet") {
  return SELF.fetch(`${BASE}/api/wallet`, as(email, { method: "POST", body: JSON.stringify({ key }) }));
}

async function wallet(email: string) {
  return (await json<{ keys: KeyView[] }>(SELF.fetch(`${BASE}/api/wallet`, as(email)))).keys;
}

async function createAgent(owner: string, meta?: unknown) {
  return SELF.fetch(
    `${BASE}/api/agents`,
    as(owner, {
      method: "POST",
      body: JSON.stringify({ name: "Wallet", allowed_emails: owner, ...(meta ? { meta } : {}) }),
    })
  );
}

async function config(email: string, agentId: string) {
  return (await json<ConfigView>(SELF.fetch(`${BASE}/api/agents/${agentId}/config`, as(email))))
    .config;
}

function pick(email: string, agentId: string, keyId: string) {
  return SELF.fetch(
    `${BASE}/api/agents/${agentId}/config`,
    as(email, { method: "PATCH", body: JSON.stringify({ openrouter_key_id: keyId }) })
  );
}

describe("OpenRouter wallet", () => {
  it("adds a pasted key and shows it to its owner only", async () => {
    const owner = someone("owner");
    const added = await json<KeyView>(addKey(owner));
    expect(added).toMatchObject({ kind: "own", key: "sk-or-wallet" });
    expect(added.nickname).toMatch(/^\w+ \w+/);

    expect(await wallet(owner)).toHaveLength(1);
    expect(await wallet(someone("other"))).toHaveLength(0);
  });

  it("refuses a key OpenRouter rejects, or none at all", async () => {
    const owner = someone("owner");
    expect((await addKey(owner, "sk-invalid")).status).toBe(400);
    expect((await addKey(owner, "  ")).status).toBe(400);
  });

  it("names every key itself, never twice in one wallet", async () => {
    const owner = someone("owner");
    for (let i = 0; i < 6; i++) {
      await directory().addWalletKey(owner, { kind: "own", secret: `sk-or-${i}` }, 20);
    }
    const names = (await wallet(owner)).map((k) => k.nickname.toLowerCase());
    expect(new Set(names).size).toBe(6);
  });

  it("never shows a provisioned key, even to its owner", async () => {
    const owner = someone("owner");
    await directory().addWalletKey(
      owner,
      { kind: "provisioned", secret: "sk-or-provisioned" },
      20
    );
    const [key] = await wallet(owner);
    expect(key).toMatchObject({ kind: "provisioned", key: null });
    expect(JSON.stringify(await wallet(owner))).not.toContain("sk-or-provisioned");
  });

  it("gives an agent a key picked by id, masked like a pasted one", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));

    expect((await pick(owner, id, keyId)).status).toBe(200);
    expect(await config(owner, id)).toMatchObject({
      openrouter_api_key: SECRET_MASK,
      openrouter_key_id: keyId,
    });
    expect((await wallet(owner))[0].agents).toBe(1);
  });

  it("refuses a key from someone else's wallet", async () => {
    const owner = someone("owner");
    const { id: theirs } = await json<KeyView>(addKey(someone("other")));
    const { id } = await json<{ id: string }>(createAgent(owner));
    expect((await pick(owner, id, theirs)).status).toBe(400);
    expect((await config(owner, id)).openrouter_api_key).toBe("");
  });

  it("creates an agent holding a wallet key named in its defaults", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const res = await createAgent(owner, { defaults: { openrouter_key_id: keyId } });
    expect(res.status).toBe(200);
    const { id } = await json<{ id: string }>(res);
    expect(await config(owner, id)).toMatchObject({
      openrouter_api_key: SECRET_MASK,
      openrouter_key_id: keyId,
    });

    const { id: theirs } = await json<KeyView>(addKey(someone("other")));
    const refused = await createAgent(owner, { defaults: { openrouter_key_id: theirs } });
    expect(refused.status).toBe(400);
  });

  it("clears a pasted key's reference when a key is pasted over a wallet key", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));
    await pick(owner, id, keyId);
    await SELF.fetch(
      `${BASE}/api/agents/${id}/config`,
      as(owner, { method: "PATCH", body: JSON.stringify({ openrouter_api_key: "sk-pasted" }) })
    );
    expect((await config(owner, id)).openrouter_key_id).toBe("");
  });

  it("takes a removed key away from every agent that held it", async () => {
    const owner = someone("owner");
    const { id: keyId } = await json<KeyView>(addKey(owner));
    const { id } = await json<{ id: string }>(createAgent(owner));
    await pick(owner, id, keyId);

    expect((await SELF.fetch(`${BASE}/api/wallet/${keyId}`, as(someone("other"), { method: "DELETE" }))).status).toBe(404);
    const removed = await SELF.fetch(`${BASE}/api/wallet/${keyId}`, as(owner, { method: "DELETE" }));
    expect(await json(removed)).toEqual({ removed: keyId, agents: 1 });
    expect(await config(owner, id)).toMatchObject({ openrouter_api_key: "", openrouter_key_id: "" });
    expect(await wallet(owner)).toHaveLength(0);
  });

  it("says buying is not available yet, and adds credits only to bought keys", async () => {
    const owner = someone("owner");
    const buy = await SELF.fetch(
      `${BASE}/api/wallet/purchases`,
      as(owner, { method: "POST", body: JSON.stringify({ amount: 10 }) })
    );
    expect(buy.status).toBe(501);

    const { id: own } = await json<KeyView>(addKey(owner));
    const credit = (keyId: string) =>
      SELF.fetch(
        `${BASE}/api/wallet/${keyId}/credits`,
        as(owner, { method: "POST", body: JSON.stringify({ amount: 5 }) })
      );
    expect((await credit(own)).status).toBe(400);
    const bought = await directory().addWalletKey(
      owner,
      { kind: "provisioned", secret: "sk-or-provisioned" },
      20
    );
    expect((await credit((bought as { id: string }).id)).status).toBe(501);
  });

  it("stops at the deployment's wallet size", async () => {
    const owner = someone("owner");
    const full = await directory().addWalletKey(
      owner,
      { kind: "own", secret: "sk-or-1" },
      1
    );
    expect("error" in full).toBe(false);
    const over = await directory().addWalletKey(
      owner,
      { kind: "own", secret: "sk-or-2" },
      1
    );
    expect("error" in over).toBe(true);
  });
});
