import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";

/**
 * Turning a Clerk session token into an email address the Worker can act on.
 *
 * The Worker is a separate origin from the Next app and runs none of Clerk's server
 * SDK, so the only thing it can check for itself is the signature on the session
 * token. That is what this module does: fetch the issuer's public keys, verify the
 * token against them, and hand back the address in its claims. A forged identity
 * then needs Clerk's private key rather than a leaked environment variable.
 *
 * Two caches sit in front of all of it, because this runs on every message, every
 * stream frame and every thumbnail, and an isolate that re-fetched a key set or
 * re-checked a signature each time would spend more on authentication than on the
 * work being authenticated.
 */

const BEARER = /^bearer\s+(.+)$/i;

/** Where the token says it came from has to match what the deployment was told. */
function issuerOf(env: Env): string {
  return (env.CLERK_ISSUER ?? "").trim().replace(/\/+$/, "");
}

/**
 * One `createRemoteJWKSet` per issuer, kept for the life of the isolate.
 *
 * `jose` caches the fetched key set inside the object it returns and only goes back
 * to the network when a token names a key it has not seen — with a cooldown, so a
 * burst of tokens signed by an unknown key cannot turn into a burst of requests to
 * Clerk. All of that is per-object, which is exactly why the object is reused rather
 * than rebuilt per request: a fresh one per call would cache nothing at all.
 */
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(issuer: string) {
  let set = jwksByIssuer.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      // Re-fetching is allowed at most this often, however many unknown-key tokens
      // arrive. 30s is long enough to absorb a flood and short enough that a key
      // rotation is picked up without a deploy.
      cooldownDuration: 30_000,
      // Refresh the set in the background once it is this old, so a rotation does not
      // land as a burst of verification failures.
      cacheMaxAge: 10 * 60_000,
    });
    jwksByIssuer.set(issuer, set);
  }
  return set;
}

/**
 * Verified tokens, keyed by a hash of the token itself.
 *
 * A signature check is a public-key operation; the same short-lived token arrives
 * dozens of times over the seconds it is valid — once per poll, once per file, once
 * per stream reconnect — and checking it again each time buys nothing. The entry is
 * held only until the token's own `exp`, so this cache can never keep an identity
 * alive past the token that proved it.
 *
 * Failures are cached too, briefly. Without that, a client looping on a token the
 * issuer will never accept — a stale one, a wrong template, a truncated header —
 * turns every one of its retries into a key-set lookup.
 */
type Entry = { email: string; until: number };
const verified = new Map<string, Entry>();
const MAX_ENTRIES = 500;
/** How long a rejected token is remembered as rejected. */
const FAILURE_TTL = 30_000;

/** The token, hashed, so a bearer credential is never a key in memory. */
async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Drop what has expired, and if that was not enough, the oldest of what is left.
 *
 * `Map` iterates in insertion order, so the head is the least recently added — good
 * enough for a cache whose entries all expire within about a minute anyway.
 */
function prune(now: number) {
  for (const [key, entry] of verified) {
    if (entry.until <= now) verified.delete(key);
  }
  while (verified.size >= MAX_ENTRIES) {
    const oldest = verified.keys().next();
    if (oldest.done) break;
    verified.delete(oldest.value);
  }
}

/**
 * The address in a verified session token, or "" if there is not one.
 *
 * Clerk's default session token carries the user's primary address once the instance
 * is configured to include it; a JWT template may name it something else. All the
 * spellings anyone would reasonably use are read, so a deployment does not have to
 * match one exactly.
 */
function emailFrom(payload: JWTPayload): string {
  const claims = payload as Record<string, unknown>;
  for (const key of ["email", "primary_email_address", "email_address", "primaryEmailAddress"]) {
    const value = claims[key];
    if (typeof value === "string" && value.includes("@")) return value.trim().toLowerCase();
  }
  return "";
}

/**
 * The address Clerk vouched for on this request, or "" when the request carries no
 * usable token.
 *
 * "" is not an error the caller has to distinguish: an empty address matches no
 * access list, so a route that depends on this stays closed. It is the caller's job
 * to decide what happens next — see `callerEmail` in `server.ts`, which falls back to
 * the `x-user-email` header the frontend sends.
 */
export async function clerkEmail(request: Request, env: Env): Promise<string> {
  const issuer = issuerOf(env);
  if (!issuer) return "";

  const header = request.headers.get("authorization") ?? "";
  const token = BEARER.exec(header)?.[1]?.trim();
  if (!token) return "";

  const now = Date.now();
  const key = await tokenKey(token);
  const hit = verified.get(key);
  if (hit && hit.until > now) return hit.email;

  let email = "";
  let until = now + FAILURE_TTL;
  try {
    const { payload } = await jwtVerify(token, jwks(issuer), {
      issuer,
      // Clerk's own clocks and ours are not the same clock, and a token minted a
      // moment ago must not read as not-yet-valid.
      clockTolerance: 30,
    });
    email = emailFrom(payload);
    // Never past the token's own expiry, and never longer than the failure window,
    // so a revoked session cannot outlive the short life Clerk gave its token.
    if (email && payload.exp) until = Math.min(payload.exp * 1000, now + FAILURE_TTL);
    else if (email) until = now + FAILURE_TTL;
  } catch {
    // Verification failed — expired, wrong issuer, unknown key, malformed. Remembered
    // as a failure so a client retrying with it does not re-run the check each time.
    email = "";
  }

  prune(now);
  verified.set(key, { email, until });
  return email;
}
