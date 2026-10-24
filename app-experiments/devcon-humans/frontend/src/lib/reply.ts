import { readFrames } from "./sse";

/**
 * POST a message and read the agent's streamed reply: `onText` for each piece of text,
 * `onTool` with a tool's name while it runs and "" once it is done, `onToolDone` as each one
 * finishes, so the page can act before the reply has ended. Resolves to the names of
 * the tools that finished without error. Throws with a message for the page to show when
 * the message was refused or the reply broke off.
 */
export async function sendMessage(
  url: string,
  message: string,
  {
    onText,
    onTool,
    onToolDone,
  }: {
    onText: (delta: string) => void;
    onTool: (name: string) => void;
    onToolDone?: (name: string, ok: boolean) => void;
  },
): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Your message wasn’t sent. Try again.");
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const done: string[] = [];
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return done;
      const value = read.value;
      const { events, rest } = readFrames(buffer + value);
      buffer = rest;
      for (const event of events) {
        if (event.type === "delta") {
          onTool("");
          onText(event.text);
        } else if (event.type === "tool") onTool(event.name);
        else if (event.type === "tool_done") {
          onTool("");
          if (event.ok) done.push(event.name);
          onToolDone?.(event.name, event.ok);
        }
        else if (event.type === "error") throw new Error(event.error);
      }
    }
  } catch (err) {
    throw new Error(err instanceof Error && err.message ? err.message : "The reply was cut off. Send it again.");
  } finally {
    onTool("");
  }
}

// Tool calls some models write out as text when told to stop calling tools (on a turn's last
// round): `<tool_call>…`, and DeepSeek's `<｜DSML｜tool_calls>…` and `<｜tool▁calls▁begin｜>…`.
// Each runs to its closing tag, or to the end while it is still streaming.
const LEAKED_TOOL_CALLS = [
  /<tool_call>[\s\S]*?(<\/tool_call>|$)/g,
  /<\s*[｜|]\s*DSML\s*[｜|]\s*tool_calls\s*>[\s\S]*?(<\/\s*[｜|]\s*DSML\s*[｜|]\s*tool_calls\s*>|$)/g,
  /<｜tool▁calls▁begin｜>[\s\S]*?(<｜tool▁calls▁end｜>|$)/g,
];

/** A reply as the page shows it: without tool calls a model wrote out as text. */
export function visibleReply(text: string): string {
  return LEAKED_TOOL_CALLS.reduce((t, pattern) => t.replace(pattern, ""), text).trim();
}
