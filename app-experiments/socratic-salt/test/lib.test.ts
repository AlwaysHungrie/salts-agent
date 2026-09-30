import { describe, expect, it } from "vitest";
import { composePrompt, excerpt, splitPrompt, suggestions } from "@/lib/prompt";
import { sameOrigin } from "@/lib/origin";

describe("prompt", () => {
  it("round-trips reasoning and context", () => {
    const prompt = composePrompt("  Argue for Salt.\n", "# Context\n\nThe decision.");
    expect(splitPrompt(prompt)).toEqual({
      reasoning: "Argue for Salt.",
      context: "# Context\n\nThe decision.",
    });
  });

  it("omits the marker when there is no context", () => {
    expect(composePrompt("Only reasoning.", "  ")).toBe("Only reasoning.");
    expect(splitPrompt("Only reasoning.")).toEqual({ reasoning: "Only reasoning.", context: "" });
  });

  it("excerpts the first prose paragraph", () => {
    const md = "# Title\n\nSep 29 · @x\n\n## What\n\nWe need to decide how to brand [Salt](https://s). Talk it through.";
    expect(excerpt(md)).toBe("We need to decide how to brand Salt. Talk it through.");
    expect(excerpt(md, 20)).toBe("We need to decide h…");
  });
});

describe("suggestions", () => {
  it("takes the quoted list under the asking heading", () => {
    const md = "## The options\n\n- Not this\n\n## What to ask it\n\nSome ways:\n\n- \"Spark is better.\"\n- “Why two brands?”\n- What would change your mind?\n\n## After\n\n- Not this either";
    expect(suggestions(md)).toEqual(["Spark is better.", "Why two brands?", "What would change your mind?"]);
    expect(suggestions(md, 1)).toEqual(["Spark is better."]);
  });

  it("is empty when the document suggests nothing", () => {
    expect(suggestions("# Title\n\n- a list\n")).toEqual([]);
  });
});

describe("sameOrigin", () => {
  it("trusts sec-fetch-site first", () => {
    expect(sameOrigin(new Headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(new Headers({ "sec-fetch-site": "cross-site", origin: "https://a", host: "a" }))).toBe(false);
  });

  it("falls back to origin vs host", () => {
    expect(sameOrigin(new Headers({ origin: "https://app.test", host: "app.test" }))).toBe(true);
    expect(sameOrigin(new Headers({ origin: "https://evil.test", host: "app.test" }))).toBe(false);
    expect(sameOrigin(new Headers({ host: "app.test" }))).toBe(false);
  });
});
