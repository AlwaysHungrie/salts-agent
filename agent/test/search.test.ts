import { describe, expect, it } from "vitest";
import { CAPABILITY_BY_ID, runTool, toolsFor, type ToolContext } from "../src/capabilities";
import { DEFAULT_CONFIG, type Config } from "../src/registry";
import { distance, passageOf, passages, search, searchHybrid, words } from "../src/session/search";
import { SHIPPED } from "./shipped";

/**
 * Search over the chat's documents: the passages a question needs come back, so a long
 * document never has to sit in the conversation.
 */

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `filler${i % 7} words here`).join(" ");

const contract = {
  name: "contract.pdf",
  text: `${filler(150)} The tenant may cancel the lease with ninety days written notice. ${filler(150)} Rent is due on the first of each month, paid by bank transfer. ${filler(150)}`,
};
const recipe = {
  name: "recipe.md",
  text: "Whisk two eggs with sugar. Bake at 180 degrees for 25 minutes.",
};

describe("words", () => {
  it("lowercases, keeps any script and numbers, and drops stopwords", () => {
    expect(words("The Tenant may cancel in 90 days — किराया")).toEqual([
      "tenant",
      "may",
      "cancel",
      "90",
      "days",
      "किराया",
    ]);
  });
});

describe("passages", () => {
  it("cuts a long text into overlapping passages that cover all of it", () => {
    const cut = passages(contract.text);
    expect(cut.length).toBeGreaterThan(2);
    for (const p of cut) expect(p.length).toBeLessThanOrEqual(1200);
    // Overlap: each passage starts inside the one before it.
    expect(cut[0]).toContain(cut[1].slice(0, 40));
    expect(cut.join(" ")).toContain("ninety days written notice");
  });

  it("keeps a short text whole, and an empty one as nothing", () => {
    expect(passages(recipe.text)).toEqual([recipe.text]);
    expect(passages("   ")).toEqual([]);
  });
});

describe("search", () => {
  it("ranks the passage holding the answer first, across documents", () => {
    const [best] = search([recipe, contract], "how much notice to cancel the lease?", 3);
    expect(best.name).toBe("contract.pdf");
    expect(best.text).toContain("ninety days written notice");
  });

  it("finds a different passage for a different question", () => {
    const [best] = search([recipe, contract], "when is rent due", 1);
    expect(best.text).toContain("first of each month");
  });

  it("matches a close spelling, as captions write names (Riemann → Reman)", () => {
    const captions = {
      name: "talk (transcript).txt",
      text: `${filler(100)} The Reman hypothesis is about prime numbers. ${filler(100)}`,
    };
    const [best] = search([captions, recipe], "Riemann", 1);
    expect(best?.text).toContain("Reman hypothesis");
  });

  it("ranks the exact word above a near spelling", () => {
    const exact = { name: "exact.txt", text: "the riemann zeta function" };
    const near = { name: "near.txt", text: "the reman zeta function" };
    expect(search([near, exact], "riemann", 2).map((p) => p.name)).toEqual([
      "exact.txt",
      "near.txt",
    ]);
  });

  it("does not stretch short words to other words", () => {
    // "bake" must not find "cake", nor "rent" "rest".
    expect(search([{ name: "a", text: "a cake to rest" }], "bake rent", 5)).toEqual([]);
  });

  it("returns nothing when no word matches, or the query is only stopwords", () => {
    expect(search([recipe, contract], "spaceship", 5)).toEqual([]);
    expect(search([recipe, contract], "what is the", 5)).toEqual([]);
  });
});

describe("distance", () => {
  it("counts edits, and stops early past the limit", () => {
    expect(distance("riemann", "reman", 2)).toBe(2);
    expect(distance("kitten", "sitting", 3)).toBe(3);
    expect(distance("abc", "abcdefgh", 2)).toBe(3);
  });
});

describe("passageOf", () => {
  it("reads a document by part number, and says none past the end", () => {
    const first = passageOf(contract, 1)!;
    expect(first.part).toBe(1);
    expect(first.parts).toBe(passages(contract.text).length);
    expect(passageOf(contract, first.parts + 1)).toBeNull();
    expect(passageOf(contract, 0)).toBeNull();
  });
});

