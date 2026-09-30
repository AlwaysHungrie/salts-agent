export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-secret, x-user-email",
};

/**
 * The headers a call can carry, and the two ways to be somebody here.
 *
 * `authorization` is the ordinary one: a Clerk session token, whose signature the
 * Worker verifies against Clerk's published keys. The address comes out of the
 * verified claims, so it is one Clerk vouched for rather than one the caller typed.
 * This is the only identity a normal user of the app ever has.
 *
 * `x-api-secret` + `x-user-email` is the other one, and it is a back door on purpose.
 * Present the deployment's `API_SECRET` and the Worker takes the address beside it at
 * face value — any address, with no sign-in and no proof — and treats the caller as
 * that person for the whole request. It exists so a holder of the secret can act as
 * anyone, which is a feature here rather than an accident. It is also why `API_SECRET`
 * is not an origin check but a master key: whoever has it has every identity in the
 * deployment. Leave it unset and the door is not there at all.
 */
export const API_SECRET_HEADER = "x-api-secret";
export const USER_EMAIL_HEADER = "x-user-email";

export function withCors(res: Response) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** A JSON answer with the CORS headers every browser-facing route needs. */
export function json(body: unknown, status = 200): Response {
  return withCors(Response.json(body, { status }));
}

/** `{ error }` with a status, the shape every refusal here takes. */
export function jsonError(message: string | undefined, status: number): Response {
  return json({ error: message }, status);
}

/** A request's JSON body, or `{}` when it has none or it does not parse. */
export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json().catch(() => ({}))) as T;
}

/** A list field that may arrive as an array or as one string separated by newlines, commas or semicolons. */
export function listEntries(input: string | string[] | undefined): string[] {
  return Array.isArray(input) ? input : (input ?? "").split(/[\n,;]/);
}

/** The message of anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 404, not 403: an agent you were not given is one that does not exist. */
export const notFound = () => jsonError("Agent not found.", 404);
