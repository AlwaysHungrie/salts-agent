import { describe, expect, it } from "vitest";
import {
  AGENT_SEPARATOR,
  agentIdOf,
  emailAllowed,
  normalizeEmails,
  sessionIdForChat,
  sessionName,
  splitEmails,
  thisMonth,
} from "../src/registry";
import { SHIPPED } from "./shipped";

const MAX_MEMBERS = SHIPPED.max_members;

/**
 * The functions that decide who someone is and what they may open.
 *
 * Pure, and load-bearing out of proportion to their size: `emailAllowed` is the last
 * word on every access check in the Worker, and `agentIdOf` is how a session id is
 * turned back into the agent whose access list applies. A bug in either is an
 * authorization bug, not a formatting one, so the cases below are mostly about the
 * inputs that are *not* well formed.
 */

describe("session ids", () => {
  it("round-trips an agent id through a session name", () => {
    expect(agentIdOf(sessionName("abc12345", "local"))).toBe("abc12345");
  });

  it("returns no agent for an id that carries no separator", () => {
    // The caller treats "" as "not one of ours" and refuses the request. If this
    // returned the whole string instead, an arbitrary id would name an agent.
    expect(agentIdOf("nosuchsession")).toBe("");
    expect(agentIdOf("")).toBe("");
  });

  it("splits on the first separator only", () => {
    // A local part containing the separator must not move the boundary: the agent is
    // whatever precedes the *first* one, or ids stop being a total function.
    expect(agentIdOf(`agent${AGENT_SEPARATOR}a${AGENT_SEPARATOR}b`)).toBe("agent");
  });

  it("gives a telegram chat the same session id every time", () => {
    expect(sessionIdForChat("ag", "12345")).toBe(sessionIdForChat("ag", "12345"));
  });

  it("separates DMs, groups and forum topics", () => {
    const dm = sessionIdForChat("ag", "12345");
    const group = sessionIdForChat("ag", "-100999");
    const topic = sessionIdForChat("ag", "-100999", "7");
    expect(new Set([dm, group, topic]).size).toBe(3);
  });

  it("gives two agents separate sessions for the same chat", () => {
    expect(sessionIdForChat("one", "12345")).not.toBe(sessionIdForChat("two", "12345"));
  });
});

describe("access lists", () => {
  it("matches an address on the list", () => {
    expect(emailAllowed("a@x.com\nb@x.com", "b@x.com")).toBe(true);
  });

  it("ignores case and surrounding space on both sides", () => {
    expect(emailAllowed("  A@X.com \n b@x.com", "a@x.COM")).toBe(true);
  });

  it("refuses an address that is not on the list", () => {
    expect(emailAllowed("a@x.com", "b@x.com")).toBe(false);
  });

  it("refuses an empty address against any list", () => {
    // `callerEmail` returns "" when nobody was identified, and that value reaches
    // here directly. Matching it would open every agent to anonymous callers.
    expect(emailAllowed("a@x.com\n\nb@x.com", "")).toBe(false);
    expect(emailAllowed("", "")).toBe(false);
    expect(emailAllowed("   ", "  ")).toBe(false);
  });

  it("refuses a partial match", () => {
    // Substring matching here would let a@x.com.evil.com in on a list naming a@x.com.
    expect(emailAllowed("a@x.com", "a@x.co")).toBe(false);
    expect(emailAllowed("a@x.com", "a@x.com.evil.com")).toBe(false);
  });

  it("drops blank lines when reading a stored list", () => {
    expect(splitEmails("a@x.com\n\n  \nb@x.com\n")).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("normalizeEmails", () => {
  it("accepts commas, semicolons and newlines as separators", () => {
    expect(normalizeEmails("a@x.com, b@x.com; c@x.com", MAX_MEMBERS)).toBe(
      "a@x.com\nb@x.com\nc@x.com"
    );
  });

  it("lowercases and de-duplicates", () => {
    expect(normalizeEmails(["A@x.com", "a@X.COM", "b@x.com"], MAX_MEMBERS)).toBe(
      "a@x.com\nb@x.com"
    );
  });

  it("drops entries that are not addresses", () => {
    // The box is free text a person pastes into, so prose reaching the list is the
    // ordinary failure, not an exotic one.
    expect(normalizeEmails("please add bob, bob@x.com", MAX_MEMBERS)).toBe("bob@x.com");
    expect(normalizeEmails("not-an-email", MAX_MEMBERS)).toBe("");
    expect(normalizeEmails("a@b", MAX_MEMBERS)).toBe("");
  });

  it("returns an empty list for empty input rather than throwing", () => {
    expect(normalizeEmails("", MAX_MEMBERS)).toBe("");
    expect(normalizeEmails([], MAX_MEMBERS)).toBe("");
  });

  it("refuses a list longer than the ceiling", () => {
    const tooMany = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `u${i}@x.com`);
    expect(() => normalizeEmails(tooMany, MAX_MEMBERS)).toThrow(/at most/);
  });

  it("allows a list exactly at the ceiling", () => {
    const exactly = Array.from({ length: MAX_MEMBERS }, (_, i) => `u${i}@x.com`);
    expect(normalizeEmails(exactly, MAX_MEMBERS).split("\n")).toHaveLength(MAX_MEMBERS);
  });

  it("counts duplicates once against the ceiling", () => {
    // De-duplication happens before the check, so a paste with repeats is not refused
    // for a length it does not actually have.
    const dupes = Array.from({ length: MAX_MEMBERS + 10 }, () => "same@x.com");
    expect(normalizeEmails(dupes, MAX_MEMBERS)).toBe("same@x.com");
  });
});

describe("thisMonth", () => {
  it("is the calendar month in UTC", () => {
    expect(thisMonth(Date.UTC(2026, 0, 15))).toBe("2026-01");
  });

  it("does not drift at a month boundary", () => {
    expect(thisMonth(Date.UTC(2026, 0, 31, 23, 59, 59))).toBe("2026-01");
    expect(thisMonth(Date.UTC(2026, 1, 1, 0, 0, 0))).toBe("2026-02");
  });
});
