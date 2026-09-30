import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { bridge, describeError } from "@/lib/bridge";
import { mySession, startSession } from "@/lib/challenges";
import { MAX_MESSAGE, type ChatUIMessage } from "@/lib/chat";
import { sameOrigin } from "@/lib/origin";
import { AGENT_URL, WorkerError, workerHeaders } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const plain = (text: string, status: number) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const sessionUrl = (sessionId: string, path: string) =>
  `${AGENT_URL}/agents/session-agent/${encodeURIComponent(sessionId)}/${path}`;

/**
 * Send the caller's message. Their first one opens their session with this challenge;
 * the Worker decides whether they may — the creator, or a guest it lets in.
 */
export async function POST(request: Request, { params }: Ctx) {
  if (!sameOrigin(request.headers)) return plain("Not allowed.", 403);
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { message?: unknown; retry?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return plain("Type a message first.", 400);
  if (message.length > MAX_MESSAGE) return plain(`Keep it under ${MAX_MESSAGE} characters.`, 400);

  let sessionId: string;
  try {
    sessionId = (await mySession(id))?.id ?? (await startSession(id)).id;
  } catch (err) {
    if (err instanceof WorkerError && (err.status === 401 || err.status === 404)) {
      return plain("You are not on this challenge's list.", 404);
    }
    if (err instanceof WorkerError && err.status === 409) {
      return plain("This challenge has reached its conversation limit.", 409);
    }
    return plain(describeError(err), 502);
  }

  const headers = await workerHeaders();
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      const upstream = await fetch(sessionUrl(sessionId, "stream"), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ message, retry: body.retry === true }),
        signal: request.signal,
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        let detail = text;
        try {
          detail = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {}
        throw new Error(detail || `The agent returned ${upstream.status}.`);
      }
      await bridge(upstream.body, writer);
    },
    onError: describeError,
  });
  return createUIMessageStreamResponse({ stream });
}

/** Reconnect to a reply still being written, after a reload. */
export async function GET(request: Request, { params }: Ctx) {
  const { id } = await params;
  const session = await mySession(id).catch(() => null);
  if (!session) return new Response(null, { status: 204 });
  const has = new URL(request.url).searchParams.get("has") ?? "";
  const upstream = await fetch(`${sessionUrl(session.id, "live")}?has=${encodeURIComponent(has)}`, {
    headers: await workerHeaders(),
    signal: request.signal,
  }).catch(() => null);
  if (!upstream || upstream.status === 204 || !upstream.ok || !upstream.body) {
    return new Response(null, { status: 204 });
  }
  const body = upstream.body;
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => bridge(body, writer),
    onError: describeError,
  });
  return createUIMessageStreamResponse({ stream });
}
