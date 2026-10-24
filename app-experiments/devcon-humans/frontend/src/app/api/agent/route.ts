import { authorize } from "@/lib/auth";
import { ensureAgent } from "@/lib/chat";
import { failure } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Set up the signed-in user's agent, right after sign-in. 409 while another request is setting it up. */
export async function PUT(request: Request) {
  const session = await authorize(request);
  if (session instanceof Response) return session;
  try {
    await ensureAgent(session.userId);
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
