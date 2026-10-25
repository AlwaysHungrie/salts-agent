import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";
import { newChat } from "@/lib/chat";

const doc: Record<string, unknown> = {};
const col = {
  findOne: vi.fn(async () => ({ ...doc })),
  updateOne: vi.fn(async (_q: unknown, u: { $unset?: Record<string, string> }) => {
    for (const k of Object.keys(u.$unset ?? {})) delete doc[k];
  }),
  findOneAndUpdate: vi.fn(async (_q: unknown, u: { $set: Record<string, unknown> }) => {
    const before = { ...doc };
    Object.assign(doc, u.$set);
    return before;
  }),
};
vi.mock("@/lib/db", () => ({ users: async () => col }));

const createSession = vi.fn();
const deleteSession = vi.fn(async () => {});
const stream = vi.fn();
vi.mock("@/lib/agent", async (real) => ({
  ...(await real<typeof import("@/lib/agent")>()),
  createSession: (...a: unknown[]) => createSession(...a),
  deleteSession: (...a: unknown[]) => deleteSession(...(a as [])),
  stream: (...a: unknown[]) => stream(...a),
}));

const userKeyFor = vi.fn(async () => "salt_user_new1_k");
vi.mock("@/lib/provision", () => ({ userKeyFor: (...a: unknown[]) => userKeyFor(...(a as [])) }));

beforeEach(() => {
  for (const k of Object.keys(doc)) delete doc[k];
  vi.clearAllMocks();
});

describe("newChat", () => {
  it("uses the kept key and replaces the last session", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_old1_k", sessionId: "old1~s0" });
    createSession.mockResolvedValueOnce("old1~s1");
    await newChat("dc-1");
    expect(userKeyFor).not.toHaveBeenCalled();
    expect(doc.sessionId).toBe("old1~s1");
    expect(deleteSession).toHaveBeenCalledWith("salt_user_old1_k", "old1~s0");
  });

  it("sets the agent up again when the kept key no longer works", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_gone_k", agentId: "gone", sessionId: "gone~s0" });
    createSession.mockRejectedValueOnce(new AgentError("unauthorized", 401)).mockResolvedValueOnce("new1~s1");
    await newChat("dc-1");
    expect(userKeyFor).toHaveBeenCalledWith("dc-1", "a@x.com");
    expect(createSession).toHaveBeenLastCalledWith("salt_user_new1_k", "Humans search");
    expect(doc.sessionId).toBe("new1~s1");
  });

  it("does not retry other failures", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_old1_k" });
    createSession.mockRejectedValueOnce(new AgentError("Cannot reach the agent.", 502));
    await expect(newChat("dc-1")).rejects.toMatchObject({ status: 502 });
    expect(userKeyFor).not.toHaveBeenCalled();
  });
});

describe("oneShot", () => {
  it("sends one message in a session of its own, deleted once the reply has streamed", async () => {
    const { oneShot } = await import("@/lib/chat");
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_old1_k", sessionId: "old1~search" });
    createSession.mockResolvedValueOnce("old1~once");
    stream.mockResolvedValueOnce(new Response("data: {}\n\n").body);
    const reply = await oneShot("dc-1", "I build wallets");
    expect(stream).toHaveBeenCalledWith("salt_user_old1_k", "old1~once", "I build wallets", undefined);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(await new Response(reply).text()).toBe("data: {}\n\n");
    expect(deleteSession).toHaveBeenCalledWith("salt_user_old1_k", "old1~once");
    expect(doc.sessionId).toBe("old1~search"); // the search page's session is left alone
  });

  it("deletes the session when the message is refused", async () => {
    const { oneShot } = await import("@/lib/chat");
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_old1_k" });
    createSession.mockResolvedValueOnce("old1~once");
    stream.mockRejectedValueOnce(new AgentError("busy", 409));
    await expect(oneShot("dc-1", "hi")).rejects.toMatchObject({ status: 409 });
    expect(deleteSession).toHaveBeenCalledWith("salt_user_old1_k", "old1~once");
  });
});

describe("ensureAgent", () => {
  it("sets up an agent the first time only", async () => {
    const { ensureAgent } = await import("@/lib/chat");
    Object.assign(doc, { email: "a@x.com" });
    await ensureAgent("dc-1");
    expect(userKeyFor).toHaveBeenCalledWith("dc-1", "a@x.com");
    Object.assign(doc, { userKey: "salt_user_new1_k" });
    vi.clearAllMocks();
    await ensureAgent("dc-1");
    expect(userKeyFor).not.toHaveBeenCalled();
  });

  it("refuses a user with no email", async () => {
    const { ensureAgent } = await import("@/lib/chat");
    await expect(ensureAgent("dc-1")).rejects.toThrow("Pick up your badge again.");
  });
});
