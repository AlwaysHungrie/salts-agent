type LiveEvent = Record<string, unknown>;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

const encoder = new TextEncoder();
const frame = (event: LiveEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

/** A fixed list of events as one SSE response. */
function sseOf(events: LiveEvent[], headers: Record<string, string> = SSE_HEADERS): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(frame(event));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

/** One line of text, in the SSE shape the chat client reads, with a zero-cost usage event. */
export function streamSentence(text: string): Response {
  return sseOf([
    { type: "delta", text },
    { type: "usage", prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, llm_ms: 0 },
  ]);
}

/**
 * The turn that is streaming now, and the one that just finished.
 *
 * Every event a streaming turn sends is kept, so a browser that reloads mid-reply is
 * handed the reply from the start and then follows it live. Memory is the right
 * lifetime: an evicted object takes its turn with it.
 *
 * The finished turn covers the race at the end of a reply: the transcript is read just
 * before the reply is banked and the reconnection arrives just after, so neither would
 * carry it.
 */
export class LiveTurns {
  private current: {
    events: LiveEvent[];
    listeners: Set<(event: LiveEvent) => void>;
    closers: Set<() => void>;
  } | null = null;
  private finished: { events: LiveEvent[]; messageId: string } | null = null;

  /** The message id of the reply Think wrote last, learned in `onChatResponse`. */
  lastReplyId = "";

  /** A turn begins streaming. */
  start() {
    this.finished = null;
    this.current = { events: [], listeners: new Set(), closers: new Set() };
  }

  /** Record an event against the running turn and hand it to everyone attached. */
  emit(event: LiveEvent) {
    const live = this.current;
    if (!live) return;
    live.events.push(event);
    for (const listener of live.listeners) {
      try {
        listener(event);
      } catch {
        // A connection that has gone away is dropped when its stream is cancelled.
      }
    }
  }

  /** The turn is over: release everyone still attached, and keep it for a late reader. */
  end() {
    const live = this.current;
    this.current = null;
    if (!live) return;
    if (this.lastReplyId) this.finished = { events: live.events, messageId: this.lastReplyId };
    for (const close of live.closers) {
      try {
        close();
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Attach to the running turn: the events it has sent, then the rest live. With
   * nothing running, a turn that ended after the browser's last reply (`has`) is
   * replayed; otherwise 204 says the transcript is complete.
   */
  attach(has = ""): Response {
    const live = this.current;
    if (!live) {
      const missed = this.finished;
      if (!missed || missed.messageId === has) return new Response(null, { status: 204 });
      return sseOf(missed.events, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
    }

    let listener: ((event: LiveEvent) => void) | null = null;
    let closer: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (event: LiveEvent) => {
          if (!open) return;
          try {
            controller.enqueue(frame(event));
          } catch {
            open = false;
          }
        };
        for (const event of live.events) write(event);
        listener = write;
        closer = () => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        live.listeners.add(listener);
        live.closers.add(closer);
      },
      cancel() {
        if (listener) live.listeners.delete(listener);
        if (closer) live.closers.delete(closer);
      },
    });
    return new Response(body, { headers: SSE_HEADERS });
  }
}
