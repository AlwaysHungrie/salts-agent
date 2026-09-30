import "server-only";
import { auth } from "@clerk/nextjs/server";

/**
 * A Clerk JWT template name, when the instance needs one to put the user's address in
 * the token. Left unset, the default session token is used, which carries the primary
 * address on any instance configured to include it.
 */
const TEMPLATE = process.env.CLERK_JWT_TEMPLATE?.trim();

/**
 * What a server-to-Worker call carries: the Clerk session, read here on the server and
 * forwarded as a bearer token. The Worker verifies its signature against Clerk's
 * published keys, so the address it acts on is one Clerk vouched for.
 *
 * It lives apart from `lib/agent.ts` because that module is imported by client
 * components, and Clerk's server helpers may only be reached from the server.
 */
export async function agentHeaders(): Promise<Record<string, string>> {
  const session = await auth().catch(() => null);
  // Clerk hands back the session's current token from its own cache and only mints a
  // new one when the old one is close to expiring, so asking per call is cheap.
  const token = await session
    ?.getToken(TEMPLATE ? { template: TEMPLATE } : undefined)
    .catch(() => null);
  return token ? { authorization: `Bearer ${token}` } : {};
}
