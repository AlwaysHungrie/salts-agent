import "server-only";
import { AgentError } from "./agent";

export const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Any thrown error as a JSON answer the page can show. */
export function failure(err: unknown): Response {
  if (err instanceof AgentError) return fail(err.message, err.status);
  console.error(err);
  return fail("Something went wrong. Try again.", 500);
}
