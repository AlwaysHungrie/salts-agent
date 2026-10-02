import { stream } from "@/lib/agent";
import { chatState, clearChat, refundMessage, reserveMessage } from "@/lib/chat";
import { fail, failure } from "@/lib/http";
import { MAX_MESSAGES, messageProblem, parseUserId } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ userId: string }> };

/** The user's chat: transcript and messages used. */
export async function GET(_request: Request, { params }: Ctx) {
  const userId = parseUserId((await params).userId);
  if (!userId) return fail("Not a valid user id.", 400);
  try {
    return Response.json(await chatState(userId));
  } catch (err) {
    return failure(err);
  }
}

/** Send a message; the reply streams back as the agent's server-sent events. */
export async function POST(request: Request, { params }: Ctx) {
  const userId = parseUserId((await params).userId);
  if (!userId) return fail("Not a valid user id.", 400);
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

/** Clear the chat and its agent session. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const userId = parseUserId((await params).userId);
  if (!userId) return fail("Not a valid user id.", 400);
  try {
    await clearChat(userId);
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
