import "server-only";
import type { UIMessageStreamWriter } from "ai";
import type { ChatUIMessage } from "./chat";

/**
 * Translate the Worker's SSE frames into AI SDK UI message parts. Text is one part per
 * round, so a reply that searches midway reads: text, tool line, more text.
 */
export async function bridge(
  upstream: ReadableStream,
  writer: UIMessageStreamWriter<ChatUIMessage>,
): Promise<void> {
  let textId: string | null = null;
  let round = 0;
  const running = new Set<string>();
  const openText = () => {
    if (textId) return textId;
    textId = `${crypto.randomUUID()}-${round}`;
    writer.write({ type: "text-start", id: textId });
    return textId;
  };
  const closeText = () => {
    if (!textId) return;
    writer.write({ type: "text-end", id: textId });
    textId = null;
  };

  const reader = upstream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6)) as
          | { type: "delta"; text: string }
          | { type: "tool"; name: string }
          | { type: "tool_done"; name: string; ok: boolean }
          | { type: "error"; error: string }
          | { type: "usage" | "done" };

        if (event.type === "delta") {
          writer.write({ type: "text-delta", id: openText(), delta: event.text });
        } else if (event.type === "tool" || event.type === "tool_done") {
          if (event.type === "tool") {
            closeText();
            running.add(event.name);
          }
          writer.write({
            type: "data-tool",
            id: `tool-${round}-${event.name}`,
            data: {
              name: event.name,
              done: event.type === "tool_done",
              ...(event.type === "tool_done" ? { ok: event.ok } : {}),
            },
          });
          if (event.type === "tool_done") {
            running.delete(event.name);
            if (running.size === 0) round++;
          }
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
  } finally {
    closeText();
  }
}

/** A failure as one readable sentence, never markup or a stack. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/^terminated$/i.test(raw) || /aborted|ECONNRESET/i.test(raw)) {
    return "The reply was cut off. Send your message again.";
  }
  const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "Something went wrong reaching the agent.";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
