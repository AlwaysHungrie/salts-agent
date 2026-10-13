import "server-only";
import { jwtVerify, SignJWT } from "jose";

/** Cookie holding the session JWT. */
export const SESSION_COOKIE = "devcon_session";

const ISSUER = "devcon-jobs-matchmaker";

/** How long a session lasts, in seconds. */
export const SESSION_TTL = 30 * 24 * 60 * 60;

/** Who a session JWT says the user is. */
export type Session = { userId: string; name: string };

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 characters.");
  return new TextEncoder().encode(s);
}

/** A signed JWT: `sub` is the user id, `name` the name on their ticket. */
export async function signSession({ userId, name }: Session): Promise<string> {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL}s`)
    .sign(secret());
}

/** The session a JWT carries, or null when it is missing, forged or expired. */
export async function readSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"], issuer: ISSUER, audience: ISSUER });
    if (typeof payload.sub !== "string" || typeof payload.name !== "string") return null;
    return { userId: payload.sub, name: payload.name };
  } catch {
    return null;
  }
}
