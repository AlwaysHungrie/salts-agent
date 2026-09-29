import "server-only";
import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

/**
 * A Clerk JWT template name, when the instance needs one to put the user's address in
 * the token. Left unset, the default session token is used, which carries the primary
 * address on any instance configured to include it.
 */
const TEMPLATE = process.env.CLERK_JWT_TEMPLATE?.trim();

/**
 * What a server-to-Worker call carries, and who it says it is from.
 *
 * Two identities, and the browser decides which one this is by what it sent.
 *
 * **The ordinary one** is the Clerk session, read here on the server and forwarded as
 * a bearer token. The Worker verifies its signature against Clerk's published keys,
 * so the address it acts on is one Clerk vouched for — not one this app asserted, and
 * not one that could have been edited on the way. The token is the whole credential;
 * there is no shared secret in it and none in this app's environment any more.
 *
 * **The back door** is a browser that sent `x-api-secret` and `x-user-email` of its
 * own, which happens when someone has put the deployment secret in localStorage. Those
 * are passed straight through, and the Worker will treat the caller as that address
 * with no sign-in at all. This app deliberately does not check, mint, or hold the
 * secret — it only forwards what it was handed, so the secret lives in exactly one
 * browser and in the Worker, and nowhere in between.
 *
 * The two never mix. A request carrying the back-door pair is sent as that and only
 * that, because a call that carried both would leave which identity wins up to the
 * Worker's precedence rules rather than to the person who opened the browser.
 *
 * It lives apart from `lib/agent.ts` because that module is imported by client
 * components, and Clerk's server helpers may only be reached from the server.
 */
export async function agentHeaders(): Promise<Record<string, string>> {
  // `headers()` is the incoming request's, which is what makes this work without
  // every one of the twenty-odd route handlers having to thread a `Request` through.
  const incoming = await headers().catch(() => null);
  const secret = incoming?.get("x-api-secret")?.trim() ?? "";
  const email = incoming?.get("x-user-email")?.trim().toLowerCase() ?? "";
  if (secret && email) return { "x-api-secret": secret, "x-user-email": email };

  const session = await auth().catch(() => null);
  // Clerk hands back the session's current token from its own cache and only mints a
  // new one when the old one is close to expiring, so asking per call is cheap.
  const token = await session
    ?.getToken(TEMPLATE ? { template: TEMPLATE } : undefined)
    .catch(() => null);
  return token ? { authorization: `Bearer ${token}` } : {};
}
