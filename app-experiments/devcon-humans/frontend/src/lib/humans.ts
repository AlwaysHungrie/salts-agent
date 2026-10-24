import "server-only";
import { AgentError } from "./agent";
import { Refusal } from "./http";
import type { MyProfile, Person } from "./people";
import { findHumansSecret } from "./provision";

/**
 * find-humans' HTTP API, reached as the user with their own secret (the one their agent
 * holds), so the pages show and save the same profile the agent edits.
 */

function apiUrl(path: string): string {
  const url = process.env.FIND_HUMANS_MCP_URL;
  if (!url) throw new AgentError("FIND_HUMANS_MCP_URL must be set.", 500);
  return url.replace(/\/mcp\/?$/, "") + path;
}

async function call<T>(userId: string, path: string, method = "GET"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      cache: "no-store",
      headers: { "X-Find-Humans-Secret": await findHumansSecret(userId) },
    });
  } catch (err) {
    if (err instanceof Refusal || err instanceof AgentError) throw err;
    throw new AgentError("Cannot reach find-humans.", 502);
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  const code = body.error?.code;
  if (code === "not_found") throw new Refusal("No one with that profile.", 404);
  if (code === "spend_limit_reached") throw new Refusal("You’ve reached today’s limit. Try again tomorrow.", 429);
  if (code === "rate_limited") throw new Refusal("Too many requests. Try again in a minute.", 429);
  throw new AgentError(`find-humans answered ${res.status} (${code ?? "no code"}).`, 502);
}

/** The user's entries and saved profile. */
export const myProfile = (userId: string) => call<MyProfile>(userId, "/api/me");

/** Write and publish the user's profile from their entries (one model call when they changed). */
export const saveMyProfile = (userId: string) => call<MyProfile>(userId, "/api/me/save", "POST");

/** Anyone's saved profile. */
export const person = (userId: string, personId: string) =>
  call<Person>(userId, `/api/people/${encodeURIComponent(personId)}`);
