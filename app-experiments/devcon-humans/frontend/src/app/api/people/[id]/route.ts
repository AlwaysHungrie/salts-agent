import { cookies } from "next/headers";
import { fail, failure } from "@/lib/http";
import { person } from "@/lib/humans";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One person's saved profile, for a search result. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return fail("Pick up your badge first.", 401);
  const { id } = await params;
  if (!/^[0-9a-f]{32}$/.test(id)) return fail("No one with that profile.", 404);
  try {
    return Response.json(await person(session.userId, id), { headers: { "cache-control": "private, max-age=60" } });
  } catch (err) {
    return failure(err);
  }
}
