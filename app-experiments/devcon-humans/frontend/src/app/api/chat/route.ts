import { stream } from "@/lib/agent";
import { authorize } from "@/lib/auth";
import { currentChat, newChat } from "@/lib/chat";
import { fail, failure } from "@/lib/http";
import { messageProblem } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Start the chat over: a new agent session, the previous one deleted. The first call also sets up the user's agent. */
export async function PUT(request: Request) {
  const session = await authorize(request);
  if (session instanceof Response) return session;
  try {
    await newChat(session.userId);
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}

/** Send a message; the reply streams back as the agent's server-sent events. */
export async function POST(request: Request) {
  const session = await authorize(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const problem = messageProblem(message);
  if (problem) return fail(problem, 400);
  try {
    const { key, sessionId } = await currentChat(session.userId);
    const reply = await stream(key, sessionId, message, request.signal);
    return new Response(reply, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  } catch (err) {
    return failure(err);
  }
}
