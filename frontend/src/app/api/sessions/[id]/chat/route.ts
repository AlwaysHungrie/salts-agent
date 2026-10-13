import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import {
  agentUrl,
  describeSessionFailure,
  SESSION_CRASHED,
  SESSION_OUT_OF_MEMORY,
  type Attachment,
  type UsageData,
} from "@/lib/agent";
import { agentHeaders } from "@/lib/upstream";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A tool the agent ran mid-turn, streamed so the UI can say what is happening. */
export type ToolData = { name: string; done: boolean; ok?: boolean };

/** The attachments sent with a user message, so the bubble can show them. */
export type FilesData = { attachments: Attachment[] };

/** When a message was written, for restored transcripts. Live ones are timed locally. */
export type MetaData = { ts: number };

export type ChatUIMessage = UIMessage<
  never,
  { usage: UsageData; tool: ToolData; files: FilesData; meta: MetaData }
>;

/**
 * Bridges the Durable Object's SSE stream into the AI SDK UI message protocol, so
 * `useChat` gets streamed text plus a `data-usage` part carrying what the turn cost.
 *
 * The incoming request's abort signal is forwarded to the Worker. When the user hits
 * stop, the Worker's stream is cancelled, the Durable Object banks the partial reply
 * and the tokens already billed, and stops accruing duration.
 */
/**
 * Stream failures reach the client as text, so they have to read as sentences. The
 * runtime's own wording does not: a cancelled or dropped connection surfaces from
 * undici as the bare word "terminated".
 */
function describeStreamError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/^terminated$/i.test(raw) || /aborted|ECONNRESET/i.test(raw)) {
    return "The reply was cut off before it finished. Send the message again to retry.";
  }
  const status = raw.match(/^agent (\d{3}): ([\s\S]*)$/);
  if (status) {
    const detail = describeAgentBody(status[1], status[2]);
    return detail || `The agent returned ${status[1]}.`;
  }
  // A failure the object reported mid-stream arrives as its own message rather than
  // as a status and a body, so it has to be recognised here too — otherwise the
  // runtime's own wording, SQL statements and all, is what the chat shows.
  const platform = describeSessionFailure(raw);
  if (platform) return platform;
  return raw ? clamp(raw) : "Something went wrong on the way to the agent.";
}

/**
 * What the agent said when it failed, as a sentence.
 *
 * Its own failures are JSON and can be read out directly. What cannot is a failure
 * that never reached it: Cloudflare answers a dead isolate with a full HTML error
 * page, and putting that in a chat bubble renders markup into the transcript and
 * tells the reader nothing. The code on that page is the only part worth keeping.
 */
function describeAgentBody(status: string, body: string): string {
  const trimmed = body.trim();

  if (/^<(!doctype|html)/i.test(trimmed)) {
    const code =
      trimmed.match(/class="cf-error-code"[^>]*>(\d+)/i)?.[1] ??
      trimmed.match(/\b(1\d{3})\b/)?.[1];
    if (code === "1102" || /exceeded its memory limit|resource limits/i.test(trimmed)) {
      return SESSION_OUT_OF_MEMORY;
    }
    if (code === "1101") {
      return SESSION_CRASHED;
    }
    return `The agent could not be reached${code ? ` (Cloudflare ${code})` : ""}. Ask again in a moment.`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: string };
    const detail = typeof parsed.error === "string" ? parsed.error.trim() : "";
    if (detail) return describeSessionFailure(detail) ?? clamp(detail);
  } catch {
    // Not JSON — fall through and treat it as text.
  }

  // Anything else: never markup, never a wall. One readable line.
  const text = trimmed.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return `The agent returned ${status}.`;
  return describeSessionFailure(text) ?? clamp(text);
}

function clamp(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Translate the Durable Object's SSE frames into UI message parts.
 *
 * Both the live turn and a reconnection to one already running read the same frames,
 * so the reconnecting browser redraws the reply — text, tool lines and all — exactly
 * as the tab that started it saw it.
 */
async function bridge(
  upstream: NonNullable<Response["body"]>,
  writer: UIMessageStreamWriter<ChatUIMessage>,
): Promise<void> {
  // Text is emitted as one part per round, opened on the round's first token and
  // closed when the round ends in tool calls. Parts then reach the UI in the order
  // they happened — say something, run a tool, say something more — instead of all
  // the prose collapsing into one block above all the tool lines.
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
  let closed = false;

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
          | ({ type: "usage" } & UsageData)
          | { type: "files"; attachments: Attachment[] }
          | { type: "tool"; name: string }
          | { type: "tool_done"; name: string; ok: boolean }
          | { type: "error"; error: string }
          | { type: "done" };

        if (event.type === "delta") {
          writer.write({
            type: "text-delta",
            id: openText(),
            delta: event.text,
          });
        } else if (event.type === "files") {
          // What tools made for the user, hung on the reply when the turn ended.
          writer.write({ type: "data-files", data: { attachments: event.attachments } });
        } else if (event.type === "usage") {
          writer.write({
            type: "data-usage",
            data: {
              prompt_tokens: event.prompt_tokens,
              completion_tokens: event.completion_tokens,
              cost_usd: event.cost_usd,
              llm_ms: event.llm_ms,
            },
          });
        } else if (event.type === "tool" || event.type === "tool_done") {
          // One part per tool call per round, re-sent as done: the UI keys on the
          // id and replaces the running line with a finished one.
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
          // The round is over once its last tool reports back; anything after this
          // belongs to the next one.
          if (event.type === "tool_done") {
            running.delete(event.name);
            if (running.size === 0) round++;
          }
        } else if (event.type === "error") {
          throw new Error(event.error);
        } else if (event.type === "done") {
          closeText();
          closed = true;
        }
      }
    }
  } finally {
    if (!closed) closeText();
  }
}

/**
 * Reconnect to a reply that is already being written.
 *
 * A reload drops the tab's stream but not the turn: the agent goes on answering and
 * banks what it says. `useChat`'s resume asks here on mount, and the object answers
 * either with the reply so far — replayed from its first token, then followed live —
 * or with 204, meaning the transcript that was just loaded is already the whole story.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // The last reply the browser already has, so a turn that ended between its
  // transcript being read and this call is sent rather than silently missed.
  const has = new URL(request.url).searchParams.get("has") ?? "";
  const upstream = await fetch(
    `${agentUrl(id, "live")}?has=${encodeURIComponent(has)}`,
    { signal: request.signal, headers: await agentHeaders() },
  );

  if (upstream.status === 204 || !upstream.body) {
    return new Response(null, { status: 204 });
  }
  if (!upstream.ok) {
    return new Response(null, { status: 204 });
  }

  const body = upstream.body;
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      await bridge(body, writer);
    },
    onError: (error) => describeStreamError(error),
  });

  return createUIMessageStreamResponse({ stream });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { messages, trigger } = (await request.json()) as {
    messages: ChatUIMessage[];
    trigger?: "submit-message" | "regenerate-message";
  };
  // A retry re-asks the question already on record, so the agent rewinds to it
  // instead of banking a second copy — and the turn keeps its attachments.
  const retry = trigger === "regenerate-message";

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text =
    lastUser?.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("") ?? "";

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      const upstream = await fetch(agentUrl(id, "stream"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await agentHeaders()) },
        body: JSON.stringify({ message: text, retry }),
        signal: request.signal,
      });

      if (!upstream.ok || !upstream.body) {
        throw new Error(`agent ${upstream.status}: ${await upstream.text()}`);
      }

      await bridge(upstream.body, writer);
    },
    onError: (error) => describeStreamError(error),
  });

  return createUIMessageStreamResponse({ stream });
}
