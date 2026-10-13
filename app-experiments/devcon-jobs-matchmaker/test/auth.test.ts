import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined) }),
}));

const { authorize, sameOrigin } = await import("@/lib/auth");
const { readSession, SESSION_COOKIE, signSession } = await import("@/lib/session");

const SECRET = "x".repeat(40);
const ALICE = { userId: "dc-alice", name: "alice" };

function req(method: string, headers: Record<string, string> = {}) {
  return new Request("http://app.test/api/users/dc-alice/chat", { method, headers: { host: "app.test", ...headers } });
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  cookieJar.clear();
});

describe("session JWT", () => {
  it("round-trips the user id and name", async () => {
    expect(await readSession(await signSession(ALICE))).toEqual(ALICE);
  });

  it("refuses missing, tampered and foreign tokens", async () => {
    const token = await signSession(ALICE);
    expect(await readSession(undefined)).toBeNull();
    expect(await readSession("nonsense")).toBeNull();
    const [h, p, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "dc-bob" })).toString("base64url");
    expect(await readSession(`${h}.${forged}.${sig}`)).toBeNull();
    vi.stubEnv("SESSION_SECRET", "y".repeat(40));
    expect(await readSession(token)).toBeNull();
  });

  it("refuses an unsigned token", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none" })}.${enc({ sub: "dc-alice", name: "alice", iss: "devcon-jobs-matchmaker", aud: "devcon-jobs-matchmaker" })}.`;
    expect(await readSession(none)).toBeNull();
  });

  it("fails closed without a usable secret", async () => {
    const token = await signSession(ALICE);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(await readSession(token)).toBeNull();
    await expect(signSession(ALICE)).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("sameOrigin", () => {
  it("matches the Origin to the host", () => {
    expect(sameOrigin(req("POST", { origin: "http://app.test" }))).toBe(true);
    expect(sameOrigin(req("POST", { origin: "https://evil.test" }))).toBe(false);
    expect(sameOrigin(req("POST"))).toBe(false);
    expect(sameOrigin(req("POST", { origin: "null" }))).toBe(false);
  });
});

describe("authorize", () => {
  it("refuses a caller with no session", async () => {
    expect(((await authorize(req("GET"), "dc-alice")) as Response).status).toBe(401);
    expect(((await authorize(req("GET", { authorization: "Bearer junk" }), "dc-alice")) as Response).status).toBe(401);
  });

  it("lets a user reach only their own routes", async () => {
    cookieJar.set(SESSION_COOKIE, await signSession(ALICE));
    expect(await authorize(req("GET"), "dc-alice")).toBe("dc-alice");
    expect(((await authorize(req("GET"), "dc-bob")) as Response).status).toBe(403);
    expect(((await authorize(req("GET"), "../dc-alice")) as Response).status).toBe(403);
  });

  it("accepts a bearer JWT without an Origin", async () => {
    const token = await signSession(ALICE);
    expect(await authorize(req("POST", { authorization: `Bearer ${token}` }), "dc-alice")).toBe("dc-alice");
  });

  it("refuses cookie-borne writes from another site", async () => {
    cookieJar.set(SESSION_COOKIE, await signSession(ALICE));
    expect(((await authorize(req("POST", { origin: "https://evil.test" }), "dc-alice")) as Response).status).toBe(403);
    expect(((await authorize(req("DELETE"), "dc-alice")) as Response).status).toBe(403);
    expect(await authorize(req("POST", { origin: "http://app.test" }), "dc-alice")).toBe("dc-alice");
  });

  it("does not fall back to the cookie when a bad bearer is sent", async () => {
    cookieJar.set(SESSION_COOKIE, await signSession(ALICE));
    expect(((await authorize(req("GET", { authorization: "Bearer junk" }), "dc-alice")) as Response).status).toBe(401);
  });
});
