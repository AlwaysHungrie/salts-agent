import { describe, expect, it } from "vitest";
import { readFrames } from "@/lib/sse";

describe("readFrames", () => {
  it("returns complete frames and keeps the unfinished tail", () => {
    const { events, rest } = readFrames('data: {"type":"delta","text":"Hi"}\n\ndata: {"type":"to');
    expect(events).toEqual([{ type: "delta", text: "Hi" }]);
    expect(rest).toBe('data: {"type":"to');
    const next = readFrames(rest + 'ol","name":"search"}\n\n');
    expect(next.events).toEqual([{ type: "tool", name: "search" }]);
    expect(next.rest).toBe("");
  });
  it("skips comments and frames that are not JSON", () => {
    const { events } = readFrames(': ping\n\ndata: oops\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: "done" }]);
  });
});
