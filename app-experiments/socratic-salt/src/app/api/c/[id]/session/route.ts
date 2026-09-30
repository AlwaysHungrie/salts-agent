import { deleteSession, mySession } from "@/lib/challenges";
import { sameOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** Start over: delete the caller's own conversation with this challenge. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request.headers)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await params;
  const session = await mySession(id).catch(() => null);
  if (session) await deleteSession(session.id).catch(() => {});
  return Response.json({ ok: true });
}
