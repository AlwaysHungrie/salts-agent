import { afterEach, describe, expect, it } from "vitest";
import { adminEmail, emailUserId, isAdminKey } from "@/lib/admin";

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
