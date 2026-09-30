export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-secret",
};

/** The owner's key to the admin routes. Identity comes only from a Clerk token. */
export const API_SECRET_HEADER = "x-api-secret";

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
