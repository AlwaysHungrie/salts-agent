import { authorize } from "@/lib/auth";
import { oneShot } from "@/lib/chat";
import { fail, failure } from "@/lib/http";
import { profileMessage } from "@/lib/prompts";
import { messageProblem } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One message about the user's profile, in a session of its own; the reply streams back as server-sent events. */
export async function POST(request: Request) {
  const session = await authorize(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const problem = messageProblem(message);
  if (problem) return fail(problem, 400);
  try {
    const reply = await oneShot(session.userId, profileMessage(message), request.signal);
    return new Response(reply, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  } catch (err) {
    return failure(err);
  }
}
