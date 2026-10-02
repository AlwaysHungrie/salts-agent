import "server-only";
import { AgentError } from "./agent";

export const fail = (error: string, status: number) => Response.json({ error }, { status });

/** A refusal whose message is written for the user and safe to send as is. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Any thrown error as a JSON answer the page can show. Only the status reaches the
 * client, or a Refusal's message: the agent's own messages and anything internal are logged, never sent.
 */
export function failure(err: unknown): Response {
  if (err instanceof Refusal) return fail(err.message, err.status);
  console.error(err);
  if (err instanceof AgentError) return fail("The agent could not handle that. Try again.", 502);
  return fail("Something went wrong. Try again.", 500);
}
