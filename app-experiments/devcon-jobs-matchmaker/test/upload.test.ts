import { describe, expect, it } from "vitest";
import { RESUME_PART_BYTES } from "@/lib/rules";
import { joinParts } from "@/lib/upload";

const P = RESUME_PART_BYTES;
const filled = (n: number, v: number) => new Uint8Array(n).fill(v);

describe("joinParts", () => {
  const size = 2 * P + 10;
  const parts = [
    { part: 2, data: filled(10, 3) },
    { part: 0, data: filled(P, 1) },
    { part: 1, data: filled(P, 2) },
  ];

  it("joins parts in order, whatever order they arrive in", () => {
    const out = joinParts(parts, 3, size)!;
    expect(out.byteLength).toBe(size);
    expect([out[0], out[P - 1], out[P], out[2 * P], out[size - 1]]).toEqual([1, 1, 2, 3, 3]);
  });

  it("refuses a missing, repeated or wrong-sized part", () => {
    expect(joinParts(parts.slice(1), 3, size)).toBeNull();
    expect(joinParts([parts[1], parts[1], parts[0]], 3, size)).toBeNull();
    expect(joinParts([parts[0], parts[1], { part: 2, data: filled(9, 3) }], 3, size)).toBeNull();
  });
});
