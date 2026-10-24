import { cookies } from "next/headers";
import { ADMIN_HEADER, adminEmail, emailUserId, isAdminKey } from "@/lib/admin";
import { sameOrigin } from "@/lib/auth";
import { users } from "@/lib/db";
import { fail, failure } from "@/lib/http";
import { SESSION_COOKIE, SESSION_TTL, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Admin mode: sign in as the user with `{ email }`, no ticket needed, with the
 * HUMANS_ADMIN_KEY in the `x-humans-admin-key` header. The session is that user's own, so the
 * chat reaches their agent. An email no badge was picked up for becomes a new user (named
 * after the part before the `@`), whose agent is found or added in the fleet by that email.
 * Answers 404 while admin mode is off or the key is wrong, so the route gives nothing away.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("Not allowed.", 403);
  if (!isAdminKey(request.headers.get(ADMIN_HEADER))) return fail("Not found.", 404);
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
    const token = await signSession({ userId, name });
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL,
      path: "/",
    });
    return Response.json({ userId, name });
  } catch (err) {
    return failure(err);
  }
}
