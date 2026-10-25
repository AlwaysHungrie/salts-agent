import { cookies } from "next/headers";
import { ADMIN_HEADER, adminEmail, emailUserId, isAdminKey, isAdminSession } from "@/lib/admin";
import { sameOrigin } from "@/lib/auth";
import { users } from "@/lib/db";
import { fail, failure } from "@/lib/http";
import { readSession, SESSION_COOKIE, SESSION_TTL, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Admin mode: sign in as the user with `{ email }`, no ticket needed, with the
 * HUMANS_ADMIN_KEY in the `x-humans-admin-key` header, or from a session already in admin mode
 * (signed in with an admin's ticket, see `isAdminEmail`). The new session stays in admin mode, so
 * the browser can switch again. The session is that user's own, so the
 * chat reaches their agent. An email no badge was picked up for becomes a new user (named
 * after the part before the `@`), whose agent is found or added in the fleet by that email.
 * Answers 404 to anyone else, so the route gives nothing away.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("Not allowed.", 403);
  const allowed =
    isAdminKey(request.headers.get(ADMIN_HEADER)) ||
    (await isAdminSession(await readSession((await cookies()).get(SESSION_COOKIE)?.value)).catch((err) => {
      console.error(err);
      return false;
    }));
  if (!allowed) return fail("Not found.", 404);
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = adminEmail(body.email);
  if (!email) return fail("Enter an email address.", 400);

  try {
    const col = await users();
    const now = new Date();
    const known = await col.findOne({ email }, { sort: { lastSeenAt: -1 } });
    const userId = known?.userId ?? emailUserId(email);
    const name = known?.name ?? email.split("@")[0];
    await col.updateOne(
      { userId },
      { $set: { lastSeenAt: now }, $setOnInsert: { userId, name, email, createdAt: now } },
      { upsert: true },
    );
    const token = await signSession({ userId, name, admin: true });
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL,
      path: "/",
    });
    return Response.json({ userId, name, email });
  } catch (err) {
    return failure(err);
  }
}
