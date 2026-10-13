import "server-only";
import { cookies } from "next/headers";
import { fail } from "./http";
import { parseUserId } from "./rules";
import { readSession, SESSION_COOKIE, type Session } from "./session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a browser request came from this site. Cookie-borne writes must; bearer calls need not. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The caller's session: an `Authorization: Bearer` JWT, else the session cookie. */
async function callerSession(request: Request): Promise<{ session: Session | null; viaCookie: boolean }> {
  const auth = request.headers.get("authorization");
  if (auth) {
    const token = /^Bearer (.+)$/i.exec(auth)?.[1];
    return { session: await readSession(token), viaCookie: false };
  }
  return { session: await readSession((await cookies()).get(SESSION_COOKIE)?.value), viaCookie: true };
}

/**
 * The signed-in user, when they are the user the route is for; otherwise the response to
 * send instead (401 without a valid session, 403 for anyone else's data or a cross-site write).
 */
export async function authorize(request: Request, rawUserId: string): Promise<string | Response> {
  const { session, viaCookie } = await callerSession(request);
  if (!session) return fail("Pick up your badge first.", 401);
  if (viaCookie && !SAFE_METHODS.has(request.method) && !sameOrigin(request)) return fail("Not allowed.", 403);
  if (parseUserId(rawUserId) !== session.userId) return fail("Not allowed.", 403);
  return session.userId;
}
