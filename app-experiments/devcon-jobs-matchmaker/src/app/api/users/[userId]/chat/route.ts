import { stream } from "@/lib/agent";
import { chatState, clearChat, refundMessage, reserveMessage } from "@/lib/chat";
import { authorize } from "@/lib/auth";
import { fail, failure } from "@/lib/http";
import { screenMessage } from "@/lib/llm";
import { SCREENED } from "@/lib/screen";
import { MAX_MESSAGES, messageProblem } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ userId: string }> };

/** The user's chat: transcript and messages used. */
export async function GET(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  try {
    return Response.json(await chatState(userId));
  } catch (err) {
    return failure(err);
  }
}

/** Send a message; the reply streams back as the agent's server-sent events. */
export async function POST(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  const body = (await request.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const problem = messageProblem(message);
  if (problem) return fail(problem, 400);

  let sessionId: string | null;
  try {
    sessionId = await reserveMessage(userId);
  } catch (err) {
    return failure(err);
  }
  if (!sessionId) return fail(`This chat has reached its ${MAX_MESSAGES}-message limit. Clear it to start again.`, 409);

  // Screened once counted: an off-topic message or a request to remove candidates uses
  // up a message but never reaches the agent. Only a screening failure gives it back.
  try {
    const verdict = await screenMessage(message);
    if (verdict !== "ok") return Response.json({ error: SCREENED[verdict], counted: true }, { status: 400 });
  } catch (err) {
    await refundMessage(userId, sessionId).catch(() => {});
    return failure(err);
  }

  try {
    const reply = await stream(sessionId, message, request.signal);
    return new Response(reply, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  } catch (err) {
    await refundMessage(userId, sessionId).catch(() => {});
    return failure(err);
  }
}

/** Clear the chat and its agent session, at most once every 12 hours. */
export async function DELETE(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  try {
    const clearableAt = await clearChat(userId);
    if (clearableAt)
      return Response.json(
        { error: "You can clear your chat once every 12 hours.", clearableAt: clearableAt.toISOString() },
        { status: 429 },
      );
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
