import { cookies } from "next/headers";
import { sameOrigin } from "@/lib/auth";
import { users } from "@/lib/db";
import { fail, failure } from "@/lib/http";
import { MAX_PKPASS_BYTES, PassError, passUserId, verifyPkpass } from "@/lib/pkpass";
import { tooLarge } from "@/lib/rules";
import { SESSION_COOKIE, SESSION_TTL, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Pick up a badge with a Devcon .pkpass: verify it, create the user if new (named after
 * the part of the ticket's email before the `@`), and answer with a session JWT (also set
 * as an http-only cookie). The pass and the full email are read in memory only, never kept.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("Not allowed.", 403);
  if (tooLarge(request, MAX_PKPASS_BYTES)) return fail("That file is too large to be a pass.", 413);

  const form = await request.formData().catch(() => null);
  const file = form?.get("pass");
  if (!(file instanceof File) || file.size === 0) return fail("Choose your .pkpass file.", 400);
  if (file.size > MAX_PKPASS_BYTES) return fail("That file is too large to be a pass.", 413);

  try {
    const pass = await verifyPkpass(new Uint8Array(await file.arrayBuffer()));
    const { name } = pass;
    const userId = passUserId(pass);
    const now = new Date();
    await (await users()).updateOne(
      { userId },
      { $set: { name, lastSeenAt: now }, $setOnInsert: { userId, createdAt: now } },
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
    return Response.json({ token, userId, name });
  } catch (err) {
    if (err instanceof PassError) return fail(err.message, 400);
    return failure(err);
  }
}
