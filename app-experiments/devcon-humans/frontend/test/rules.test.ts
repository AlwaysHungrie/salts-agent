import { describe, expect, it } from "vitest";
import { isCommand, MAX_MESSAGE_CHARS, messageProblem } from "@/lib/rules";

describe("messageProblem", () => {
  it("lets ordinary messages through", () => {
    expect(messageProblem("Who here builds AI agents?")).toBeNull();
    expect(messageProblem("I run brand deals / sponsorships")).toBeNull();
  });
  it("refuses empty, long and command messages", () => {
    expect(messageProblem("  ")).toBe("Type a message first.");
    expect(messageProblem("x".repeat(MAX_MESSAGE_CHARS + 1))).toMatch(/under/);
    expect(messageProblem("hi\n!reset")).toMatch(/Commands/);
  });
});

describe("isCommand", () => {
  it("catches a command on any line, even after a mention", () => {
    expect(isCommand("/model gpt")).toBe(true);
    expect(isCommand("@salts_bot !help")).toBe(true);
    expect(isCommand("a/b testing")).toBe(false);
  });
});
