import { clerkEmail } from "../clerk";
import type { Env } from "../env";
import { json, jsonError } from "../worker/http";
import { directory } from "../worker/stores";

/**
 * `/api/account`: the signed-in user's own account. Only a Salts session token reaches it
 * — never an agent API key or a trusted app's OAuth token — since deactivating is the one
 * thing an account cannot undo.
 *
 * - `GET` → `{ blockers }`: what must go before the account can be deactivated.
 * - `DELETE` → deactivate: clears the account's lists and its own rows (see
 *   registry/directory-deactivate.ts), or 409 with the blockers. Deleting the sign-in
 *   itself is the web app's step, after this succeeds.
 */
export async function handleAccount(
  request: Request,
  env: Env,
  segments: string[]
): Promise<Response | undefined> {
  if (segments[2]) return undefined;
  const email = await clerkEmail(request, env);
  if (!email) return jsonError("unauthorized", 401);
  const dir = directory(env);

  if (request.method === "GET") {
    return json({ blockers: await dir.deactivationBlockers(email) });
  }
  if (request.method === "DELETE") {
    const { blockers } = await dir.deactivateAccount(email);
    if (blockers.length) {
      return json({ error: "This account can't be deactivated yet.", blockers }, 409);
    }
    // Lists are their own object, keyed by the address; wiped after the directory says yes.
    await env.UserLists.get(env.UserLists.idFromName(email)).wipe();
    return json({ ok: true });
  }
  return jsonError("method not allowed", 405);
}
