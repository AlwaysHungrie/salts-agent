import { sign } from "node:crypto";
import { TEST_CLERK_ISSUER, TEST_CLERK_KID, TEST_CLERK_PRIVATE_JWK } from "./clerk-key";

/**
 * A Clerk session token for `email`, signed by the suite's test issuer — the same proof
 * the Worker verifies in production. Synchronous (node:crypto under nodejs_compat) so
 * request helpers can stay plain objects.
 */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

export function clerkToken(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT", kid: TEST_CLERK_KID });
  const payload = encode({ iss: TEST_CLERK_ISSUER, sub: email, email, iat: now, exp: now + 3600 });
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  const signature = sign("sha256", signed, {
    key: TEST_CLERK_PRIVATE_JWK,
    format: "jwk",
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The `authorization` header a signed-in `email` sends. */
export function signedIn(email: string): { authorization: string } {
  return { authorization: `Bearer ${clerkToken(email)}` };
}