const config = (patch: Partial<Config> = {}): Config => ({
  model: "vendor/model",
  ...SHIPPED.config_defaults,
  ...DEFAULT_CONFIG,
  ...patch,
});

/** Keyword search only: as when embeddings are unavailable. */
const ctxWith = (docs: { name: string; text: string }[]) =>
  ({ documents: async () => docs, similarities: async () => null }) as unknown as ToolContext;

describe("search_files", () => {
  const run = (args: Record<string, unknown>, docs = [recipe, contract]) =>
    runTool("search_files", args, ctxWith(docs));

  it("is offered once when File ingest, YouTube summaries, or both are on", () => {
    const names = (c: Config) => toolsFor(c).map((t) => t.name);
    expect(names(config())).not.toContain("search_files");
    expect(names(config({ cap_file_ingest: 1 }))).toContain("search_files");
    expect(names(config({ cap_youtube: 1 }))).toContain("search_files");
    const both = names(config({ cap_file_ingest: 1, cap_youtube: 1 }));
    expect(both.filter((n) => n === "search_files")).toHaveLength(1);
    expect(CAPABILITY_BY_ID.get("file_ingest")!.tools).toContain("search_files");
  });

  it("returns the best passages with where each comes from", async () => {
    const result = await run({ query: "cancel lease notice", count: 1 });
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/^\[contract\.pdf, part \d+ of \d+\]\n/);
    expect(result.content).toContain("ninety days written notice");
  });

  it("searches one document when asked, and names the documents when it is not found", async () => {
    const miss = (await run({ query: "eggs", file: "contract.pdf" })).content;
    expect(miss).toContain("Nothing in");
    // A miss points at reading instead: a dead end made the agent give up.
    expect(miss).toMatch(
      /read the documents part by part with file and part: "contract\.pdf" \(\d+ parts\)/
    );
    const missing = await run({ query: "eggs", file: "nope.txt" });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("the documents are: recipe.md, contract.pdf");
  });

  it("reads a document part by part", async () => {
    const result = await run({ file: "contract.pdf", part: 1 });
    expect(result.content).toMatch(/^\[contract\.pdf, part 1 of \d+\]/);
    expect((await run({ file: "contract.pdf", part: 99 })).content).toContain("has no part 99");
  });

  it("says when there is nothing to search, or nothing to search for", async () => {
    expect((await run({ query: "x" }, [])).content).toBe(
      "There are no documents in this chat yet."
    );
    expect((await run({})).content).toContain("pass a query, or a file and a part");
  });
});

describe("searchHybrid", () => {
  const pricing = { name: "plans.md", text: "Our plans start at ten dollars a month." };
  const beach = { name: "trip.md", text: "It was sunny, so everyone went to the beach." };
  /** Meaning, faked: how many words a text shares with a fixed topic. */
  const topical = (topic: string[]) => async (_q: string, texts: string[]) =>
    texts.map((t) => topic.filter((w) => t.toLowerCase().includes(w)).length / topic.length);

  it("finds a paraphrase no word of the question appears in", async () => {
    // "cost" is nowhere in the text: words alone find nothing.
    expect(search([beach, pricing], "how much does it cost", 1)).toEqual([]);
    const [best] = await searchHybrid(
      [beach, pricing],
      "how much does it cost",
      1,
      topical(["dollars", "month", "plans"])
    );
    expect(best.name).toBe("plans.md");
  });

  it("keeps an exact word match near the top even when meaning disagrees", async () => {
    const codes = { name: "codes.txt", text: "Episode 4553 aired on Monday." };
    const found = await searchHybrid(
      [pricing, beach, codes],
      "4553",
      2,
      topical(["dollars"]) // meaning prefers the pricing text
    );
    expect(found.map((p) => p.name)).toContain("codes.txt");
  });

  it("falls back to words alone when meaning is unavailable", async () => {
    const found = await searchHybrid([recipe, contract], "cancel the lease", 1, async () => null);
    expect(found[0].text).toContain("ninety days written notice");
  });
});
