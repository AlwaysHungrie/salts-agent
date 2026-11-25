import { afterEach, describe, expect, it, vi } from "vitest";
import { similarities } from "../src/session/context";
import type { SessionHost } from "../src/session/types";

/**
 * Passage vectors for search_files: embedded once per session and kept, billed to the
 * turn, and never the reason a search fails.
 */

/** Just enough of a session: settings, the embeddings table, the key, the turn's spend. */
function fakeHost() {
  const table = new Map<string, string>();
  const spend = { reported: 0 };
  const host = {
    settings: () => ({ embedding_model: "baai/bge-m3" }),
    openrouterKey: () => "or-key",
    usage: () => spend,
    exec: (sql: string, ...args: string[]) => {
      if (sql.startsWith("SELECT")) {
        const v = table.get(args[0]);
        return v ? [{ vector: v }] : [];
      }
      table.set(args[0], args[1]);
      return [];
    },
  } as unknown as SessionHost;
  return { host, table, spend };
}

/** Embeddings by keyword: [mentions money, mentions weather]. */
function stubEmbeddings(status = 200) {
  const asked: string[][] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://openrouter.ai/api/v1/embeddings");
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    expect(body.model).toBe("baai/bge-m3");
    asked.push(body.input);
    if (status !== 200) return new Response("down", { status });
    return Response.json({
      data: body.input.map((t, index) => ({
        index,
        embedding: [/cost|dollar|price/i.test(t) ? 1 : 0, /sun|rain/i.test(t) ? 1 : 0, 0.01],
      })),
      usage: { cost: 0.00002 },
    });
  });
  return asked;
}

afterEach(() => vi.restoreAllMocks());

describe("similarities", () => {
  const passages = ["Plans start at ten dollars.", "It was sunny at the beach."];

  it("scores each passage against the query and bills the turn", async () => {
    const { host, spend } = fakeHost();
    stubEmbeddings();
    const scores = (await similarities(host, "what does it cost", passages))!;
    expect(scores[0]).toBeGreaterThan(scores[1]);
    // Two calls: the query, and one batch of passages.
    expect(spend.reported).toBeCloseTo(0.00004);
  });

  it("embeds a passage once: the next search only embeds the query", async () => {
    const { host, table } = fakeHost();
    const asked = stubEmbeddings();
    await similarities(host, "cost", passages);
    expect(table.size).toBe(2);
    asked.length = 0;
    await similarities(host, "weather", passages);
    expect(asked).toEqual([["weather"]]);
  });

  it("gives null, not an error, when embedding fails", async () => {
    const { host, table } = fakeHost();
    stubEmbeddings(502);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await similarities(host, "cost", passages)).toBeNull();
    expect(table.size).toBe(0);
  });
});
