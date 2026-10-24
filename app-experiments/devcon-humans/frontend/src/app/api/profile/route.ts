import { cookies } from "next/headers";
import { authorize } from "@/lib/auth";
import { fail, failure } from "@/lib/http";
import { myProfile, saveMyProfile } from "@/lib/humans";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The user's entries and saved profile. A read, so the session cookie is enough. */
export async function GET() {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return fail("Pick up your badge first.", 401);
  try {
    return Response.json(await myProfile(session.userId));
  } catch (err) {
    return failure(err);
  }
}

/** Save: the profile is written from the user's entries and published to search. */
export async function POST(request: Request) {
  const session = await authorize(request);
  if (session instanceof Response) return session;
  try {
    return Response.json(await saveMyProfile(session.userId));
  } catch (err) {
    return failure(err);
  }
}
