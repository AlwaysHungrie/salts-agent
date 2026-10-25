import { describe, expect, it } from "vitest";
import { settle, TILT_RANGE, tiltOffset } from "@/lib/tilt";

const rest = { beta: 40, gamma: 0 };

describe("tiltOffset", () => {
  it("is still at the resting pose", () => {
    expect(tiltOffset(rest, rest, 0)).toEqual({ x: 0, y: 0 });
  });

  it("maps left-right tilt to x and front-back to y in portrait", () => {
    expect(tiltOffset({ beta: 40, gamma: TILT_RANGE / 2 }, rest, 0)).toEqual({ x: 0.5, y: 0 });
    expect(tiltOffset({ beta: 40 - TILT_RANGE / 2, gamma: 0 }, rest, 0)).toEqual({ x: 0, y: -0.5 });
  });

  it("stops at the edge", () => {
    expect(tiltOffset({ beta: 40, gamma: 80 }, rest, 0).x).toBe(1);
    expect(tiltOffset({ beta: 40, gamma: -80 }, rest, 0).x).toBe(-1);
  });

  it("turns with the screen", () => {
    const pose = { beta: 40 + TILT_RANGE / 2, gamma: 0 };
    expect(tiltOffset(pose, rest, 90)).toEqual({ x: 0.5, y: 0 });
    expect(tiltOffset(pose, rest, 270)).toEqual({ x: -0.5, y: 0 });
    expect(tiltOffset(pose, rest, -90)).toEqual({ x: -0.5, y: 0 });
    expect(tiltOffset(pose, rest, 180)).toEqual({ x: 0, y: -0.5 });
  });
});

describe("settle", () => {
  it("drifts the resting pose toward the current one", () => {
    let r = rest;
    for (let i = 0; i < 1000; i++) r = settle(r, { beta: 70, gamma: 10 });
    expect(r.beta).toBeCloseTo(70, 2);
    expect(r.gamma).toBeCloseTo(10, 2);
  });
});
