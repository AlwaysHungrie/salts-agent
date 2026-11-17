import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { signedIn } from "./clerk";
import { PROVISIONING_KEY } from "./openrouter-mock";
import { SHIPPED } from "./shipped";

/**
 * The starter key: every account is given one small provisioned key, once, so a first
 * agent can answer before its owner has found the wallet.
 */

const BASE = "https://worker.test";

const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;

const directory = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));

function as(email: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: { "content-type": "application/json", ...signedIn(email) },
  };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const starter = (email: string) =>
  SELF.fetch(`${BASE}/api/wallet/starter`, as(email, { method: "POST" }));

async function wallet(email: string) {
  return (await json<{ keys: { id: string; kind: string; key: string | null }[] }>(
    SELF.fetch(`${BASE}/api/wallet`, as(email))
  )).keys;
}

async function madeKeys() {
  return await json<Record<string, { name: string; limit: number }>>(
    fetch("https://openrouter.ai/__keys")
  );
}

function settings(patch: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/api/admin/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-api-secret": "test-secret" },
    body: JSON.stringify(patch),
  });
}

describe("the starter key", () => {
  beforeEach(async () => {
    await directory().setProvisioningKey(PROVISIONING_KEY);
    await settings({ starter_key_cents: SHIPPED.starter_key_cents });
  });

  it("gives an account one provisioned key, held to the shipped credit", async () => {
    const owner = someone("new");
    const res = await starter(owner);
    expect(res.status).toBe(200);
    const key = await json<{ id: string; kind: string; key: string | null; nickname: string }>(res);
    expect(key).toMatchObject({ kind: "provisioned", key: null, nickname: "Starter key" });
    expect(await wallet(owner)).toEqual([expect.objectContaining({ id: key.id })]);

    const made = Object.values(await madeKeys()).find((k) => k.name === `Salts ${owner} starter`);
    expect(made?.limit).toBe(SHIPPED.starter_key_cents / 100);
  });

  it("gives it once, even after the key is removed", async () => {
    const owner = someone("new");
    const { id } = await json<{ id: string }>(starter(owner));
    expect((await starter(owner)).status).toBe(409);
    await SELF.fetch(`${BASE}/api/wallet/${id}`, as(owner, { method: "DELETE" }));
    expect((await starter(owner)).status).toBe(409);
    expect(await wallet(owner)).toHaveLength(0);
  });

  it("gives one key however many asks arrive at once", async () => {
    const owner = someone("new");
    const answers = await Promise.all([starter(owner), starter(owner), starter(owner)]);
    expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await wallet(owner)).toHaveLength(1);
  });

  it("is given to fleet members and admins too, once each", async () => {
    const admin = someone("admin");
    const member = someone("member");
    await SELF.fetch(
      `${BASE}/api/agents`,
      as(admin, {
        method: "POST",
        body: JSON.stringify({ name: "Fleet", allowed_emails: `${admin}, ${member}` }),
      })
    );
    expect((await starter(member)).status).toBe(200);
    expect((await starter(admin)).status).toBe(200);
    expect((await starter(member)).status).toBe(409);
  });

  it("is given beside keys already in the wallet", async () => {
    const owner = someone("owner");
    await SELF.fetch(`${BASE}/api/wallet`, as(owner, { method: "POST", body: JSON.stringify({ key: "sk-or-own" }) }));
    expect((await starter(owner)).status).toBe(200);
    expect(await wallet(owner)).toHaveLength(2);
  });

  it("waits for room in a full wallet, and undoes the key it made", async () => {
    const owner = someone("full");
    for (let i = 0; i < SHIPPED.max_wallet_keys; i++) {
      await directory().addWalletKey(owner, { kind: "own", secret: `sk-or-full-${i}` }, SHIPPED.max_wallet_keys);
    }
    expect((await starter(owner)).status).toBe(400);
    const named = Object.values(await madeKeys()).filter((k) => k.name === `Salts ${owner} starter`);
    expect(named).toHaveLength(0);

    const [first] = await wallet(owner);
    await SELF.fetch(`${BASE}/api/wallet/${first.id}`, as(owner, { method: "DELETE" }));
    expect((await starter(owner)).status).toBe(200);
  });

  it("is off while the setting is 0 or no provisioning key is set", async () => {
    await settings({ starter_key_cents: 0 });
    const owner = someone("new");
    expect((await starter(owner)).status).toBe(404);

    await settings({ starter_key_cents: SHIPPED.starter_key_cents });
    await directory().setProvisioningKey("");
    expect((await starter(owner)).status).toBe(404);
  });

  it("can be asked for again when OpenRouter was down", async () => {
    const owner = someone("new");
    await directory().setProvisioningKey("sk-or-prov-down");
    expect((await starter(owner)).status).toBe(503);
    await directory().setProvisioningKey(PROVISIONING_KEY);
    expect((await starter(owner)).status).toBe(200);
  });

  it("needs a signed-in caller", async () => {
    expect((await SELF.fetch(`${BASE}/api/wallet/starter`, { method: "POST" })).status).toBe(401);
  });
});
