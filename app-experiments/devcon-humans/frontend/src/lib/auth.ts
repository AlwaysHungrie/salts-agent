import "server-only";
import { cookies } from "next/headers";
import { fail } from "./http";
import { readSession, SESSION_COOKIE, type Session } from "./session";

/** Whether a browser request came from this site. Every write must. */
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

/**
 * The signed-in user of a write from this site, or the response to send instead (401
 * without a valid session cookie, 403 for a cross-site request).
 */
export async function authorize(request: Request): Promise<Session | Response> {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return fail("Pick up your badge first.", 401);
  if (!sameOrigin(request)) return fail("Not allowed.", 403);
  return session;
}
