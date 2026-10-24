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
vi.mock("@/lib/agent", async (real) => ({
  ...(await real<typeof import("@/lib/agent")>()),
  createSession: (...a: unknown[]) => createSession(...a),
  deleteSession: (...a: unknown[]) => deleteSession(...(a as [])),
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
    expect(createSession).toHaveBeenLastCalledWith("salt_user_new1_k", "Devcon Humans");
    expect(doc.sessionId).toBe("new1~s1");
  });

  it("does not retry other failures", async () => {
    Object.assign(doc, { email: "a@x.com", userKey: "salt_user_old1_k" });
    createSession.mockRejectedValueOnce(new AgentError("Cannot reach the agent.", 502));
    await expect(newChat("dc-1")).rejects.toMatchObject({ status: 502 });
    expect(userKeyFor).not.toHaveBeenCalled();
  });
});
