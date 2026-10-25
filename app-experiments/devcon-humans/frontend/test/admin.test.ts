import { afterEach, describe, expect, it } from "vitest";
import { adminEmail, emailUserId, isAdminEmail, isAdminKey, isAdminSession } from "@/lib/admin";
import { readSession, signSession } from "@/lib/session";

const KEY = "k".repeat(40);

afterEach(() => {
  delete process.env.HUMANS_ADMIN_KEY;
});

describe("isAdminKey", () => {
  it("accepts only the server's key", () => {
    process.env.HUMANS_ADMIN_KEY = KEY;
    expect(isAdminKey(KEY)).toBe(true);
    expect(isAdminKey(KEY + "x")).toBe(false);
    expect(isAdminKey("")).toBe(false);
    expect(isAdminKey(null)).toBe(false);
  });

  it("is off without a key, or with one under 32 characters", () => {
    expect(isAdminKey(KEY)).toBe(false);
    process.env.HUMANS_ADMIN_KEY = "short";
    expect(isAdminKey("short")).toBe(false);
  });
});

describe("adminEmail", () => {
  it("trims and lower-cases an email", () => {
    expect(adminEmail("  Asha@Example.COM ")).toBe("asha@example.com");
  });

  it("refuses what is not one", () => {
    for (const v of ["", "asha", "a b@x.com", "a@b@c", 7, null]) expect(adminEmail(v)).toBeNull();
  });
});

describe("emailUserId", () => {
  it("is stable per email and unlike a ticket's id", () => {
    expect(emailUserId("a@x.com")).toBe(emailUserId("a@x.com"));
    expect(emailUserId("a@x.com")).not.toBe(emailUserId("b@x.com"));
    expect(emailUserId("a@x.com")).toMatch(/^dc-email-[0-9a-f]{32}$/);
  });
});

describe("isAdminEmail", () => {
  it("knows the admin's ticket, whatever its case", () => {
    expect(isAdminEmail("dhairyashah98@gmail.com")).toBe(true);
    expect(isAdminEmail(" DhairyaShah98@Gmail.com ")).toBe(true);
    expect(isAdminEmail("someone@example.com")).toBe(false);
  });
});

describe("admin sessions", () => {
  it("carry the claim through the JWT, and only when set", async () => {
    process.env.SESSION_SECRET = "s".repeat(40);
    const admin = await readSession(await signSession({ userId: "dc-1", name: "d", admin: true }));
    const plain = await readSession(await signSession({ userId: "dc-2", name: "a" }));
    expect(admin).toEqual({ userId: "dc-1", name: "d", admin: true });
    expect(plain).toEqual({ userId: "dc-2", name: "a", admin: false });
    expect(await isAdminSession(admin)).toBe(true);
    expect(await isAdminSession(null)).toBe(false);
  });
});
