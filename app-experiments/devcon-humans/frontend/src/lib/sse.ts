/** One frame of the agent's reply stream. */
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "tool_done"; name: string; ok: boolean }
  | { type: "error"; error: string }
  | { type: "usage" | "done" };

/**
 * Split buffered SSE text into events. Returns the events complete so far and the
 * unfinished tail to prepend to the next chunk.
 */
export function readFrames(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let rest = buffer;
  let cut: number;
  while ((cut = rest.indexOf("\n\n")) !== -1) {
    const frame = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    if (!frame.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(frame.slice(6)) as AgentEvent);
    } catch {
      // A frame that is not JSON carries nothing to show.
    }
  }
  return { events, rest };
}
