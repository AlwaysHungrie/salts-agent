import { readFrames } from "./sse";

/**
 * POST a message and read the agent's streamed reply: `onText` for each piece of text,
 * `onTool` with a tool's name while it runs and "" once it is done. Throws with a message
 * for the page to show when the message was refused or the reply broke off.
 */
export async function sendMessage(
  url: string,
  message: string,
  { onText, onTool }: { onText: (delta: string) => void; onTool: (name: string) => void },
): Promise<void> {
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const { events, rest } = readFrames(buffer + value);
      buffer = rest;
      for (const event of events) {
        if (event.type === "delta") {
          onTool("");
          onText(event.text);
        } else if (event.type === "tool") onTool(event.name);
        else if (event.type === "tool_done") onTool("");
        else if (event.type === "error") throw new Error(event.error);
      }
    }
  } catch (err) {
    throw new Error(err instanceof Error && err.message ? err.message : "The reply was cut off. Send it again.");
  } finally {
    onTool("");
  }
}
