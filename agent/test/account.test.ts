import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clerkToken, signedIn } from "./clerk";

/**
 * Deactivating an account: allowed only once the user administers no agents and holds no
 * wallet keys or phone numbers; then their own rows and lists are cleared, while payment
 * records, the starter grant and their places on other people's agents stay.
 */

const BASE = "https://worker.test";
const someone = (label = "user") => `${label}-${crypto.randomUUID().slice(0, 8)}@x.com`;
const dir = () => env.AgentDirectory.get(env.AgentDirectory.idFromName("root"));
const lists = (email: string) => env.UserLists.get(env.UserLists.idFromName(email));

const as = (email: string, init: RequestInit = {}) => ({
  ...init,
  headers: { "content-type": "application/json", ...signedIn(email) },
});

const blockers = async (email: string) =>
  ((await (await SELF.fetch(`${BASE}/api/account`, as(email))).json()) as { blockers: string[] })
    .blockers;

const deactivate = (email: string, init: RequestInit = as(email, { method: "DELETE" })) =>
  SELF.fetch(`${BASE}/api/account`, init);

async function createAgent(admin: string, members = admin) {
  const res = await SELF.fetch(
    `${BASE}/api/agents`,
    as(admin, { method: "POST", body: JSON.stringify({ name: "A", allowed_emails: members }) })
  );
  return ((await res.json()) as { id: string }).id;
}

/** Empty the wallet, which creating an agent may have given a starter key. */
async function emptyWallet(email: string) {
  for (const key of await dir().walletKeys(email)) await dir().removeWalletKey(email, key.id);
}

describe("deactivating an account", () => {
  it("is refused while the user administers an agent", async () => {
    const email = someone();
    const id = await createAgent(email);
    expect((await blockers(email)).join()).toContain("Delete your agent first.");
    const res = await deactivate(email);
    expect(res.status).toBe(409);
    expect(await dir().get(id)).toBeTruthy();
  });

  it("is refused while a wallet key or phone number is held", async () => {
    const email = someone();
    await dir().addWalletKey(email, { kind: "own", secret: "sk-or-x" }, 20);
    await dir().addPhoneNumber(email, { number: "+15550001111", kind: "own" }, 5);
    const said = (await blockers(email)).join(" ");
    expect(said).toContain("Tokens Wallet");
    expect(said).toContain("business phone number");
    expect((await deactivate(email)).status).toBe(409);
  });

  it("clears the account's own data once nothing blocks it", async () => {
    const email = someone();
    const id = await createAgent(email);
    await SELF.fetch(`${BASE}/api/agents/${id}`, as(email, { method: "DELETE" }));
    await emptyWallet(email);
    await lists(email).create("Shopping", "", { lists: 5, items: 5, chars: 50 });
    await dir().setAgentLimit(email, 9);

    expect(await blockers(email)).toEqual([]);
    const res = await deactivate(email);
    expect(res.status).toBe(200);
    expect(await lists(email).index()).toEqual([]);
    expect(await dir().getAgentLimit(email)).not.toBe(9);
  });

  it("keeps the user's places on other people's agents for a later sign-up", async () => {
    const owner = someone("owner");
    const member = someone("member");
    const id = await createAgent(owner, `${owner}\n${member}`);
    await emptyWallet(member);
    expect((await deactivate(member)).status).toBe(200);
    const res = await SELF.fetch(`${BASE}/api/agents/${id}`, as(member));
    expect(res.status).toBe(200);
  });

  it("takes only a Salts sign-in, never an app's OAuth access token", async () => {
    const email = someone();
    const token = clerkToken(email, { sid: undefined, aud: [BASE] });
    const res = await deactivate(email, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
