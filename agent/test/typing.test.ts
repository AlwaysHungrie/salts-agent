import { describe, expect, it } from "vitest";
import type { Channel, ChannelTarget } from "../src/channel";
import { keepTyping } from "../src/session/channels";

function fakeChannel(fail = false): { channel: Channel; count: () => number } {
  let calls = 0;
  const channel = {
    id: "telegram",
    typingEveryMs: 10,
    typing: async () => {
      calls++;
      if (fail) throw new Error("rate limited");
    },
  } as unknown as Channel;
  return { channel, count: () => calls };
}

const target: ChannelTarget = { to: "1" };

describe("keepTyping", () => {
  it("repeats the indicator through a long turn and stops when told", async () => {
    const { channel, count } = fakeChannel();
    const stop = keepTyping(channel, target);
    await scheduler.wait(65);
    stop();
    const atStop = count();
    expect(atStop).toBeGreaterThanOrEqual(3);
    await scheduler.wait(40);
    expect(count()).toBe(atStop);
  });

  it("keeps going when one indicator fails", async () => {
    const { channel, count } = fakeChannel(true);
    const stop = keepTyping(channel, target);
    await scheduler.wait(45);
    stop();
    expect(count()).toBeGreaterThanOrEqual(2);
  });
});
