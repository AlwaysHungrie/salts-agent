import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captionText,
  CAPABILITY_BY_ID,
  capabilityReady,
  runTool,
  toolsFor,
  youtubeVideoId,
  type ToolContext,
} from "../src/capabilities";
import { DEFAULT_CONFIG, DEFAULT_META, type Config } from "../src/registry";
import { capabilitiesFor } from "../src/worker/capability-views";
import { validateSettingsPatch } from "../src/settings";
import { SHIPPED } from "./shipped";

/**
 * YouTube summaries: read the captions when the video has them, have the model watch
 * the video when it does not. Every outside call is stubbed — the player API, the
 * caption file and OpenRouter — so these pin down which path a video takes.
 */

const config = (patch: Partial<Config> = {}): Config => ({
  model: "vendor/model",
  ...SHIPPED.config_defaults,
  ...DEFAULT_CONFIG,
  ...patch,
});

/** Files the tool kept in the chat, by name: stands in for the session's attachments. */
let kept: Map<string, string>;

const ctx = {
  config: config({ cap_youtube: 1, youtube_model: "google/gemini-2.5-flash-lite" }),
  openrouterKey: "or-key",
  documents: async () => [...kept].map(([name, text]) => ({ name, text })),
  saveFile: async (bytes: ArrayBuffer, name: string) => {
    kept.set(name, new TextDecoder().decode(bytes));
    return `/files/${name}`;
  },
} as unknown as ToolContext;

beforeEach(() => {
  kept = new Map();
});

const OK_PLAYER = {
  playabilityStatus: { status: "OK" },
  videoDetails: { title: "Neural networks", author: "3Blue1Brown", lengthSeconds: "1107" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=fr", languageCode: "fr" },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr",
          languageCode: "en",
          kind: "asr",
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=srv3",
          languageCode: "en",
        },
      ],
    },
  },
};

