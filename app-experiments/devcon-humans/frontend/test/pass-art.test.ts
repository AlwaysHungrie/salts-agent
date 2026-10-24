import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { passArt } from "@/lib/pass-art";

// A real ticket, not committed (as in pkpass.test.ts).
const SAMPLE = join(__dirname, "fixtures", "devcon.pkpass");

describe.skipIf(!existsSync(SAMPLE))("passArt on a real Devcon .pkpass", () => {
  it("reads its logo and colours", () => {
    const art = passArt(new Uint8Array(readFileSync(SAMPLE)))!;
    expect(art.logo?.length).toBeGreaterThan(0);
    expect(art.background).not.toBeNull();
  });
});

describe("passArt", () => {
  it("reads the logo and colours", () => {
    const json = JSON.stringify({
      backgroundColor: "#f4f5fd",
      foregroundColor: "#160b2b",
      labelColor: "#594d73",
    });
    const art = passArt(
      zipSync({ "pass.json": strToU8(json), "logo.png": strToU8("L") }),
    )!;
    expect(new TextDecoder().decode(art.logo!)).toBe("L");
    expect(art).toMatchObject({
      background: "#f4f5fd",
      foreground: "#160b2b",
      label: "#594d73",
    });
  });

  it("prefers the @2x images", () => {
    const art = passArt(
      zipSync({ "logo.png": strToU8("1x"), "logo@2x.png": strToU8("2x") }),
    )!;
    expect(new TextDecoder().decode(art.logo!)).toBe("2x");
  });

  it("drops colours CSS should not take as given", () => {
    const json = JSON.stringify({
      backgroundColor: "red; background: url(x)",
      foregroundColor: "rgb(1, 2, 3)",
    });
    expect(passArt(zipSync({ "pass.json": strToU8(json) }))).toMatchObject({
      background: null,
      foreground: "rgb(1, 2, 3)",
    });
  });

  it("is null for what is not a zip", () => {
    expect(passArt(strToU8("not a pass"))).toBeNull();
  });
});
