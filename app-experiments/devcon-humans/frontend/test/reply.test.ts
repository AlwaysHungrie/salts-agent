import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "@/lib/reply";

const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));

afterEach(() => vi.unstubAllGlobals());

describe("sendMessage", () => {
  it("streams the text and reports only the tools that finished without error", async () => {
    vi.stubGlobal("fetch", async () =>
      sse(
        { type: "tool", name: "mcp_find_humans_my_info" },
        { type: "tool_done", name: "mcp_find_humans_my_info", ok: false },
        { type: "tool", name: "mcp_find_humans_add_info" },
        { type: "tool_done", name: "mcp_find_humans_add_info", ok: true },
        { type: "delta", text: "Added " },
        { type: "delta", text: "it." },
        { type: "done" },
      ),
    );
    let text = "";
    const tools: string[] = [];
    const done = await sendMessage("/api/profile/message", "hi", { onText: (d) => (text += d), onTool: (t) => tools.push(t) });
    expect(text).toBe("Added it.");
    expect(done).toEqual(["mcp_find_humans_add_info"]);
    expect(tools.at(-1)).toBe("");
  });

  it("reports no tools when the agent only replied", async () => {
    vi.stubGlobal("fetch", async () => sse({ type: "delta", text: "Added it to your profile." }, { type: "done" }));
    expect(await sendMessage("/x", "hi", { onText: () => {}, onTool: () => {} })).toEqual([]);
  });
});

describe("visibleReply", () => {
  it("cuts tool calls a model wrote out as text, finished or still streaming", async () => {
    const { visibleReply } = await import("@/lib/reply");
    const dsml =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="mcp_find_humans_search_people"><｜DSML｜parameter name="query" string="true">bug butts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    expect(visibleReply(`Here they are.${dsml}`)).toBe("Here they are.");
    expect(visibleReply(dsml)).toBe("");
    expect(visibleReply('Looking.<｜DSML｜tool_calls><｜DSML｜invoke name="x">')).toBe("Looking.");
    expect(visibleReply("Done.<tool_call>search<arg_key>q</arg_key></tool_call>")).toBe("Done.");
    expect(visibleReply("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function")).toBe("");
    expect(visibleReply("Asha builds wallets.")).toBe("Asha builds wallets.");
  });
});
