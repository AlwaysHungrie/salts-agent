import { describe, expect, it } from "vitest";
import { parseProfile } from "@/lib/profile";

describe("parseProfile", () => {
  it("reads a stored name and email", () => {
    expect(parseProfile('{"name":"asha","email":"asha@x.com"}')).toEqual({ name: "asha", email: "asha@x.com" });
  });

  it("ignores anything else", () => {
    for (const raw of [null, "", "nope", "{}", '{"name":"a"}', '{"name":1,"email":"a@x.com"}'])
      expect(parseProfile(raw)).toBeNull();
  });
});