/** Answer each outside call in turn, recording what was asked. */
function stub(
  players: unknown[],
  captions = '<transcript><text start="0">This is a 3.</text></transcript>'
) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/youtubei/v1/player")) return Response.json(players.shift() ?? {});
    if (url.includes("/api/timedtext")) return new Response(captions);
    if (url.includes("openrouter.ai")) {
      return Response.json({ choices: [{ message: { content: "- It is about digits." } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const summarize = (url: string) => runTool("youtube_summary", { url }, ctx);
const openrouterCall = (calls: { url: string; body?: unknown }[]) =>
  calls.find((c) => c.url.includes("openrouter.ai"))!.body as {
    model: string;
    messages: { content: unknown }[];
  };

afterEach(() => vi.restoreAllMocks());

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=aircAruvnKk", "aircAruvnKk"],
    ["https://m.youtube.com/watch?v=aircAruvnKk&t=42s", "aircAruvnKk"],
    ["https://youtu.be/aircAruvnKk?si=abc", "aircAruvnKk"],
    ["https://www.youtube.com/shorts/aircAruvnKk", "aircAruvnKk"],
    ["https://www.youtube.com/live/aircAruvnKk", "aircAruvnKk"],
    ["https://music.youtube.com/watch?v=aircAruvnKk", "aircAruvnKk"],
    [" aircAruvnKk ", "aircAruvnKk"],
  ])("reads the id from %s", (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    "https://vimeo.com/123456",
    "https://www.youtube.com/@3blue1brown",
    "https://www.youtube.com/watch?v=short",
    "not a link",
  ])("rejects %s", (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });
});

describe("captionText", () => {
  it("joins cues and decodes entities, including double-escaped ones", () => {
    const xml =
      '<transcript><text start="0" dur="1">It&amp;#39;s a &quot;3&quot;</text><text start="1">&lt;b&gt; &amp; more</text></transcript>';
    expect(captionText(xml)).toBe(`It's a "3" <b> & more`);
  });

  it("reads the paragraph format too", () => {
    expect(captionText('<p t="0" d="1"><s>Hello</s><s> there</s></p>')).toBe("Hello there");
  });
});

describe("the YouTube capability", () => {
  it("offers its tool only when switched on, with or without a fallback model", () => {
    const names = (c: Config) => toolsFor(c).map((t) => t.name);
    expect(names(config({ cap_youtube: 0 }))).not.toContain("youtube_summary");
    expect(names(config({ cap_youtube: 1 }))).toContain("youtube_summary");
    expect(names(config({ cap_youtube: 1 }))).toContain("youtube_search");
    expect(names(config({ cap_youtube: 0 }))).not.toContain("youtube_search");
    expect(
      capabilityReady(
        CAPABILITY_BY_ID.get("youtube")!,
        config({ cap_youtube: 1, youtube_model: "" })
      )
    ).toBe(true);
  });

  it("offers 'None' as the first menu choice, saving an empty value", () => {
    const field = capabilitiesFor(DEFAULT_META, SHIPPED as never)
      .find((c) => c.id === "youtube")!
      .fields.find((f) => f.key === "youtube_model")!;
    expect(field.options![0]).toEqual({ value: "", label: "None" });
    expect(field.options![1].value).toBe("google/gemini-2.5-flash-lite");
  });

  it("starts new agents with no fallback", () => {
    expect(SHIPPED.config_defaults.youtube_model).toBe("");
    // Blank is a real answer for this column only; the other model columns still refuse it.
    expect(
      validateSettingsPatch({ config_defaults: { youtube_model: "" } }, SHIPPED as never)
        .config_defaults?.youtube_model
    ).toBe("");
    expect(() =>
      validateSettingsPatch({ config_defaults: { voice_model: "" } }, SHIPPED as never)
    ).toThrow("cannot be blank");
  });
});

describe("youtube_summary", () => {
  it("summarizes from English uploaded captions when the video has them", async () => {
    const calls = stub([OK_PLAYER]);
    const result = await summarize("https://youtu.be/aircAruvnKk");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Title: Neural networks");
    expect(result.content).toContain("Channel: 3Blue1Brown");
    expect(result.content).toContain("Length: 18:27");
    expect(result.content).toContain("Link: https://www.youtube.com/watch?v=aircAruvnKk");
    expect(result.content).toContain("from the captions");
    expect(result.content).toContain("- It is about digits.");
    // The uploaded English track, asked for in the plain format.
    expect(calls.find((c) => c.url.includes("timedtext"))!.url).toBe(
      "https://www.youtube.com/api/timedtext?v=x&lang=en"
    );
    // The agent's own model reads the captions; only its summary comes back.
    const body = openrouterCall(calls);
    expect(body.model).toBe("vendor/model");
    expect(body.messages[0].content).toContain("This is a 3.");
    expect(result.content).not.toContain("This is a 3.");
    // The transcript is kept in the chat for follow-up questions, once per video.
    expect(result.content).toContain('kept in this chat as "Neural networks (transcript).txt"');
    expect(kept.get("Neural networks (transcript).txt")).toContain("This is a 3.");
    expect(kept.get("Neural networks (transcript).txt")).toContain("Channel: 3Blue1Brown");
    // Asked about again: the kept transcript answers it, not a second summary.
    const again = stub([OK_PLAYER]);
    const second = await summarize("https://youtu.be/aircAruvnKk");
    expect(second.content).toContain("already summarized in this chat");
    expect(second.content).toContain(
      'call search_files with words from the question (file: "Neural networks (transcript).txt")'
    );
    expect(again.some((c) => c.url.includes("openrouter.ai"))).toBe(false);
    expect(kept.size).toBe(1);
  });

  it("has the model watch the video when there are no captions", async () => {
    const calls = stub([{ ...OK_PLAYER, captions: undefined }]);
    const result = await summarize("https://www.youtube.com/watch?v=aircAruvnKk");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("made by watching the video");
    expect(result.content).toContain("Title: Neural networks");
    // Watched, not read: there is no transcript to keep.
    expect(kept.size).toBe(0);
    expect(openrouterCall(calls).model).toBe("google/gemini-2.5-flash-lite");
    expect(JSON.stringify(openrouterCall(calls).messages[0].content)).toContain(
      '"video_url":{"url":"https://www.youtube.com/watch?v=aircAruvnKk"}'
    );
  });

  it("asks again once when YouTube bot-checks the first request", async () => {
    const botCheck = {
      playabilityStatus: {
        status: "LOGIN_REQUIRED",
        reason: "Sign in to confirm you're not a bot",
      },
    };
    const calls = stub([botCheck, OK_PLAYER]);
    const result = await summarize("https://youtu.be/aircAruvnKk");
    expect(calls.filter((c) => c.url.includes("/player")).length).toBe(2);
    expect(result.content).toContain("from the captions");
  });

  it("falls back to watching when YouTube bot-checks both requests", async () => {
    const botCheck = { playabilityStatus: { status: "LOGIN_REQUIRED" } };
    const calls = stub([botCheck, botCheck]);
    const result = await summarize("https://youtu.be/aircAruvnKk");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("made by watching the video");
    expect(result.content).not.toContain("Title:");
    expect(JSON.stringify(openrouterCall(calls).messages[0].content)).toContain("video_url");
  });

  it("says so, without watching, when there are no captions and no fallback model", async () => {
    const calls = stub([{ ...OK_PLAYER, captions: undefined }]);
    const result = await runTool(
      "youtube_summary",
      { url: "https://youtu.be/aircAruvnKk" },
      { ...ctx, config: { ...ctx.config, youtube_model: "" } }
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no fallback model is set");
    expect(calls.some((c) => c.url.includes("openrouter.ai"))).toBe(false);
  });

  it("still summarizes from captions with no fallback model", async () => {
    stub([OK_PLAYER]);
    const result = await runTool(
      "youtube_summary",
      { url: "https://youtu.be/aircAruvnKk" },
      { ...ctx, config: { ...ctx.config, youtube_model: "" } }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("from the captions");
  });

  it("still summarizes when the transcript cannot be kept", async () => {
    stub([OK_PLAYER]);
    const result = await runTool(
      "youtube_summary",
      { url: "https://youtu.be/aircAruvnKk" },
      {
        ...ctx,
        saveFile: async () => {
          throw new Error("the agent's file storage is full");
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("- It is about digits.");
    expect(result.content).toContain(
      "could not be kept in this chat (the agent's file storage is full)"
    );
  });

  it("refuses a link that is not a YouTube video, without calling out", async () => {
    const calls = stub([]);
    const result = await summarize("https://vimeo.com/123456");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("is not a YouTube video link");
    expect(calls).toEqual([]);
  });

  it("reports a failed summary model", async () => {
    stub([OK_PLAYER]);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/player")) return Response.json(OK_PLAYER);
      if (url.includes("timedtext")) return new Response("<text>hi</text>");
      return new Response("video too long", { status: 400 });
    });
    const result = await summarize("https://youtu.be/aircAruvnKk");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("400 video too long");
  });
});

/** A search answer shaped like YouTube's: one section, a shelf to skip, then videos. */
function searchAnswer(videos: object[]) {
  return {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [{ shelfRenderer: {} }, ...videos.map((v) => ({ videoRenderer: v }))],
                },
              },
            ],
          },
        },
      },
    },
  };
}

