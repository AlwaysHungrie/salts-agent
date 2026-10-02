import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateIdFrom, deletedFrom, LlmError, screenMessage } from "@/lib/llm";
import { deleteCandidateMessage } from "@/lib/rules";
import { parseCandidateId, parseDeleted, parseScreen } from "@/lib/screen";

const ID = "3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b3e9f00";

describe("parseCandidateId", () => {
  it("takes a UUID the reply contains", () => {
    expect(parseCandidateId({ candidateId: ID.toUpperCase() }, `Added candidate ${ID}.`)).toBe(ID);
  });

  it("refuses an id the reply does not contain, a non-UUID, or no answer", () => {
    expect(parseCandidateId({ candidateId: ID }, "Added candidate.")).toBeNull();
    expect(parseCandidateId({ candidateId: "abc" }, "abc")).toBeNull();
    expect(parseCandidateId({ candidateId: null }, ID)).toBeNull();
    expect(parseCandidateId([ID], ID)).toBeNull();
    expect(parseCandidateId(null, ID)).toBeNull();
  });
});

describe("parseDeleted / parseScreen", () => {
  it("deleted or not found is gone; anything else is not", () => {
    expect(parseDeleted({ outcome: "deleted" })).toBe(true);
    expect(parseDeleted({ outcome: "not_found" })).toBe(true);
    expect(parseDeleted({ outcome: "confirm" })).toBe(false);
    expect(parseDeleted({ deleted: true })).toBe(false);
    expect(parseDeleted({})).toBe(false);
  });

  it("anything unknown screens as off topic", () => {
    expect(parseScreen({ verdict: "ok" })).toBe("ok");
    expect(parseScreen({ verdict: "removal" })).toBe("removal");
    expect(parseScreen({ verdict: "OK" })).toBe("off_topic");
    expect(parseScreen("ok")).toBe("off_topic");
  });
});

describe("deleteCandidateMessage", () => {
  it("names the candidate and pre-confirms the delete", () => {
    expect(deleteCandidateMessage(ID)).toMatch(new RegExp(`delete candidate ${ID} with delete_candidate`));
    expect(deleteCandidateMessage(ID)).toMatch(/do not ask again/);
  });
});

describe("llm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const answer = (content: string, status = 200) => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content } }] }, { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("sends the message as data to the cheap model and reads the verdict", async () => {
    const fetch = answer('{"verdict":"removal"}');
    expect(await screenMessage("delete candidate 42")).toBe("removal");
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("mistralai/mistral-nemo");
    expect(body.messages[1].content).toBe(JSON.stringify({ message: "delete candidate 42" }));
  });

  it("does not ask the model when the reply holds no id", async () => {
    const fetch = answer('{"candidateId":null}');
    expect(await candidateIdFrom("Something went wrong.")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    answer(`{"candidateId":"${ID}"}`);
    expect(await candidateIdFrom(`Added. Candidate id: ${ID}`)).toBe(ID);
  });

  it("fails rather than passing when the model errors or answers nonsense", async () => {
    answer("", 500);
    await expect(screenMessage("hi")).rejects.toBeInstanceOf(LlmError);
    answer("not json");
    await expect(deletedFrom("Deleted.", ID)).rejects.toBeInstanceOf(LlmError);
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(screenMessage("hi")).rejects.toBeInstanceOf(LlmError);
  });
});
