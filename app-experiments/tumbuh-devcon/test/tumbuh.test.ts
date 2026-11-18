import { describe, expect, it } from "vitest";
import { usdcUnits } from "@/lib/pricing";
import { parseVerdict } from "@/lib/vision";

describe("usdcUnits", () => {
  it("prices 100 ml at 2 INR", () => expect(usdcUnits(100)).toBe(21053n));
  it("pays nothing for no water", () => expect(usdcUnits(0)).toBe(0n));
  it("never rounds a positive amount to zero", () => expect(usdcUnits(0.0001)).toBe(1n));
});

describe("parseVerdict", () => {
  it("reads a verdict", () =>
    expect(parseVerdict('{"bottle": true, "extra_ml": 30}')).toEqual({ bottle: true, extraMl: 30 }));
  it("floors a found bottle at 1 ml", () =>
    expect(parseVerdict('{"bottle": true, "extra_ml": 0}').extraMl).toBe(1));
  it("caps at the bottle size", () =>
    expect(parseVerdict('{"bottle": true, "extra_ml": 5000}').extraMl).toBe(1000));
  it("no bottle", () => expect(parseVerdict('{"bottle": false, "extra_ml": 9}').bottle).toBe(false));
  it("garbage is no bottle", () => expect(parseVerdict("nope").bottle).toBe(false));
});
