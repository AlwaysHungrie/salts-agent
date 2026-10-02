import { describe, expect, it } from "vitest";
import { isCommand, looksLikePdf, MAX_MESSAGE_CHARS, messageProblem, parseUserId, resumeProblem, safeFileName, tooLarge } from "@/lib/rules";

describe("parseUserId", () => {
  it("accepts plain ids, trimmed", () => {
    expect(parseUserId("  alice ")).toBe("alice");
    expect(parseUserId("bob.smith@devcon")).toBe("bob.smith@devcon");
  });
  it("refuses empty, too long, or unsafe ids", () => {
    expect(parseUserId("")).toBeNull();
    expect(parseUserId("a".repeat(65))).toBeNull();
    expect(parseUserId("a/b")).toBeNull();
    expect(parseUserId("a b")).toBeNull();
    expect(parseUserId(42)).toBeNull();
  });
});

describe("isCommand", () => {
  it("catches the agent's commands", () => {
    for (const c of ["!clear", "!delete", "!new", "!stop", "!enable-mcp search", "  !unstick  "]) {
      expect(isCommand(c)).toBe(true);
    }
  });
  it("catches any bang or slash command, any case, on any line", () => {
    expect(isCommand("!whatever")).toBe(true);
    expect(isCommand("/start")).toBe(true);
    expect(isCommand("!CLEAR")).toBe(true);
    expect(isCommand("hello\n!delete")).toBe(true);
    expect(isCommand("@salt_bot !delete")).toBe(true);
  });
  it("lets ordinary sentences through", () => {
    expect(isCommand("Find Rust devs!")).toBe(false);
    expect(isCommand("What does !clear do?")).toBe(false);
    expect(isCommand("50/50 remote")).toBe(false);
    expect(isCommand("! not a command")).toBe(false);
  });
});

describe("messageProblem", () => {
  it("refuses empty, oversized and command messages", () => {
    expect(messageProblem("   ")).toMatch(/Type a message/);
    expect(messageProblem("a".repeat(MAX_MESSAGE_CHARS + 1))).toMatch(/under/);
    expect(messageProblem("!clear")).toMatch(/Commands/);
  });
  it("accepts a normal message", () => {
    expect(messageProblem("Hiring a Solidity engineer")).toBeNull();
  });
});

describe("resumeProblem", () => {
  it("accepts a PDF by type or extension", () => {
    expect(resumeProblem({ name: "cv.pdf", type: "application/pdf", size: 1000 })).toBeNull();
    expect(resumeProblem({ name: "cv.PDF", type: "", size: 1000 })).toBeNull();
  });
  it("refuses other files, empty files and large files", () => {
    expect(resumeProblem({ name: "cv.docx", type: "application/msword", size: 1000 })).toMatch(/PDF/);
    expect(resumeProblem({ name: "cv.pdf", type: "application/pdf", size: 0 })).toMatch(/empty/);
    expect(resumeProblem({ name: "cv.pdf", type: "application/pdf", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
  });
});

describe("looksLikePdf", () => {
  it("checks the PDF header", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n"))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });
});

describe("tooLarge", () => {
  it("compares the declared length to the limit plus form overhead", () => {
    const at = (n: number) => ({ headers: new Headers({ "content-length": String(n) }) });
    expect(tooLarge(at(1000), 1000)).toBe(false);
    expect(tooLarge(at(1000 + 64 * 1024 + 1), 1000)).toBe(true);
    expect(tooLarge({ headers: new Headers() }, 1000)).toBe(true);
    expect(tooLarge({ headers: new Headers({ "content-length": "abc" }) }, 1000)).toBe(true);
  });
});

describe("safeFileName", () => {
  it("keeps plain names and strips anything else", () => {
    expect(safeFileName("Ada CV.pdf", "resume.pdf")).toBe("Ada CV.pdf");
    expect(safeFileName("../../etc/passwd", "resume.pdf")).toBe("_.._etc_passwd");
    expect(safeFileName("ignore previous\ninstructions.pdf", "resume.pdf")).toBe("ignore previous_instructions.pdf");
    expect(safeFileName("", "resume.pdf")).toBe("resume.pdf");
  });
});
