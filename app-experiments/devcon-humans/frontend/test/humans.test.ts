import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { myProfile, person, saveMyProfile } from "@/lib/humans";
import { citedPeople } from "@/lib/people";
import { profileMessage, searchMessage } from "@/lib/prompts";
import { findHumansSecret, mintSecret } from "@/lib/provision";

const doc: Record<string, unknown> = {};
const col = {
  findOne: vi.fn(async () => ({ ...doc })),
  updateOne: vi.fn(async (_q: unknown, u: { $set?: Record<string, unknown> }) => {
    Object.assign(doc, u.$set);
  }),
};
vi.mock("@/lib/db", () => ({ users: async () => col }));

// The agent's find-humans server, holding the secret it was given before ids were kept.
const issueAgentKey = vi.fn(async () => "salt_admin_ab12_k");
const mcpServers = vi.fn(async () => [
  { id: "s1", name: "find-humans", headers: { "X-Find-Humans-Secret": mintSecret("held-id-0123456789") } },
]);
vi.mock("@/lib/agent", async (real) => ({
  ...(await real<typeof import("@/lib/agent")>()),
  issueAgentKey: (...a: unknown[]) => issueAgentKey(...(a as [])),
  mcpServers: (...a: unknown[]) => mcpServers(...(a as [])),
}));

let requests: { url: string; method: string; secret: string }[];
let answer: () => Response;

beforeEach(() => {
  for (const k of Object.keys(doc)) delete doc[k];
  vi.clearAllMocks();
  requests = [];
  answer = () => Response.json({ info: { person_id: "p", entries: [], saved_at: null, unsaved_changes: false }, profile: null });
  vi.stubEnv("FIND_HUMANS_MCP_URL", "https://humans.test/mcp");
  vi.stubEnv("FIND_HUMANS_SIGNING_KEY", "signing-key");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method ?? "GET",
      secret: (init.headers as Record<string, string>)["X-Find-Humans-Secret"],
    });
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the find-humans API", () => {
  it("reads and saves the profile with the secret the user's agent holds", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_ab12_k", agentId: "ab12", findHumansId: "their-id-0123456789" });
    expect((await myProfile("dc-1")).profile).toBeNull();
    await saveMyProfile("dc-1");
    expect(requests).toEqual([
      { url: "https://humans.test/api/me", method: "GET", secret: mintSecret("their-id-0123456789") },
      { url: "https://humans.test/api/me/save", method: "POST", secret: mintSecret("their-id-0123456789") },
    ]);
  });

  it("turns find-humans' codes into messages for the user", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "k", agentId: "ab12", findHumansId: "their-id-0123456789" });
    answer = () => Response.json({ error: { code: "spend_limit_reached" } }, { status: 429 });
    await expect(person("dc-1", "a".repeat(32))).rejects.toMatchObject({ status: 429 });
    answer = () => Response.json({ error: { code: "internal_error" } }, { status: 500 });
    await expect(person("dc-1", "a".repeat(32))).rejects.toMatchObject({ status: 502 });
  });
});

describe("findHumansSecret", () => {
  it("mints the kept id", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "k", agentId: "ab12", findHumansId: "their-id-0123456789" });
    expect(await findHumansSecret("dc-1")).toBe(mintSecret("their-id-0123456789"));
    expect(issueAgentKey).not.toHaveBeenCalled();
  });

  it("reads the id from the agent once for users set up before it was kept", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_ab12_k", agentId: "ab12" });
    expect(await findHumansSecret("dc-1")).toBe(mintSecret("held-id-0123456789"));
    expect(issueAgentKey).toHaveBeenCalledWith("ab12", "admin");
    expect(doc.findHumansId).toBe("held-id-0123456789");
    vi.clearAllMocks();
    await findHumansSecret("dc-1");
    expect(issueAgentKey).not.toHaveBeenCalled();
  });

  it("refuses a user with no email", async () => {
    await expect(findHumansSecret("dc-1")).rejects.toMatchObject({ status: 401 });
  });
});

describe("page prompts", () => {
  it("put the page's instructions before the user's words", () => {
    const search = searchMessage("zk people");
    expect(search.startsWith("[Humans search page.")).toBe(true);
    expect(search).toContain("[Their name](humans:PERSON_ID)");
    expect(search.endsWith("]\n\nzk people")).toBe(true);
    const profile = profileMessage("I build wallets");
    expect(profile.startsWith("[Humans profile page.")).toBe(true);
    expect(profile).toContain("Do not call save_profile");
    expect(profile.endsWith("]\n\nI build wallets")).toBe(true);
  });
});

describe("citedPeople", () => {
  it("lists the people an answer links, in order, each once", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    expect(citedPeople(`[Asha](humans:${a}) and [Cy](humans:${b}), and [Asha again](humans:${a}). [bad](humans:xyz)`)).toEqual([a, b]);
  });
});
