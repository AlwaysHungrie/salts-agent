import type { Env } from "../env";
import { readJson } from "../worker/http";
import { directory, readConfig, registry, writeConfig } from "../worker/stores";

/** Equal strings, compared in time that does not depend on where they first differ. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

/**
 * Repoint an agent's SearXNG URL using its SearXNG token as proof (the tunnel host has
 * no Clerk session). Agents without a token cannot be repointed. Only the URL changes.
 */
export async function handleSearxngUrl(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
  const offered = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!offered) return unauthorized();
  // Checked against the directory first, so a made-up id never seeds a store of its own.
  if (!(await directory(env).get(agentId))) return unauthorized();

  const reg = registry(env, agentId);
  const config = await readConfig(env, reg);
  const token = config.searxng_token.trim();
  if (!token || !(await sameSecret(offered, token))) return unauthorized();

  const body = await readJson<{ url?: unknown }>(request);
  let parsed: URL;
  try {
    parsed = new URL(String(body.url ?? ""));
  } catch {
    return Response.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Response.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });
  }
  const url = parsed.toString().replace(/\/+$/, "");
  await writeConfig(env, reg, { searxng_url: url });
  return Response.json({ searxng_url: url });
}
