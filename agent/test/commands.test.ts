import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands";

/**
 * Bang commands, matched before a turn is ever started.
 *
 * The rule that carries the risk is the strict one: only a message that is *nothing
 * but* the command counts. `!delete` destroys a session, and matching it anywhere in
 * a sentence would mean that asking how the feature works is how you find out.
 */

describe("parseCommand", () => {
  it("recognises each command on its own", () => {
    expect(parseCommand("!unstick")).toBe("unstick");
    expect(parseCommand("!delete")).toBe("delete");
    expect(parseCommand("!new")).toBe("new");
    expect(parseCommand("!clear")).toBe("clear");
    expect(parseCommand("!stop")).toBe("stop");
    expect(parseCommand("!compact")).toBe("compact");
    expect(parseCommand("!oom")).toBe("oom");
  });

  it("ignores case and surrounding space", () => {
    expect(parseCommand("  !DELETE  ")).toBe("delete");
  });

  it("is nothing for an ordinary message", () => {
    expect(parseCommand("hello there")).toBe(null);
    expect(parseCommand("")).toBe(null);
  });

  it("does not match a command mentioned inside a sentence", () => {
    // The case this rule exists for.
    expect(parseCommand("what does !delete do?")).toBe(null);
    expect(parseCommand("type !new to start over")).toBe(null);
  });

  it("does not match a command without its bang", () => {
    expect(parseCommand("delete")).toBe(null);
  });

  it("does not match an unknown bang word", () => {
    expect(parseCommand("!destroy")).toBe(null);
  });

  it("does not match a command with something appended", () => {
    expect(parseCommand("!deleteall")).toBe(null);
    expect(parseCommand("!delete now")).toBe(null);
  });

  it("allows a leading mention, which a group chat requires", () => {
    expect(parseCommand("@mybot !delete")).toBe("delete");
  });

  it("allows a trailing mention", () => {
    expect(parseCommand("!delete @mybot")).toBe("delete");
  });

  it("still refuses a sentence that carries a mention", () => {
    expect(parseCommand("@mybot should I use !delete here?")).toBe(null);
  });

  it("parses !enable-mcp and !disable-mcp with a server name", () => {
    expect(parseCommand("!enable-mcp Notion")).toEqual({ mcp: "enable", server: "Notion" });
    expect(parseCommand("  !DISABLE-MCP  my server ")).toEqual({ mcp: "disable", server: "my server" });
    expect(parseCommand("@mybot !enable-mcp notion")).toEqual({ mcp: "enable", server: "notion" });
  });

  it("does not match an mcp command without a server name", () => {
    expect(parseCommand("!enable-mcp")).toBe(null);
    expect(parseCommand("!disable-mcp   ")).toBe(null);
  });

  it("does not match an mcp command inside a sentence", () => {
    expect(parseCommand("how do I use !enable-mcp notion?")).toBe(null);
  });
});