const video = (id: string, title: string, extra: object = {}) => ({
  videoId: id,
  title: { runs: [{ text: title }] },
  ownerText: { runs: [{ text: "3Blue1Brown" }] },
  lengthText: { simpleText: "18:40" },
  viewCountText: { simpleText: "25,436,647 views" },
  publishedTimeText: { simpleText: "9 years ago" },
  ...extra,
});

function stubSearch(answer: unknown, status = 200) {
  const bodies: { query: string; params: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toContain("/youtubei/v1/search");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answer, { status });
  });
  return bodies;
}

describe("youtube_search", () => {
  const search = (args: Record<string, unknown>) => runTool("youtube_search", args, ctx);

  it("lists matching videos with their links, skipping what is not a video", async () => {
    const bodies = stubSearch(
      searchAnswer([
        video("aircAruvnKk", "But what is a neural network?"),
        video("LPZh9BOjkQs", "LLMs explained"),
      ])
    );
    const result = await search({ query: "neural network 3blue1brown" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe(
      "1. But what is a neural network?\n3Blue1Brown · 18:40 · 25,436,647 views · 9 years ago\nhttps://www.youtube.com/watch?v=aircAruvnKk\n\n" +
        "2. LLMs explained\n3Blue1Brown · 18:40 · 25,436,647 views · 9 years ago\nhttps://www.youtube.com/watch?v=LPZh9BOjkQs"
    );
    expect(bodies[0].query).toBe("neural network 3blue1brown");
    // Videos only: the filter keeps channels and playlists out.
    expect(bodies[0].params).toBe("EgIQAQ==");
  });

  it("returns at most `count` results, five by default", async () => {
    const many = Array.from({ length: 8 }, (_, i) => video(`video000000${i}`, `Video ${i}`));
    stubSearch(searchAnswer(many));
    expect((await search({ query: "x" })).content.match(/^\d+\. /gm)).toHaveLength(5);
    expect((await search({ query: "x", count: 2 })).content.match(/^\d+\. /gm)).toHaveLength(2);
  });

  it("leaves out facts a result does not have, such as a live stream's length", async () => {
    stubSearch(searchAnswer([video("liveStream01", "Live now", { lengthText: undefined })]));
    expect((await search({ query: "live" })).content).toContain("3Blue1Brown · 25,436,647 views");
  });

  it("says so when nothing matches", async () => {
    stubSearch(searchAnswer([]));
    expect((await search({ query: "zzzz" })).content).toBe('No YouTube videos found for "zzzz".');
  });

  it("reports a refused search and an empty query", async () => {
    stubSearch({}, 429);
    expect((await search({ query: "x" })).content).toContain("YouTube search returned 429");
    expect((await search({ query: "  " })).content).toContain("query was empty");
  });
});
